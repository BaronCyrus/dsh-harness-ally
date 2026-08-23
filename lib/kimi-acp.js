import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp as makeTempDirectory, rm as remove } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { attachBridgeUsage, openModelBridgeRoute } from './bridge.js'
import { ALLY_VERSION } from './version.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const DISPOSE_GRACE_MS = 3000
const CANCEL_GRACE_MS = 1000
const SKILL_CANCEL_GRACE_MS = 5000
const SKILL_CONTINUATION_IDLE_TIMEOUT_MS = 30_000
const SKILL_RECOVERY_PROMPT = 'Continue the previous task using the Skill instructions that were just loaded. Provide the requested answer now; do not only announce the Skill invocation.'
const KIMI_COMPLETION_MARKER = '␞'
const KIMI_FINALIZATION_PROMPT = `Provide the complete final answer requested by the user now. Do not merely announce more inspection. Do not use more tools unless the answer is impossible without them. End the complete answer with the exact marker ${KIMI_COMPLETION_MARKER}`
const KIMI_REPOSITORY_SKILL_POLICY = [
  'KIMI CODE REPOSITORY SKILL POLICY',
  'Do not invoke the native Skill tool.',
  'When the task requests a named repository Skill, use native Read or Bash tools to open `.agents/skills/<skill-name>/SKILL.md`, follow its instructions, and complete the task. Treat this direct read as the Skill invocation.',
  `End every complete final answer with the exact marker ${KIMI_COMPLETION_MARKER}. Never emit that marker before the final answer is complete.`,
].join('\n')

