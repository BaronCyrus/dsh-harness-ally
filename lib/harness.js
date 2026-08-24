import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { attachBridgeUsage, openModelBridgeRoute } from './bridge.js'
import { startCodexAppServerRun } from './codex-app-server.js'
import { startKimiAcpRun } from './kimi-acp.js'
import { pathsFromToolInput } from './work-ledger.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const DISPOSE_GRACE_MS = 3000
const CLAUDE_INVALID_RESUME = /No conversation found with session ID|--resume session load failed|Failed to resume session/i

function emitText(state, text) {
  if (typeof text !== 'string' || !text) return
  state.emittedText += text
  state.stream.push({ type: 'text-delta', text })
}

function emitReasoning(state, text) {
  if (typeof text !== 'string' || !text) return
  state.stream.push({ type: 'reasoning-delta', text })
}

function toolSummary(block) {
  const input = block?.input
  if (!input || typeof input !== 'object') return ''
  for (const key of ['description', 'command', 'query', 'pattern', 'file_path', 'path', 'url', 'prompt']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim()
  }
  return ''
}

function emitToolActivity(state, block) {
  if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !block.name) return
  const paths = pathsFromToolInput(block.input)
  const activity = {
    type: 'activity',
    id: typeof block.id === 'string' ? block.id : '',
    name: block.name,
    summary: toolSummary(block),
    ...(paths.length ? { paths } : {}),
  }
  if (activity.id) state.toolActivities.set(activity.id, activity)
  state.stream.push({ ...activity, status: 'running' })
}

function emitToolResultActivity(state, block) {
  if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return
  const activity = state.toolActivities.get(block.tool_use_id)
  if (!activity) return
  state.stream.push({ ...activity, status: block.is_error ? 'failed' : 'completed' })
}

const ADAPTERS = Object.freeze({
  'claude-code': {
    provider: 'ally-claude-code',
    command: 'claude',
    argv(executable, model, bridge, nativeSession) {
      return [
        executable,
        '-p',
        ...(bridge ? [
          '--bare',
          '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: bridge.claudeBaseUrl } }),
        ] : []),
        '--input-format', 'text',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...(nativeSession
          ? nativeSession.mode === 'resume'
            ? ['--resume', nativeSession.vendorId]
            : ['--session-id', randomUUID()]
          : ['--no-session-persistence']),
        '--permission-mode', 'bypassPermissions',
        ...(model ? ['--model', model] : []),
      ]
    },
    accept(event, state, nativeSession) {
      if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) {
        state.nativeInitSeen = true
        nativeSession?.adopt(event.session_id)
      }
      const parentToolUseId = event.parent_tool_use_id ?? event.parentToolUseId
      if (event.type === 'stream_event' && !parentToolUseId) {
        const nativeEvent = event.event
        if (nativeEvent?.type === 'message_start') state.currentMessageText = ''
        if (nativeEvent?.type === 'content_block_delta'
          && nativeEvent.delta?.type === 'text_delta'
          && typeof nativeEvent.delta.text === 'string') {
          state.currentMessageText += nativeEvent.delta.text
          emitText(state, nativeEvent.delta.text)
        }
        if (nativeEvent?.type === 'content_block_delta'
          && nativeEvent.delta?.type === 'thinking_delta') {
          emitReasoning(state, nativeEvent.delta.thinking)
        }
      }
      if (event.type === 'user' && !parentToolUseId && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) emitToolResultActivity(state, block)
      }
      if (event.type === 'assistant' && !parentToolUseId && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) emitToolActivity(state, block)
        const text = event.message.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text.startsWith(state.currentMessageText)) emitText(state, text.slice(state.currentMessageText.length))
        else if (!state.currentMessageText) emitText(state, text)
        state.currentMessageText = ''
        if (text) state.completedText += text
        if (state.completedText) state.text = state.completedText
      }
      if (event.type === 'result') {
        if (Array.isArray(event.errors) && event.errors.some((error) => typeof error === 'string' && CLAUDE_INVALID_RESUME.test(error))) {
          state.invalidResumeError = true
        }
        if (state.completedText) state.text = state.completedText
        else if (state.emittedText) state.text = state.emittedText
        else if (typeof event.result === 'string' && event.result) state.text = event.result
        if (event.is_error || (event.subtype && event.subtype !== 'success')) state.failed = true
      }
    },
  },
  codex: {
    provider: 'ally-codex',
    command: 'codex',
  },
  'kimi-code': {
    provider: 'ally-kimi-code',
    command: 'kimi',
  },
})

