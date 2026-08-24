import { createHash, randomUUID } from 'node:crypto'

import { normalizeLedgerText, renderWorkLedger, workLedgerFromActivities } from './work-ledger.js'

export const ALLY_PRESET = 'harness-ally'
export const HARNESSES = Object.freeze(['dsh', 'claude-code', 'codex', 'kimi-code'])
const HARNESS_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code' })
const EMPTY_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 })

function selectedPreset(session) {
  let preset = session.header?.agentPreset
  for (const event of session.events) {
    if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      preset = event.data.agentPreset
    }
  }
  return preset
}

export function isAllianceSession(session) {
  return Boolean(session && selectedPreset(session) === ALLY_PRESET)
}

function currentBoundary(session) {
  let turn
  let step
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn
      step = undefined
    } else if (event.type === 'step/start' && event.data?.turn === turn) {
      step = event.data?.step
    }
  }
  return { turn, step }
}

// DSH agent-loop commits this exact turn/end reason before the next turn can start.
function completedTurns(session) {
  const outcomes = new Map()
  for (const event of session?.events ?? []) {
    if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)) {
      outcomes.set(event.data.turn, event.data?.reason?.kind)
    }
  }
  return new Set([...outcomes].filter(([, kind]) => kind === 'completed').map(([turn]) => turn))
}

function conversationProvenance(session, dispatches, currentHarness) {
  const harnessByTurn = new Map((dispatches ?? []).map((dispatch) => [dispatch.turn, HARNESS_LABELS[dispatch.harness] ?? String(dispatch.harness)]))
  const boundary = currentBoundary(session)
  if (Number.isSafeInteger(boundary.turn)) harnessByTurn.set(boundary.turn, HARNESS_LABELS[currentHarness] ?? String(currentHarness))
  const turnsByMessage = new Map()
  let activeTurn
  for (const event of session?.events ?? []) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) activeTurn = event.data.turn
    else if (event.type === 'user/message' && typeof event.data?.id === 'string' && Number.isSafeInteger(activeTurn)) {
      turnsByMessage.set(event.data.id, activeTurn)
    } else if ((event.type === 'assistant/message' || event.type === 'tool/result')
      && typeof event.data?.message?.id === 'string'
      && Number.isSafeInteger(event.data?.turn)) {
      turnsByMessage.set(event.data.message.id, event.data.turn)
    }
  }
  return new Map([...turnsByMessage].map(([messageId, turn]) => [messageId, {
    turn,
    harness: harnessByTurn.get(turn) ?? 'DeepSeek Harness',
  }]))
}

function promptPrefix(options, harness) {
  const harnessLabel = HARNESS_LABELS[harness] ?? String(harness)
  const parts = [[
    'HARNESS INSTRUCTION',
    `The active execution Harness for this turn is ${harnessLabel}.`,
    'DeepSeek Harness (DSH) remains the host for conversation history, model selection, permissions, cancellation, and records.',
    `When asked about the current Harness or execution environment, identify ${harnessLabel} as the executor and DSH as the host.`,
    'Conversation messages may identify the execution Harness that produced them. First-person identity or memory claims belong only to that labeled Harness; never adopt them as another Harness\'s identity.',
    'Act as the selected coding Harness for this request. Use your native tools when useful.',
    'Return the final response for the user; do not describe this transport wrapper unless the user asks about the execution environment.',
  ].join('\n')]
  if (options.system) parts.push(`SYSTEM\n${options.system}`)
  return parts.join('\n\n')
}

function conversationBlockText(block, toolNames) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'reasoning') return ''
  if (block.type === 'image') return '[image omitted from external Harness history]'
  if (block.type === 'tool-call') {
    const name = String(block.name ?? 'unknown')
    if (typeof block.id === 'string' && block.id) toolNames.set(block.id, name)
    const args = typeof block.arguments === 'string' ? block.arguments : ''
    return `[tool call: ${name}]${args ? `\n${args}` : ''}`
  }
  if (block.type === 'tool-result') {
    const body = Array.isArray(block.content)
      ? block.content.map((item) => conversationBlockText(item, toolNames)).filter(Boolean).join('\n')
      : ''
    const name = toolNames.get(block.toolCallId) ?? String(block.name ?? 'unknown')
    return `[tool result: ${name}]${body ? `\n${body}` : ''}`
  }
  return ''
}

