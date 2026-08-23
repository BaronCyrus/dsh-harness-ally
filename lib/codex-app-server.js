import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { attachBridgeUsage, openModelBridgeRoute } from './bridge.js'
import { ALLY_VERSION } from './version.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const DISPOSE_GRACE_MS = 3000
const CODEX_CAPABILITY_MODEL = 'gpt-5.6'

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

function emitText(state, text) {
  if (typeof text !== 'string' || !text) return
  state.text += text
  state.stream.push({ type: 'text-delta', text })
}

function itemState(state, itemId) {
  let item = state.items.get(itemId)
  if (!item) {
    item = { emitted: '', deltaText: '', snapshotText: undefined }
    state.items.set(itemId, item)
  }
  return item
}

function reconcileItem(state, item) {
  const delta = item.deltaText
  const snapshot = item.snapshotText
  let candidate
  if (snapshot === undefined) candidate = delta
  else if (!delta) candidate = snapshot
  else if (delta.startsWith(snapshot)) candidate = delta
  else if (snapshot.startsWith(delta)) candidate = snapshot
  else if (delta.startsWith(item.emitted)) candidate = delta
  else if (snapshot.startsWith(item.emitted)) candidate = snapshot
  if (candidate === undefined || !candidate.startsWith(item.emitted)) return
  const tail = candidate.slice(item.emitted.length)
  item.emitted = candidate
  emitText(state, tail)
}

function calibratedText(state) {
  const text = [...state.items.values()]
    .map((item) => item.snapshotText ?? item.emitted)
    .join('')
  return text || state.text
}

function activityForItem(item, status) {
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return undefined
  let name
  let summary = ''
  if (item.type === 'commandExecution') {
    name = 'Bash'
    if (typeof item.command === 'string') summary = item.command
  } else if (item.type === 'fileChange') {
    name = 'Edit'
    if (Array.isArray(item.changes)) {
      summary = item.changes
        .map((change) => typeof change?.path === 'string' ? change.path : '')
        .filter(Boolean)
        .join(', ')
    }
  } else if (item.type === 'webSearch') {
    name = 'WebSearch'
    if (typeof item.query === 'string') summary = item.query
  } else if (item.type === 'mcpToolCall') {
    name = 'MCP'
    summary = [item.server, item.tool].filter((part) => typeof part === 'string' && part).join(' · ')
  } else if (item.type === 'dynamicToolCall') {
    name = typeof item.tool === 'string' && item.tool ? item.tool : 'Tool'
    if (typeof item.namespace === 'string') summary = item.namespace
  } else if (item.type === 'collabAgentToolCall') {
    name = 'Agent'
    if (typeof item.tool === 'string') summary = item.tool
  } else if (item.type === 'imageView') {
    name = 'Read'
    if (typeof item.path === 'string') summary = item.path
  } else if (item.type === 'imageGeneration') {
    name = 'Image'
  } else {
    return undefined
  }
  return { type: 'activity', id: item.id, name, summary, status }
}

function appServerArgv(executable, bridge) {
  return [
    executable,
    'app-server',
    ...(bridge ? [
      '-c', 'model_provider="dsh-ally"',
      '-c', 'model_providers.dsh-ally.name="DSH Alliance"',
      '-c', `model_providers.dsh-ally.base_url="${bridge.codexBaseUrl}"`,
      '-c', 'model_providers.dsh-ally.env_key="DSH_ALLY_TOKEN"',
      '-c', 'model_providers.dsh-ally.wire_api="responses"',
    ] : []),
  ]
}