function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('Harness task must contain text')
  const texts = []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Harness task currently supports text blocks only')
    }
    texts.push(block.text)
  }
  const text = texts.join('\n')
  if (!text.trim()) throw new Error('Harness task must not be empty')
  return text
}

function parseLine(adapter, line, state, nativeSession) {
  if (!line.trim()) return
  try {
    adapter.accept(JSON.parse(line), state, nativeSession)
  } catch {
    state.protocolErrors += 1
  }
}

async function startProcessRun(deps, harness, request) {
  const { subprocess, sandbox, policyFor, authorize, bridge } = deps
  const adapter = ADAPTERS[harness]
  if (!adapter) throw new Error(`unknown Harness ${String(harness)}`)
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error(`${harness} delegation aborted before spawn`)
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error(`${harness} delegation requires a parent workspace`)
  const initialPrompt = request.nativeSession?.prompt ?? promptText(request.prompt)
  if (typeof initialPrompt !== 'string' || !initialPrompt.trim()) throw new Error('Harness task must not be empty')
  const policy = policyFor(session)
  const executable = deps.cliManager
    ? await deps.cliManager.resolve(harness)
    : await subprocess.resolveExecutable(adapter.command)
  const bridgeRoute = await openModelBridgeRoute(bridge, request, session.id)
  let managedHome
  if (request.nativeSession && typeof deps.stateDir === 'string') {
    managedHome = join(deps.stateDir, 'native', 'claude')
    await (deps.makeDirectory ?? mkdir)(managedHome, { recursive: true, mode: 0o700 })
  }
  const stream = createAsyncQueue()
  const state = {
    text: '',
    emittedText: '',
    completedText: '',
    currentMessageText: '',
    toolActivities: new Map(),
    stream,
    failed: false,
    protocolErrors: 0,
    nativeInitSeen: false,
    invalidResumeError: false,
  }
  let currentChild
  let disposing = false
  let routeClosed = false
  let disposal
  const closeRoute = () => {
    if (routeClosed) return
    routeClosed = true
    bridgeRoute?.close()
  }

  const spawnAttempt = () => {
    const nativeArgv = adapter.argv(executable, request.model, bridgeRoute, request.nativeSession)
    let argv = nativeArgv
    if (policy.mode !== 'danger-full-access') {
      const confined = sandbox.confine(nativeArgv, policy)
      if (confined.enforcement !== 'full') throw new Error(`${harness} requires a fully enforcing DSH sandbox`)
      argv = confined.argv
    }
    const env = {
      ...(bridgeRoute ? {
        ANTHROPIC_BASE_URL: bridgeRoute.claudeBaseUrl,
        ANTHROPIC_API_KEY: bridgeRoute.token,
        ANTHROPIC_AUTH_TOKEN: bridgeRoute.token,
      } : {}),
      ...(managedHome ? { CLAUDE_CONFIG_DIR: managedHome } : {}),
    }
    const child = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DISPOSE_GRACE_MS,
      signal,
      env,
    })
    currentChild = child
    state.nativeInitSeen = false
    state.invalidResumeError = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutBuffer = ''
    let stderrBuffer = ''
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += stdoutDecoder.write(chunk)
      if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES) {
        state.failed = true
        stdoutBuffer = ''
        child.terminate()
        return
      }
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        parseLine(adapter, line, state, request.nativeSession)
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (Buffer.byteLength(stderrBuffer) >= MAX_STDERR_BYTES) return
      stderrBuffer += stderrDecoder.write(chunk)
      if (Buffer.byteLength(stderrBuffer) > MAX_STDERR_BYTES) stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BYTES)
    })
    child.stdin?.on('error', () => {})
    const prompt = request.nativeSession?.prompt ?? initialPrompt
    child.stdin?.end(prompt)
    return Promise.resolve(child.done).then((outcome) => {
      stdoutBuffer += stdoutDecoder.end()
      stderrBuffer += stderrDecoder.end()
      if (stdoutBuffer.trim()) parseLine(adapter, stdoutBuffer, state, request.nativeSession)
      return { outcome, stderr: stderrBuffer }
    }, (error) => ({ error, stderr: stderrBuffer }))
  }

  let firstAttempt
  try {
    firstAttempt = spawnAttempt()
  } catch (error) {
    closeRoute()
    throw error
  }

  const result = (async () => {
    let attempt = await firstAttempt
    const invalidResume = request.nativeSession?.mode === 'resume'
      && !state.nativeInitSeen
      && !state.emittedText
      && !state.completedText
      && !attempt.error
      && attempt.outcome?.exitCode !== 0
      && (state.invalidResumeError || CLAUDE_INVALID_RESUME.test(attempt.stderr))
      && !signal.aborted
      && !disposing
    if (invalidResume) {
      await request.nativeSession.fallback()
      state.failed = false
      state.protocolErrors = 0
      attempt = await spawnAttempt()
    }
    if (signal.aborted || disposing) {
      return { output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }
    }
    if (attempt.error) return { output: [], stopReason: 'error', diagnostic: `${harness} 进程启动失败` }
    if (state.failed || attempt.outcome?.exitCode !== 0) {
      return {
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: 'error',
        diagnostic: `${harness} 执行失败（exit ${String(attempt.outcome?.exitCode)}）`,
      }
    }
    if (!state.text && state.protocolErrors > 0) {
      return { output: [], stopReason: 'error', diagnostic: `${harness} 返回了无法解析的响应` }
    }
    return { output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'completed' }
  })()
    .then((value) => attachBridgeUsage(bridgeRoute, value))
    .finally(() => {
      stream.end()
      closeRoute()
    })

  return {
    id: `${adapter.provider}-${randomUUID()}`,
    stream,
    result,
    dispose() {
      if (!disposal) disposal = (async () => {
        disposing = true
        closeRoute()
        currentChild?.terminate()
        if (currentChild) {
          await currentChild.waitForExit()
          await currentChild.done.catch(() => {})
        }
      })()
      return disposal
    },
  }
}