function digestMessages(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function isHumanMessage(message) {
  const hasToolResult = (message?.content ?? []).some((block) => block?.type === 'tool-result')
  return message?.role === 'user'
    && (message?.source?.kind === 'user' || (message?.source === undefined && !hasToolResult))
}

function renderConversationMessage(role, content, provenance) {
  const message = `${String(role ?? 'message').toUpperCase()}\n${content}`
  if (!provenance) return message
  return `[DSH TURN ${provenance.turn} · EXECUTION HARNESS: ${provenance.harness}]\n${message}`
}

function isSpineMessage(message) {
  const source = message?.source
  if (source === undefined) return true
  if (source.kind === 'user' || source.kind === 'model' || source.kind === 'tool') return true
  return source.kind === 'plugin' && (source.form === 'notice' || source.form === 'relay' || source.form === 'recall')
}

export function createConversationView(messages, { completedTurns: cleanTurns, provenance, workLedgers } = {}) {
  const source = messages ?? []
  let rawRequestIndex = -1
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(source[index])) {
      rawRequestIndex = index
      break
    }
  }
  const toolNames = new Map()
  const allEntries = []
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const message = source[sourceIndex]
    const content = (message?.content ?? []).map((block) => {
      if (sourceIndex === rawRequestIndex && block?.type === 'image') {
        throw new Error('外部 Harness 暂不支持图片输入，请为本回合切换到 DSH')
      }
      return conversationBlockText(block, toolNames)
    }).filter(Boolean).join('\n')
    if (!content) continue
    const messageProvenance = provenance instanceof Map ? provenance.get(message?.id) : undefined
    const text = renderConversationMessage(message.role, content, messageProvenance)
    allEntries.push({
      text,
      provenance: messageProvenance,
      human: isHumanMessage(message),
      role: message?.role,
      sourceKind: message?.source?.kind,
      spine: isSpineMessage(message),
    })
  }
  const fullWorkLedger = renderWorkLedger(workLedgers)
  if (fullWorkLedger) {
    const insertionIndex = allEntries.findLastIndex((entry) => entry.human)
    const ledgerEntry = {
      text: fullWorkLedger,
      provenance: undefined,
      human: false,
      role: 'user',
      sourceKind: 'plugin',
      spine: false,
    }
    if (insertionIndex >= 0) allEntries.splice(insertionIndex, 0, ledgerEntry)
    else allEntries.push(ledgerEntry)
  }
  const entries = allEntries.filter((entry) => entry.spine)
  const rendered = entries.map((entry) => entry.text)
  const allRendered = allEntries.map((entry) => entry.text)
  let requestIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].human) {
      requestIndex = index
      break
    }
  }
  function hasCleanCompletedHistory(fromIndex, toIndex) {
    for (let index = fromIndex; index < toIndex; index += 1) {
      if (!entries[index].human) continue
      let nextHuman = toIndex
      for (let cursor = index + 1; cursor < toIndex; cursor += 1) {
        if (entries[cursor].human) {
          nextHuman = cursor
          break
        }
      }
      const lastMeaningful = entries.slice(index + 1, nextHuman)
        .filter((entry) => entry.sourceKind !== 'plugin')
        .at(-1)
      if (lastMeaningful?.role !== 'assistant') return false
    }
    return true
  }
  function hasCleanTurnGap(boundary) {
    if (!boundary) return false
    if (boundary.beforeTurn - boundary.afterTurn <= 1) return true
    if (!(cleanTurns instanceof Set)) return false
    for (let turn = boundary.afterTurn + 1; turn < boundary.beforeTurn; turn += 1) {
      if (!cleanTurns.has(turn)) return false
    }
    return true
  }
  return {
    messages: allRendered,
    currentPrompt() {
      return requestIndex >= 0 ? rendered.slice(requestIndex).join('\n\n') || undefined : undefined
    },
    watermarkAfter(assistantOutput) {
      // runtime.route commits outputText() as one trimmed assistant text block.
      const assistantText = typeof assistantOutput === 'string' ? assistantOutput.trim() : outputText(assistantOutput)
      if (!assistantText) return undefined
      const assistantMessage = renderConversationMessage('assistant', assistantText, entries[requestIndex]?.provenance)
      const anchored = [...rendered, assistantMessage]
      return { messageCount: anchored.length, digest: digestMessages(anchored) }
    },
    resumeFrom(watermark, boundary) {
      if (!watermark || !Number.isSafeInteger(watermark.messageCount) || watermark.messageCount < 1) return undefined
      if (watermark.messageCount >= rendered.length || requestIndex < watermark.messageCount) return undefined
      if (digestMessages(rendered.slice(0, watermark.messageCount)) !== watermark.digest) return undefined
      const history = rendered.slice(watermark.messageCount, requestIndex)
      const current = rendered.slice(requestIndex)
      if (history.length === 0) return current.join('\n\n') || undefined
      if (!hasCleanTurnGap(boundary)) return undefined
      if (!hasCleanCompletedHistory(watermark.messageCount, requestIndex)) return undefined
      const resumedHarness = entries[requestIndex]?.provenance?.harness ?? 'selected Harness'
      const workLedger = renderWorkLedger(workLedgers, boundary)
      return [
        'HARNESS HANDOFF',
        'While this Harness was parked, DSH recorded the following canonical messages. Treat them as intervening history and do not repeat completed work. The workspace is authoritative; inspect it when details are uncertain.',
        'IDENTITY ISOLATION',
        `You are resuming the ${resumedHarness} lane. In the history below, first-person identity claims belong to the labeled other Harness that produced them. Never adopt another Harness's identity, persona, code name, or private memory as your own; preserve this lane's prior identity.`,
        workLedger,
        history.join('\n\n'),
        `CURRENT REQUEST FOR RESUMED HARNESS: ${resumedHarness}`,
        current.join('\n\n'),
      ].filter(Boolean).join('\n\n')
    },
  }
}

