import { randomUUID } from 'node:crypto'
import { mkdtemp as makeTempDirectory, rm as remove } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { ALLY_VERSION } from './version.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const DISPOSE_GRACE_MS = 3000
const CANCEL_GRACE_MS = 1000

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

function activityName(kind, title) {
  const names = {
    execute: 'Bash',
    edit: 'Edit',
    read: 'Read',
    fetch: 'WebSearch',
    search: 'Search',
    think: 'Think',
  }
  return names[kind] ?? (typeof title === 'string' && title.trim() ? title.trim() : 'Tool')
}

function inputSummary(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of ['description', 'command', 'query', 'pattern', 'file_path', 'path', 'url', 'prompt']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim()
  }
  return ''
}

function activityForUpdate(update) {
  if (!update || typeof update.toolCallId !== 'string' || !update.toolCallId) return undefined
  const title = typeof update.title === 'string' ? update.title.trim() : ''
  const name = activityName(update.kind, title)
  const input = inputSummary(update.rawInput)
  const summary = title && title !== name ? title : input
  return {
    type: 'activity',
    id: update.toolCallId,
    name,
    summary,
    status: update.status === 'completed' || update.status === 'failed' ? update.status : 'running',
  }
}

function bridgeEnvironment(route, request, home) {
  if (!route) return {
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
  }
  return {
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_CODE_HOME: home,
    KIMI_MODEL_NAME: request.model,
    KIMI_MODEL_DISPLAY_NAME: request.model,
    KIMI_MODEL_API_KEY: route.token,
    KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
    KIMI_MODEL_BASE_URL: route.claudeBaseUrl,
    KIMI_MODEL_CAPABILITIES: 'thinking',
    ...(request.reasoningEffort ? { KIMI_MODEL_THINKING_EFFORT: request.reasoningEffort } : {}),
  }
}