export function createHarnessGateway(deps) {
  function startAdapter(harness, request) {
    if (harness === 'codex') return startCodexAppServerRun(deps, request)
    if (harness === 'kimi-code') return startKimiAcpRun(deps, request)
    return startProcessRun(deps, harness, request)
  }

  function start(harness, request) {
    const session = request.parent?.session
    const cwd = session?.header?.cwd
    const incrementalPrompt = request.incrementalPrompt
    if (!deps.nativeSessions
      || typeof session?.id !== 'string'
      || typeof cwd !== 'string'
      || typeof request.provider !== 'string'
      || typeof request.model !== 'string'
      || typeof request.promptSignature !== 'string'
      || !Number.isSafeInteger(request.turn)
      || !Array.isArray(incrementalPrompt)) {
      return startAdapter(harness, request)
    }
    deps.authorize(session)
    const policy = deps.policyFor(session)
    return deps.nativeSessions.start({
      sessionId: session.id,
      harness,
      provider: request.provider,
      model: request.model,
      cwd,
      policyMode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      promptSignature: request.promptSignature,
      turn: request.turn,
      fullPrompt: promptText(request.prompt),
      incrementalPrompt: promptText(incrementalPrompt),
      conversation: request.conversation,
    }, (nativeSession) => startAdapter(harness, {
      ...request,
      prompt: [{ type: 'text', text: nativeSession.prompt }],
      nativeSession,
    }))
  }

  function provider(harness) {
    const adapter = ADAPTERS[harness]
    if (!adapter) throw new Error(`unknown Harness ${String(harness)}`)
    return {
      name: adapter.provider,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start(request) {
        return start(harness, request)
      },
    }
  }

  async function available(harness) {
    const adapter = ADAPTERS[harness]
    if (!adapter) return false
    try {
      if (deps.cliManager) await deps.cliManager.resolve(harness)
      else await deps.subprocess.resolveExecutable(adapter.command)
      return true
    } catch {
      return false
    }
  }

  return {
    provider,
    providers: Object.keys(ADAPTERS).map((harness) => provider(harness)),
    start,
    available,
    async availability() {
      const [claude, codex, kimi] = await Promise.all([
        available('claude-code'),
        available('codex'),
        available('kimi-code'),
      ])
      return { 'claude-code': claude, codex, 'kimi-code': kimi }
    },
  }
}