export async function startCodexAppServerRun(deps, request) {
  const { subprocess, sandbox, policyFor, authorize, bridge, cliManager } = deps
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error('codex delegation aborted before spawn')
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('codex delegation requires a parent workspace')
  const prompt = promptText(request.prompt)
  const policy = policyFor(session)
  const executable = cliManager
    ? await cliManager.resolve('codex')
    : await subprocess.resolveExecutable('codex')
  const bridgeRoute = await openModelBridgeRoute(bridge, request, session.id)
  // Codex derives its native tool catalog from a known model family. Keep that
  // capability identity local while the bridge still routes the user's exact DSH model.
  const capabilityModel = bridgeRoute ? CODEX_CAPABILITY_MODEL : request.model
  const nativeArgv = appServerArgv(executable, bridgeRoute)
  let argv = nativeArgv
  let child
  try {
    if (policy.mode !== 'danger-full-access') {
      const confined = sandbox.confine(nativeArgv, policy)
      if (confined.enforcement !== 'full') throw new Error('codex requires a fully enforcing DSH sandbox')
      argv = confined.argv
    }
    child = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DISPOSE_GRACE_MS,
      env: bridgeRoute ? { DSH_ALLY_TOKEN: bridgeRoute.token } : {},
    })
  } catch (error) {
    bridgeRoute?.close()
    throw error
  }

  const stream = createAsyncQueue()
  const state = { text: '', items: new Map(), activityIds: new Set(), stream, protocolErrors: 0 }
  const pending = new Map()
  const stdoutDecoder = new StringDecoder('utf8')
  let stdoutBuffer = ''
  let nextRequestId = 1
  let threadId
  let turnId
  let settled = false
  let disposing = false
  let abortTimer
  let abortListener
  let disposal
  let resolveResult
  const result = new Promise((resolve) => { resolveResult = resolve })

  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('codex app-server closed'))
    pending.clear()
  }
  const settle = (value, terminate) => {
    if (settled) return
    settled = true
    if (abortTimer) clearTimeout(abortTimer)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    stream.end()
    rejectPending()
    bridgeRoute?.close()
    resolveResult(attachBridgeUsage(bridgeRoute, value))
    if (terminate) child.terminate()
  }
  const sendRequest = (method, params) => {
    if (settled) return Promise.reject(new Error('codex app-server already settled'))
    const id = nextRequestId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return response
  }
  abortListener = () => {
    if (settled) return
    if (threadId && turnId) {
      void sendRequest('turn/interrupt', { threadId, turnId }).catch(() => {})
      abortTimer = setTimeout(() => child.terminate(), 300)
    } else {
      child.terminate()
    }
  }
  signal.addEventListener('abort', abortListener, { once: true })
  if (signal.aborted) abortListener()

  const onMessage = (message) => {
    if (Number.isSafeInteger(message?.id) && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error('codex app-server request failed'))
      else waiter.resolve(message.result)
      return
    }
    if (Number.isSafeInteger(message?.id) && typeof message.method === 'string') {
      const response = message.method.endsWith('/requestApproval')
        ? { id: message.id, result: { decision: 'decline' } }
        : { id: message.id, error: { code: -32601, message: 'Unsupported server request' } }
      child.stdin.write(`${JSON.stringify(response)}\n`)
      return
    }
    const method = message?.method
    const params = message?.params
    if (method === 'item/reasoning/summaryTextDelta'
      && params?.threadId === threadId
      && (!turnId || params.turnId === turnId)
      && typeof params.delta === 'string'
      && params.delta) {
      state.stream.push({ type: 'reasoning-delta', text: params.delta })
      return
    }
    if ((method === 'item/started' || method === 'item/updated' || method === 'item/completed')
      && params?.threadId === threadId
      && (!turnId || params.turnId === turnId)) {
      const status = method === 'item/completed' ? 'completed' : 'running'
      const activity = activityForItem(params.item, status)
      if (activity && !state.activityIds.has(activity.id)) {
        state.activityIds.add(activity.id)
        state.stream.push(activity)
        return
      }
    }
    if (method === 'item/agentMessage/delta'
      && params?.threadId === threadId
      && typeof params.itemId === 'string'
      && typeof params.delta === 'string') {
      const item = itemState(state, params.itemId)
      item.deltaText += params.delta
      reconcileItem(state, item)
      return
    }
    if ((method === 'item/updated' || method === 'item/completed')
      && params?.threadId === threadId
      && params.item?.type === 'agentMessage'
      && typeof params.item.id === 'string'
      && typeof params.item.text === 'string') {
      const item = itemState(state, params.item.id)
      item.snapshotText = params.item.text
      reconcileItem(state, item)
      return
    }
    if (method === 'turn/completed' && params?.threadId === threadId
      && (!turnId || params.turn?.id === turnId)) {
      const status = params.turn?.status
      const text = calibratedText(state)
      if (status === 'completed') {
        settle({ output: text ? [{ type: 'text', text }] : [], stopReason: 'completed' }, true)
      } else if (status === 'interrupted' || signal.aborted || disposing) {
        settle({ output: text ? [{ type: 'text', text }] : [], stopReason: 'aborted' }, true)
      } else {
        settle({
          output: text ? [{ type: 'text', text }] : [],
          stopReason: 'error',
          diagnostic: 'codex app-server 执行失败',
        }, true)
      }
    }
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
    stdoutBuffer += stdoutDecoder.write(chunk)
    if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES) {
      settle({ output: [], stopReason: 'error', diagnostic: 'codex app-server 返回了过大的响应' }, true)
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

  child.done.then((outcome) => {
    stdoutBuffer += stdoutDecoder.end()
    if (stdoutBuffer.trim()) parseLine(stdoutBuffer)
    if (settled) return
    if (signal.aborted || disposing) {
      settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
    } else {
      settle({
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: 'error',
        diagnostic: `codex app-server 提前退出（exit ${String(outcome.exitCode)}）`,
      }, false)
    }
  }, () => {
    settle({
      output: state.text ? [{ type: 'text', text: state.text }] : [],
      stopReason: signal.aborted || disposing ? 'aborted' : 'error',
      ...(signal.aborted || disposing ? {} : { diagnostic: 'codex app-server 进程启动失败' }),
    }, false)
  })

  void (async () => {
    try {
      await sendRequest('initialize', {
        clientInfo: { name: 'dsh-ally', version: ALLY_VERSION },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            'item/plan/delta',
            'item/commandExecution/outputDelta',
            'item/fileChange/outputDelta',
          ],
        },
      })
      const thread = await sendRequest('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
        ...(capabilityModel ? { model: capabilityModel } : {}),
        ...(bridgeRoute ? { modelProvider: 'dsh-ally' } : {}),
      })
      threadId = thread?.thread?.id
      if (typeof threadId !== 'string' || !threadId) throw new Error('codex app-server returned no thread id')
      const turn = await sendRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'auto',
        ...(capabilityModel ? { model: capabilityModel } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      })
      turnId = turn?.turn?.id
      if (typeof turnId !== 'string' || !turnId) throw new Error('codex app-server returned no turn id')
    } catch {
      settle({ output: [], stopReason: signal.aborted || disposing ? 'aborted' : 'error', diagnostic: 'codex app-server 初始化失败' }, true)
    }
  })()

  return {
    id: `ally-codex-${randomUUID()}`,
    stream,
    result,
    dispose() {
      if (!disposal) disposal = (async () => {
        disposing = true
        if (!settled) child.terminate()
        await child.waitForExit()
        await child.done
        if (!settled) settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
      })()
      return disposal
    },
  }
}