export async function startKimiAcpRun(deps, request) {
  const { subprocess, sandbox, policyFor, authorize, bridge, cliManager } = deps
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error('kimi-code delegation aborted before spawn')
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('kimi-code delegation requires a parent workspace')
  const prompt = promptText(request.prompt)
  const policy = policyFor(session)
  const executable = cliManager
    ? await cliManager.resolve('kimi-code')
    : await subprocess.resolveExecutable('kimi')
  const bridgeRoute = bridge && request.provider && request.model
    ? await bridge.open(request.provider, request.model, {
        reasoningEffort: request.reasoningEffort,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        stop: request.stop,
      })
    : undefined

  const createHome = deps.makeTempDirectory ?? makeTempDirectory
  const removeHome = deps.removeTempDirectory
    ?? ((path) => remove(path, { recursive: true, force: true }))
  let kimiHome
  let homeRemoved = false
  let routeClosed = false
  const closeRoute = () => {
    if (routeClosed) return
    routeClosed = true
    bridgeRoute?.close()
  }
  const cleanupHome = async () => {
    if (!kimiHome || homeRemoved) return
    homeRemoved = true
    await removeHome(kimiHome).catch(() => {})
  }

  let child
  try {
    if (bridgeRoute) kimiHome = await createHome(join(tmpdir(), 'dsh-ally-kimi-'))
    const nativeArgv = [executable, 'acp']
    let argv = nativeArgv
    if (policy.mode !== 'danger-full-access') {
      const confined = sandbox.confine(nativeArgv, policy)
      if (confined.enforcement !== 'full') throw new Error('kimi-code requires a fully enforcing DSH sandbox')
      argv = confined.argv
    }
    child = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DISPOSE_GRACE_MS,
      env: bridgeEnvironment(bridgeRoute, request, kimiHome),
    })
  } catch (error) {
    closeRoute()
    await cleanupHome()
    throw error
  }

  const stream = createAsyncQueue()
  const state = { text: '', stream, toolUpdates: new Map(), activitySnapshots: new Map(), protocolErrors: 0 }
  const pending = new Map()
  const decoder = new StringDecoder('utf8')
  let stdoutBuffer = ''
  let nextRequestId = 1
  let sessionId
  let phase = 'initialize'
  let settled = false
  let disposing = false
  let cancelTimer
  let abortListener
  let disposal
  let resolveResult
  const result = new Promise((resolve) => { resolveResult = resolve })

  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('kimi ACP closed'))
    pending.clear()
  }
  const settle = (value, terminate) => {
    if (settled) return
    settled = true
    if (cancelTimer) clearTimeout(cancelTimer)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    stream.end()
    rejectPending()
    closeRoute()
    resolveResult(value)
    if (terminate) child.terminate()
  }
  const writeMessage = (message) => {
    if (settled) return false
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    return true
  }
  const sendRequest = (method, params) => {
    if (settled) return Promise.reject(new Error('kimi ACP already settled'))
    const id = nextRequestId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    writeMessage({ id, method, params })
    return response
  }
  const sendNotification = (method, params) => writeMessage({ method, params })
  const cancel = () => {
    if (settled) return
    if (sessionId) {
      sendNotification('session/cancel', { sessionId })
      cancelTimer = setTimeout(() => child.terminate(), CANCEL_GRACE_MS)
    } else {
      child.terminate()
    }
  }

  const handleServerRequest = (message) => {
    if (message.method === 'session/request_permission') {
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const allowOnce = options.find((option) => option?.kind === 'allow_once')
      // Canonical tool approvals include allow_always; plan reviews and user
      // questions deliberately do not. DSH has already authorized and confined
      // this subprocess, so approve ordinary tools once but never guess an
      // interactive answer on the user's behalf.
      const offersCanonicalToolApproval = options.some((option) => option?.kind === 'allow_always')
      const outcome = offersCanonicalToolApproval && allowOnce?.optionId
        ? { outcome: 'selected', optionId: allowOnce.optionId }
        : { outcome: 'cancelled' }
      writeMessage({ id: message.id, result: { outcome } })
      return
    }
    writeMessage({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } })
  }

  const onUpdate = (params) => {
    if (!sessionId || params?.sessionId !== sessionId) return
    const update = params.update
    if (update?.sessionUpdate === 'agent_message_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      state.text += update.content.text
      state.stream.push({ type: 'text-delta', text: update.content.text })
      return
    }
    if (update?.sessionUpdate === 'agent_thought_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      state.stream.push({ type: 'reasoning-delta', text: update.content.text })
      return
    }
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return
      const merged = { ...(state.toolUpdates.get(update.toolCallId) ?? {}), ...update }
      state.toolUpdates.set(update.toolCallId, merged)
      const activity = activityForUpdate(merged)
      if (!activity) return
      const snapshot = `${activity.name}\u0000${activity.summary}\u0000${activity.status}`
      if (state.activitySnapshots.get(activity.id) === snapshot) return
      state.activitySnapshots.set(activity.id, snapshot)
      state.stream.push(activity)
    }
  }

  const onMessage = (message) => {
    const hasId = Number.isSafeInteger(message?.id) || (typeof message?.id === 'string' && Boolean(message.id))
    if (hasId && pending.has(message.id) && typeof message.method !== 'string') {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error('kimi ACP request failed'))
      else waiter.resolve(message.result)
      return
    }
    if (hasId && typeof message.method === 'string') {
      handleServerRequest(message)
      return
    }
    if (message?.method === 'session/update') onUpdate(message.params)
  }
  const parseLine = (line) => {
    if (!line.trim()) return
    try {
      onMessage(JSON.parse(line))
    } catch {
      state.protocolErrors += 1
    }
  }
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += decoder.write(chunk)
    if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES) {
      settle({ output: [], stopReason: 'error', diagnostic: 'Kimi Code ACP 返回了过大的响应' }, true)
      return
    }
    let newline
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      parseLine(line)
    }
  })
  child.stderr?.on('data', () => {})
  child.stdin?.on('error', () => {})

  abortListener = cancel
  signal.addEventListener('abort', abortListener, { once: true })
  if (signal.aborted) cancel()

  const cleanup = child.done.then(cleanupHome, cleanupHome)
  child.done.then((outcome) => {
    stdoutBuffer += decoder.end()
    if (stdoutBuffer.trim()) parseLine(stdoutBuffer)
    if (settled) return
    if (signal.aborted || disposing) {
      settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
    } else {
      settle({
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: 'error',
        diagnostic: `Kimi Code ACP 提前退出（exit ${String(outcome.exitCode)}）`,
      }, false)
    }
  }, () => {
    settle({
      output: state.text ? [{ type: 'text', text: state.text }] : [],
      stopReason: signal.aborted || disposing ? 'aborted' : 'error',
      ...(signal.aborted || disposing ? {} : { diagnostic: 'Kimi Code ACP 进程启动失败' }),
    }, false)
  })

  void (async () => {
    try {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'dsh-ally', version: ALLY_VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      phase = 'session'
      const created = await sendRequest('session/new', { cwd, mcpServers: [] })
      sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Kimi ACP returned no session id')
      const modeOption = Array.isArray(created.configOptions)
        ? created.configOptions.find((option) => option?.id === 'mode')
        : undefined
      const supportsAuto = Array.isArray(modeOption?.options)
        && modeOption.options.some((option) => option?.value === 'auto')
      if (supportsAuto) {
        phase = 'mode'
        await sendRequest('session/set_config_option', { sessionId, configId: 'mode', value: 'auto' })
      }
      phase = 'prompt'
      const response = await sendRequest('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      const output = state.text ? [{ type: 'text', text: state.text }] : []
      if (response?.stopReason === 'end_turn') {
        settle({ output, stopReason: 'completed' }, true)
      } else if (response?.stopReason === 'cancelled' || signal.aborted || disposing) {
        settle({ output, stopReason: 'aborted' }, true)
      } else {
        settle({ output, stopReason: 'error', diagnostic: 'Kimi Code ACP 执行失败' }, true)
      }
    } catch {
      const diagnostics = {
        initialize: 'Kimi Code ACP 握手失败',
        session: 'Kimi Code ACP 会话创建失败',
        mode: 'Kimi Code ACP 自动模式设置失败',
        prompt: 'Kimi Code ACP 回合失败',
      }
      settle({
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: signal.aborted || disposing ? 'aborted' : 'error',
        ...(signal.aborted || disposing ? {} : { diagnostic: diagnostics[phase] ?? 'Kimi Code ACP 执行失败' }),
      }, true)
    }
  })()

  return {
    id: `ally-kimi-code-${randomUUID()}`,
    stream,
    result,
    dispose() {
      if (!disposal) disposal = (async () => {
        disposing = true
        if (!settled) cancel()
        await child.waitForExit()
        await Promise.allSettled([child.done, cleanup])
        if (!settled) settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
      })()
      return disposal
    },
  }
}