function harnessPrompts(options, harness, session, dispatches) {
  const prefix = promptPrefix(options, harness)
  const conversation = createConversationView(options.messages, {
    completedTurns: completedTurns(session),
    provenance: conversationProvenance(session, dispatches, harness),
    workLedgers: dispatches,
  })
  const incremental = conversation.currentPrompt()
  return {
    full: [prefix, ...conversation.messages].join('\n\n'),
    incremental,
    conversation,
    signature: createHash('sha256').update(prefix).digest('hex'),
  }
}

function outputText(output) {
  return (output ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

async function settleRun(run) {
  const execution = await Promise.resolve(run.result).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const disposal = await Promise.resolve().then(() => run.dispose()).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  )
  if (!execution.ok) throw execution.error
  if (!disposal.ok) throw disposal.error
  return execution.value
}

function failure(message, code = 'ALLY_HARNESS_ERROR') {
  return { message, code }
}

export function createAllianceRuntime({ sessions, agents, gateway, state, isAgentLoopRequest }) {
  const active = new Map()
  const selections = new Map()
  const startups = new Set()
  const runs = new Set()
  let closing = false

  function sessionFor(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) {
      const error = new Error('会话不存在或当前未加载')
      error.code = 'SESSION_NOT_FOUND'
      throw error
    }
    return session
  }

  function assertEligible(session) {
    if (isAllianceSession(session)) return
    const error = new Error('只有 Harness联盟模式 会话可以切换 Harness')
    error.code = 'PRESET_REQUIRED'
    throw error
  }

  async function snapshot(sessionId) {
    const session = sessionFor(sessionId)
    const current = active.get(sessionId)
    const availability = await gateway.availability()
    return {
      eligible: isAllianceSession(session),
      harness: state.harness(sessionId),
      providers: { dsh: true, ...availability },
      dispatches: state.dispatches(sessionId),
      active: current ? { runId: current.runId, harness: current.harness } : null,
    }
  }

  async function select({ sessionId, harness }) {
    if (!HARNESSES.includes(harness)) {
      const error = new Error('未知 Harness')
      error.code = 'INVALID_HARNESS'
      throw error
    }
    const session = sessionFor(sessionId)
    assertEligible(session)
    if (selections.has(sessionId)) {
      const error = new Error('已有 Harness 切换正在进行')
      error.code = 'TURN_OPEN'
      throw error
    }
    const agent = agents.get(sessionId)
    if (!agent) {
      const error = new Error('当前会话 Agent 未运行')
      error.code = 'AGENT_NOT_FOUND'
      throw error
    }
    if (closing || agent.status !== 'idle' || active.has(sessionId)) {
      const error = new Error('运行期间不能切换 Harness')
      error.code = 'TURN_OPEN'
      throw error
    }
    let operation
    try {
      operation = agent.runMaintenance(async (signal) => {
        signal.throwIfAborted()
        if (harness !== 'dsh' && !(await gateway.available(harness))) {
          const error = new Error(`${harness} CLI 当前不可用`)
          error.code = 'PROVIDER_UNAVAILABLE'
          throw error
        }
        signal.throwIfAborted()
        await state.setHarness(sessionId, harness)
        return { harness }
      })
    } catch (cause) {
      const error = new Error('运行期间不能切换 Harness', { cause })
      error.code = 'TURN_OPEN'
      throw error
    }
    selections.set(sessionId, operation)
    try {
      return await operation
    } finally {
      if (selections.get(sessionId) === operation) selections.delete(sessionId)
    }
  }

  async function* route(options, next) {
    if (!isAgentLoopRequest(options) || options.purpose || !options.sessionId) {
      yield* next()
      return
    }
    const session = sessions.get(options.sessionId)
    if (!isAllianceSession(session)) {
      yield* next()
      return
    }
    if (closing) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('Harness 联盟正在关闭', 'ABORTED') } }
      return
    }
    const selection = selections.get(options.sessionId)
    if (selection) await selection.catch(() => {})
    const harness = state.harness(options.sessionId)
    if (harness === 'dsh') {
      yield* next()
      return
    }
    const agent = agents.get(options.sessionId)
    if (!agent) {
      yield { type: 'finish', reason: { kind: 'error', failure: failure('Harness联盟 Agent 已离线', 'ALLY_AGENT_OFFLINE') } }
      return
    }

    const runId = `ally-${randomUUID()}`
    const signal = options.signal ?? new AbortController().signal
    const boundary = currentBoundary(session)
    if (!Number.isSafeInteger(boundary.turn) || !Number.isSafeInteger(boundary.step)) {
      throw new Error('Agent-loop Harness 请求缺少有效 turn/step 边界')
    }
    const prompts = harnessPrompts(options, harness, session, state.dispatches(options.sessionId))
    const dispatch = {
      ...boundary,
      runId,
      harness,
      provider: options.provider,
      model: options.model,
      started: false,
    }
    let run
    const startup = (async () => {
      const priorDispatch = state.dispatches(options.sessionId).find((item) => item.turn === boundary.turn && item.started === true)
      if (!priorDispatch) await state.recordDispatch(options.sessionId, dispatch)
      const startedRun = await gateway.start(harness, {
        parent: agent,
        prompt: [{ type: 'text', text: prompts.full }],
        ...(prompts.incremental ? { incrementalPrompt: [{ type: 'text', text: prompts.incremental }] } : {}),
        conversation: prompts.conversation,
        promptSignature: prompts.signature,
        turn: boundary.turn,
        signal,
        model: options.model,
        provider: options.provider,
        reasoningEffort: options.reasoningEffort,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop,
      })
      runs.add(startedRun)
      run = startedRun
      await state.recordDispatch(options.sessionId, { ...dispatch, started: true })
      return startedRun
    })()
    startups.add(startup)

    try {
      try {
        run = await startup
      } finally {
        startups.delete(startup)
      }
      active.set(options.sessionId, { runId, harness, run })
      let streamedText = ''
      let textStarted = false
      const executorTitle = HARNESS_LABELS[harness] ?? String(harness)
      const startingStatus = `${executorTitle} · 正在执行`
      let reasoningText = startingStatus
      let lastWasActivity = true
      const seenActivities = new Map()
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: startingStatus }
      if (run.stream) {
        for await (const event of run.stream) {
          if (event?.type === 'text-delta' && typeof event.text === 'string' && event.text) {
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: 0, blockType: 'text' }
            }
            streamedText += event.text
            yield { type: 'text-delta', index: 0, text: event.text }
            continue
          }
          let reasoningDelta = ''
          if (event?.type === 'reasoning-delta' && typeof event.text === 'string' && event.text) {
            reasoningDelta = `${lastWasActivity && reasoningText ? '\n\n' : ''}${event.text}`
            lastWasActivity = false
          } else if (event?.type === 'activity' && typeof event.name === 'string') {
            const name = normalizeLedgerText(event.name, 48)
            const summary = normalizeLedgerText(event.summary, 180)
            const command = normalizeLedgerText(event.command)
            const paths = Array.isArray(event.paths)
              ? event.paths.map((path) => normalizeLedgerText(path)).filter(Boolean)
              : []
            const activityId = typeof event.id === 'string' && event.id ? event.id : `${name}:${summary}`
            const status = event.status === 'completed' || event.status === 'failed' ? event.status : 'running'
            const snapshot = `${name}\u0000${summary}\u0000${command}\u0000${status}\u0000${paths.join('\u0000')}`
            if (!name || seenActivities.get(activityId)?.snapshot === snapshot) continue
            seenActivities.set(activityId, { snapshot, activity: { name, summary, command, paths, status } })
            const statusText = status === 'completed' ? '已完成' : status === 'failed' ? '失败' : ''
            reasoningDelta = `${reasoningText ? '\n\n' : ''}${name}${summary ? ` · ${summary}` : ''}${statusText ? ` · ${statusText}` : ''}`
            lastWasActivity = true
          } else {
            continue
          }
          reasoningText += reasoningDelta
          yield { type: 'reasoning-delta', index: 1, text: reasoningDelta }
        }
      }
      const result = await settleRun(run)
      const cleanCompleted = result.stopReason === 'completed' && !signal.aborted
      if (cleanCompleted) {
        const ledger = workLedgerFromActivities([...seenActivities.values()].map((entry) => entry.activity))
        if (ledger) await state.recordDispatch(options.sessionId, { ...dispatch, started: true, ledger })
      }
      const usage = result.usage ?? EMPTY_USAGE
      const text = outputText(result.output)
      const processText = reasoningText.slice(startingStatus.length).replace(/^\n\n/, '')
      if (result.stopReason === 'aborted' || (!cleanCompleted && signal.aborted)) {
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 已停止` } }
        if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('Harness 请求已停止', 'ABORTED') } }
        return
      }
      if (result.stopReason === 'error') {
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 执行失败` } }
        if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'error', failure: failure(result.diagnostic || '外部 Harness 执行失败') } }
        return
      }
      const tail = !streamedText ? text : text.startsWith(streamedText) ? text.slice(streamedText.length) : ''
      if (tail) {
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        streamedText += tail
        yield { type: 'text-delta', index: 0, text: tail }
      }
      const finalText = text || streamedText
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 已完成` } }
      if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: finalText } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      if (active.get(options.sessionId)?.runId === runId) active.delete(options.sessionId)
      if (run) {
        try {
          await run.dispose()
        } finally {
          runs.delete(run)
        }
      }
    }
  }

  async function shutdown() {
    closing = true
    while (selections.size > 0 || startups.size > 0) {
      await Promise.allSettled([...selections.values(), ...startups])
    }
    active.clear()
    const results = await Promise.allSettled([...runs].map((run) => run.dispose()))
    const failureResult = results.find((result) => result.status === 'rejected')
    if (failureResult) throw failureResult.reason
  }

  return { snapshot, select, route, shutdown }
}