function freshSkillRecoveryPrompt(originalPrompt, skillName) {
  const skillPath = skillName ? `.agents/skills/${skillName}/SKILL.md` : '.agents/skills/<requested-skill>/SKILL.md'
  return [
    originalPrompt,
    'RECOVERY INSTRUCTION',
    'The previous Kimi session loaded the requested Skill, but its model continuation stalled.',
    `Start fresh. Do not invoke the Skill tool again. Read ${skillPath} with your native workspace tools, follow those instructions, and complete the original task now.`,
  ].join('\n\n')
}

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
  const skillContinuationIdleTimeoutMs = Number.isFinite(deps.skillContinuationTimeoutMs)
    ? deps.skillContinuationTimeoutMs
    : SKILL_CONTINUATION_IDLE_TIMEOUT_MS
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error('kimi-code delegation aborted before spawn')
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('kimi-code delegation requires a parent workspace')
  let originalPrompt = request.nativeSession?.prompt ?? promptText(request.prompt)
  if (typeof originalPrompt !== 'string' || !originalPrompt.trim()) throw new Error('Harness task must not be empty')
  let prompt = `${originalPrompt}\n\n${KIMI_REPOSITORY_SKILL_POLICY}`
  const policy = policyFor(session)
  const executable = cliManager
    ? await cliManager.resolve('kimi-code')
    : await subprocess.resolveExecutable('kimi')
  const bridgeRoute = await openModelBridgeRoute(bridge, request, session.id)

  const createHome = deps.makeTempDirectory ?? makeTempDirectory
  const removeHome = deps.removeTempDirectory
    ?? ((path) => remove(path, { recursive: true, force: true }))
  let kimiHome
  let persistentHome = false
  let homeRemoved = false
  let routeClosed = false
  const closeRoute = () => {
    if (routeClosed) return
    routeClosed = true
    bridgeRoute?.close()
  }
  const cleanupHome = async () => {
    if (!kimiHome || persistentHome || homeRemoved) return
    homeRemoved = true
    await removeHome(kimiHome).catch(() => {})
  }

  let child
  try {
    if (bridgeRoute && request.nativeSession && typeof deps.stateDir === 'string') {
      kimiHome = join(deps.stateDir, 'native', 'kimi')
      await (deps.makeDirectory ?? mkdir)(kimiHome, { recursive: true, mode: 0o700 })
      persistentHome = true
    } else if (bridgeRoute) {
      kimiHome = await createHome(join(tmpdir(), 'dsh-ally-kimi-'))
    }
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
  const state = {
    text: '',
    stream,
    toolUpdates: new Map(),
    activitySnapshots: new Map(),
    protocolErrors: 0,
    skillContinuationPending: false,
    skillContinuationTimedOut: false,
    skillAnswerObserved: false,
    skillWatchdogEnabled: false,
    skillRecoveryAttempts: 0,
    lastSkillName: undefined,
    freshSkillRecoverySafe: true,
    freshSkillRecoveryActive: false,
    nonSkillToolObserved: false,
    completionMarkerTerminal: false,
    finalizationAttempts: 0,
    finalizationFailed: false,
  }
  const pending = new Map()
  const decoder = new StringDecoder('utf8')
  let stdoutBuffer = ''
  let nextRequestId = 1
  let sessionId
  const noteSession = (value) => {
    sessionId = value
    if (typeof value === 'string' && value) request.nativeSession?.adopt(value)
  }
  let phase = 'initialize'
  let settled = false
  let disposing = false
  let gracefulExitRequested = false
  let cancelTimer
  let skillContinuationTimer
  let skillCancelTimer
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
    if (skillContinuationTimer) clearTimeout(skillContinuationTimer)
    if (skillCancelTimer) clearTimeout(skillCancelTimer)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    stream.end()
    rejectPending()
    closeRoute()
    resolveResult(attachBridgeUsage(bridgeRoute, value))
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
  const clearSkillContinuationTimer = () => {
    if (!skillContinuationTimer) return
    clearTimeout(skillContinuationTimer)
    skillContinuationTimer = undefined
  }
  const armSkillContinuationTimer = () => {
    clearSkillContinuationTimer()
    if (!state.skillContinuationPending || !state.skillWatchdogEnabled || state.skillContinuationTimedOut || settled) return
    skillContinuationTimer = setTimeout(() => {
      skillContinuationTimer = undefined
      if (!state.skillContinuationPending || !state.skillWatchdogEnabled || settled || !sessionId) return
      state.skillContinuationTimedOut = true
      state.stream.push({ type: 'reasoning-delta', text: 'Kimi Code · Skill 后续响应超时，正在恢复' })
      sendNotification('session/cancel', { sessionId })
      skillCancelTimer = setTimeout(() => {
        skillCancelTimer = undefined
        settle({
          output: state.text ? [{ type: 'text', text: state.text }] : [],
          stopReason: 'error',
          diagnostic: 'Kimi Code Skill 后续响应超时，取消失败',
        }, true)
      }, SKILL_CANCEL_GRACE_MS)
    }, skillContinuationIdleTimeoutMs)
  }
  const touchSkillContinuation = () => {
    if (!state.skillContinuationPending || !state.skillWatchdogEnabled || state.skillContinuationTimedOut) return
    armSkillContinuationTimer()
  }
  const observeSkillAnswer = () => {
    if (!state.skillContinuationPending) return
    state.skillAnswerObserved = true
    touchSkillContinuation()
  }
  const acceptSkillContinuation = (response) => {
    if (response?.stopReason !== 'end_turn' || !state.skillContinuationPending || !state.skillAnswerObserved) return false
    state.skillContinuationPending = false
    state.skillContinuationTimedOut = false
    state.skillWatchdogEnabled = false
    state.freshSkillRecoveryActive = false
    clearSkillContinuationTimer()
    return true
  }
  const cancel = () => {
    if (settled) return
    state.skillContinuationPending = false
    state.skillAnswerObserved = false
    state.skillWatchdogEnabled = false
    state.freshSkillRecoveryActive = false
    clearSkillContinuationTimer()
    if (skillCancelTimer) {
      clearTimeout(skillCancelTimer)
      skillCancelTimer = undefined
    }
    if (sessionId) {
      sendNotification('session/cancel', { sessionId })
      cancelTimer = setTimeout(() => child.terminate(), CANCEL_GRACE_MS)
    } else {
      child.terminate()
    }
  }

  const handleServerRequest = (message) => {
    if (message.method === 'session/request_permission') {
      if (phase === 'session-load' || !sessionId || message.params?.sessionId !== sessionId) {
        writeMessage({ id: message.id, result: { outcome: { outcome: 'cancelled' } } })
        return
      }
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
    if (phase === 'session-load' || !sessionId || params?.sessionId !== sessionId) return
    const update = params.update
    if (update?.sessionUpdate === 'agent_message_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      const markerIndex = update.content.text.lastIndexOf(KIMI_COMPLETION_MARKER)
      const markerObserved = markerIndex >= 0
      const visibleText = update.content.text.split(KIMI_COMPLETION_MARKER).join('')
      if (markerObserved) {
        const trailingText = update.content.text.slice(markerIndex + KIMI_COMPLETION_MARKER.length)
        state.completionMarkerTerminal = !trailingText.trim()
      } else if (visibleText.trim()) {
        state.completionMarkerTerminal = false
      }
      if (visibleText) {
        observeSkillAnswer()
        state.text += visibleText
        state.stream.push({ type: 'text-delta', text: visibleText })
      }
      return
    }
    if (update?.sessionUpdate === 'agent_thought_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      state.completionMarkerTerminal = false
      touchSkillContinuation()
      state.stream.push({ type: 'reasoning-delta', text: update.content.text })
      return
    }
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return
      state.completionMarkerTerminal = false
      const merged = { ...(state.toolUpdates.get(update.toolCallId) ?? {}), ...update }
      state.toolUpdates.set(update.toolCallId, merged)
      const activity = activityForUpdate(merged)
      if (!activity) return
      const isSkillActivity = activity.name === 'Skill'
        || (typeof merged.rawInput?.skill === 'string' && Boolean(merged.rawInput.skill.trim()))
      if (isSkillActivity && activity.status === 'completed') {
        const skillName = typeof merged.rawInput?.skill === 'string' ? merged.rawInput.skill.trim() : ''
        if (/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(skillName)) state.lastSkillName = skillName
        state.skillContinuationPending = true
        state.skillContinuationTimedOut = false
        state.skillAnswerObserved = false
        state.skillWatchdogEnabled = true
        armSkillContinuationTimer()
      } else {
        if (!isSkillActivity) {
          state.freshSkillRecoverySafe = false
          state.nonSkillToolObserved = true
        }
        if (!isSkillActivity && activity.status === 'completed' && state.freshSkillRecoveryActive) {
          state.freshSkillRecoveryActive = false
          state.skillWatchdogEnabled = false
          state.skillContinuationTimedOut = false
          clearSkillContinuationTimer()
        } else {
          touchSkillContinuation()
        }
      }
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
      const initialized = await sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'dsh-ally', version: ALLY_VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      phase = 'session'
      const nativeSession = request.nativeSession
      const canResume = initialized?.agentCapabilities?.loadSession === true
      let created
      if (nativeSession?.mode === 'resume' && canResume) {
        try {
          phase = 'session-load'
          sessionId = nativeSession.vendorId
          created = await sendRequest('session/load', {
            sessionId: nativeSession.vendorId,
            cwd,
            mcpServers: [],
          })
          noteSession(created?.sessionId ?? nativeSession.vendorId)
        } catch (error) {
          if (signal.aborted || disposing) throw error
          await nativeSession.fallback()
          originalPrompt = nativeSession.prompt
          prompt = `${originalPrompt}\n\n${KIMI_REPOSITORY_SKILL_POLICY}`
        }
      } else if (nativeSession?.mode === 'resume') {
        await nativeSession.fallback()
        originalPrompt = nativeSession.prompt
        prompt = `${originalPrompt}\n\n${KIMI_REPOSITORY_SKILL_POLICY}`
      }
      if (!created) {
        created = await sendRequest('session/new', { cwd, mcpServers: [] })
        noteSession(created?.sessionId)
      }
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
      let response = await sendRequest('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      if (skillCancelTimer) {
        clearTimeout(skillCancelTimer)
        skillCancelTimer = undefined
      }
      acceptSkillContinuation(response)
      const recoverableSkillStop = state.skillContinuationPending
        && (state.skillContinuationTimedOut || response?.stopReason === 'end_turn')
      if (recoverableSkillStop && state.skillRecoveryAttempts === 0 && !signal.aborted && !disposing) {
        const recoveredFromTimeout = state.skillContinuationTimedOut
        if (!recoveredFromTimeout) {
          state.stream.push({ type: 'reasoning-delta', text: 'Kimi Code · Skill 后续响应缺失，正在恢复' })
        }
        state.skillRecoveryAttempts += 1
        let recoveryPrompt = SKILL_RECOVERY_PROMPT
        let startedFreshRecovery = false
        if (recoveredFromTimeout && state.freshSkillRecoverySafe) {
          state.skillContinuationPending = false
          if (nativeSession?.mode === 'resume') await nativeSession.fallback()
          sessionId = undefined
          phase = 'skill-recovery-session'
          const recovered = await sendRequest('session/new', { cwd, mcpServers: [] })
          if (signal.aborted || disposing || settled) throw new Error('Kimi Skill recovery aborted')
          noteSession(recovered?.sessionId)
          if (typeof sessionId !== 'string' || !sessionId) throw new Error('Kimi ACP recovery returned no session id')
          const recoveryMode = Array.isArray(recovered.configOptions)
            ? recovered.configOptions.find((option) => option?.id === 'mode')
            : undefined
          const recoverySupportsAuto = Array.isArray(recoveryMode?.options)
            && recoveryMode.options.some((option) => option?.value === 'auto')
          if (recoverySupportsAuto) {
            await sendRequest('session/set_config_option', { sessionId, configId: 'mode', value: 'auto' })
          }
          if (signal.aborted || disposing || settled) throw new Error('Kimi Skill recovery aborted')
          state.toolUpdates.clear()
          state.activitySnapshots.clear()
          const recoveryBasePrompt = nativeSession?.prompt
            ? `${nativeSession.prompt}\n\n${KIMI_REPOSITORY_SKILL_POLICY}`
            : prompt
          recoveryPrompt = freshSkillRecoveryPrompt(recoveryBasePrompt, state.lastSkillName)
          startedFreshRecovery = true
        }
        if (signal.aborted || disposing || settled) throw new Error('Kimi Skill recovery aborted')
        state.skillContinuationTimedOut = false
        state.skillContinuationPending = true
        state.skillAnswerObserved = false
        state.skillWatchdogEnabled = true
        state.freshSkillRecoveryActive = startedFreshRecovery
        state.completionMarkerTerminal = false
        armSkillContinuationTimer()
        phase = 'skill-recovery'
        response = await sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: recoveryPrompt }],
        })
        if (skillCancelTimer) {
          clearTimeout(skillCancelTimer)
          skillCancelTimer = undefined
        }
        acceptSkillContinuation(response)
      }
      if (response?.stopReason === 'end_turn'
        && !state.skillContinuationPending
        && state.nonSkillToolObserved
        && !state.completionMarkerTerminal
        && state.finalizationAttempts === 0
        && !signal.aborted
        && !disposing) {
        state.finalizationAttempts += 1
        state.stream.push({ type: 'reasoning-delta', text: 'Kimi Code · 正在整理最终回答' })
        const textLengthBeforeFinalization = state.text.length
        state.completionMarkerTerminal = false
        phase = 'finalization'
        response = await sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: KIMI_FINALIZATION_PROMPT }],
        })
        const finalizationText = state.text.slice(textLengthBeforeFinalization)
        state.finalizationFailed = response?.stopReason !== 'end_turn'
          || !state.completionMarkerTerminal
          || !finalizationText.trim()
      }
      const output = state.text ? [{ type: 'text', text: state.text }] : []
      if ((response?.stopReason === 'cancelled' && !state.skillContinuationTimedOut) || signal.aborted || disposing) {
        settle({ output, stopReason: 'aborted' }, true)
      } else if (state.skillContinuationPending) {
        settle({ output, stopReason: 'error', diagnostic: 'Kimi Code Skill 后续响应超时或缺失' }, true)
      } else if (state.finalizationFailed) {
        settle({ output, stopReason: 'error', diagnostic: 'Kimi Code 最终回答缺失' }, true)
      } else if (response?.stopReason === 'end_turn') {
        gracefulExitRequested = true
        child.stdin?.end()
        settle({ output, stopReason: 'completed' }, false)
      } else {
        settle({ output, stopReason: 'error', diagnostic: 'Kimi Code ACP 执行失败' }, true)
      }
    } catch {
      const diagnostics = {
        initialize: 'Kimi Code ACP 握手失败',
        session: 'Kimi Code ACP 会话创建失败',
        mode: 'Kimi Code ACP 自动模式设置失败',
        prompt: 'Kimi Code ACP 回合失败',
        'skill-recovery-session': 'Kimi Code Skill 恢复会话创建失败',
        'skill-recovery': 'Kimi Code Skill 后续恢复失败',
        finalization: 'Kimi Code 最终回答恢复失败',
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
        if (gracefulExitRequested) {
          const flushTimeoutMs = Number.isFinite(deps.sessionFlushTimeoutMs) ? deps.sessionFlushTimeoutMs : 1_000
          const exited = await child.waitForExit(AbortSignal.timeout(Math.max(1, flushTimeoutMs)))
          if (!exited) {
            child.terminate()
            await child.waitForExit()
          }
        } else {
          await child.waitForExit()
        }
        await Promise.allSettled([child.done, cleanup])
        if (!settled) settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
      })()
      return disposal
    },
  }
}
