import assert from 'node:assert/strict'
import test from 'node:test'

import { createAllianceRuntime } from '../lib/runtime.js'

function fixture({ preset = 'harness-ally', status = 'idle', harness = 'dsh', result, stream, availabilityGate, dispatchGate, startError } = {}) {
  const session = {
    id: 'session-1',
    header: { cwd: '/workspace', agentPreset: preset },
    events: [],
    append(type, data) { this.events.push({ seq: this.events.length + 1, type, data }) },
  }
  const agent = {
    id: session.id,
    session,
    status,
    async runMaintenance(task) {
      if (this.status !== 'idle') throw new Error('active work')
      this.status = 'running'
      try {
        return await task(new AbortController().signal)
      } finally {
        this.status = 'idle'
      }
    },
  }
  const starts = []
  const createdRuns = []
  const persists = []
  const recordedDispatches = []
  let selected = harness
  const state = {
    harness() { return selected },
    dispatches() { return recordedDispatches.map((item) => ({ ...item })) },
    async setHarness(sessionId, value) { selected = value; persists.push(sessionId) },
    async recordDispatch(sessionId, value) {
      if (value.started === true && dispatchGate) await dispatchGate
      const index = recordedDispatches.findIndex((item) => item.turn === value.turn)
      if (index < 0) recordedDispatches.push({ ...value })
      else recordedDispatches[index] = { ...value }
      persists.push(sessionId)
    },
  }
  const gateway = {
    async availability() { return { 'claude-code': true, codex: true, 'kimi-code': true } },
    async available() { if (availabilityGate) await availabilityGate; return true },
    start(selected, request) {
      starts.push({ selected, request })
      if (startError) throw startError
      let disposed = false
      const run = {
        id: 'native-run',
        result: result && typeof result.then === 'function' ? result : Promise.resolve(result ?? {
          output: [{ type: 'text', text: 'ALLY_OK' }],
          stopReason: 'completed',
        }),
        ...(stream ? { stream } : {}),
        async dispose() { disposed = true },
        get disposed() { return disposed },
      }
      createdRuns.push(run)
      return run
    },
  }
  const runtime = createAllianceRuntime({
    sessions: { get: (id) => id === session.id ? session : undefined },
    agents: { get: (id) => id === session.id ? agent : undefined },
    gateway,
    state,
    isAgentLoopRequest: (options) => options.agentLoop === true,
  })
  return { runtime, session, agent, starts, createdRuns, persists, recordedDispatches, gateway }
}

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function fallback(chunks = [{ type: 'finish', reason: { kind: 'stop' } }]) {
  let called = 0
  return {
    next() {
      called += 1
      return (async function* () { yield* chunks })()
    },
    get called() { return called },
  }
}

test('snapshot exposes authoritative Harness selection and availability', async () => {
  const { runtime, session } = fixture({ harness: 'codex' })

  assert.deepEqual(await runtime.snapshot(session.id), {
    eligible: true,
    harness: 'codex',
    providers: { dsh: true, 'claude-code': true, codex: true, 'kimi-code': true },
    dispatches: [],
    active: null,
  })
})

test('Host rejects Harness selection outside the alliance preset', async () => {
  const { runtime, session } = fixture({ preset: 'standard' })

  await assert.rejects(
    runtime.select({ sessionId: session.id, agentLoop: true, harness: 'codex' }),
    (error) => error.code === 'PRESET_REQUIRED',
  )
})

test('selection is blocked during a live Agent turn', async () => {
  const { runtime, session } = fixture({ status: 'running' })

  await assert.rejects(
    runtime.select({ sessionId: session.id, agentLoop: true, harness: 'codex' }),
    (error) => error.code === 'TURN_OPEN',
  )
})

test('selection owns Agent maintenance across availability and durable commit', async () => {
  let release
  const availabilityGate = new Promise((resolve) => { release = resolve })
  const { runtime, session, agent, persists } = fixture({ availabilityGate })

  const selection = runtime.select({ sessionId: session.id, harness: 'codex' })
  await Promise.resolve()
  assert.equal(agent.status, 'running')
  await assert.rejects(runtime.select({ sessionId: session.id, harness: 'dsh' }), (error) => error.code === 'TURN_OPEN')
  release()

  assert.deepEqual(await selection, { harness: 'codex' })
  assert.equal(agent.status, 'idle')
  assert.deepEqual(persists, [session.id])
})

test('selection is persisted outside the Session log before acknowledgement', async () => {
  const { runtime, session, persists } = fixture()

  assert.deepEqual(await runtime.select({ sessionId: session.id, harness: 'claude-code' }), { harness: 'claude-code' })
  assert.deepEqual(session.events, [])
  assert.deepEqual(persists, [session.id])
})

test('DSH selection leaves the normal configured-model stream untouched', async () => {
  const { runtime, session } = fixture()
  const pass = fallback([{ type: 'text-delta', index: 0, text: 'native' }])

  const chunks = await collect(runtime.route({ sessionId: session.id, agentLoop: true, model: 'configured-model', messages: [] }, pass.next))

  assert.equal(pass.called, 1)
  assert.equal(chunks[0].text, 'native')
})

test('unmarked session-scoped LLM calls bypass the foreground Harness router', async () => {
  const { runtime, session, starts } = fixture({ harness: 'codex' })
  const pass = fallback([{ type: 'text-delta', index: 0, text: 'plugin-call' }])

  const chunks = await collect(runtime.route({ sessionId: session.id, model: 'configured-model', messages: [] }, pass.next))

  assert.equal(pass.called, 1)
  assert.equal(starts.length, 0)
  assert.equal(chunks[0].text, 'plugin-call')
})

test('external prompt identifies the selected Harness separately from its DSH host', async () => {
  for (const [harness, label] of [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['kimi-code', 'Kimi Code']]) {
    const { runtime, session, starts } = fixture({ harness })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })

    await collect(runtime.route({
      sessionId: session.id,
      agentLoop: true,
      system: 'You are hosted in DeepSeek Harness.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Which Harness is active?' }] }],
    }, fallback().next))

    const prompt = starts[0].request.prompt[0].text
    assert.match(prompt, new RegExp(`active execution Harness for this turn is ${label}`, 'i'))
    assert.match(prompt, /DeepSeek Harness \(DSH\) remains the host/i)
  }
})

test('external prompts keep the Harness instruction, system, and prior history as a stable prefix', async () => {
  const { runtime, session, starts } = fixture({ harness: 'kimi-code' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    system: 'stable system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
  }, fallback().next))

  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    system: 'stable system',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  }, fallback().next))

  const first = starts[0].request.prompt[0].text
  const second = starts[1].request.prompt[0].text
  assert.equal(first.endsWith('USER\nfirst'), true)
  assert.equal(second, `${first}\n\nASSISTANT\nanswer\n\nUSER\nsecond`)
})

test('external Harness emits one standard usage sample even when the provider omits metrics', async () => {
  const { runtime, session } = fixture({ harness: 'codex' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  const chunks = await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }],
  }, fallback().next))

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [{
    type: 'usage', usage: { inputTokens: 0, outputTokens: 0 },
  }])
  assert.equal(chunks.at(-1).type, 'finish')
})

test('external Harness usage reaches the normal DSH model stream with disjoint cache buckets', async () => {
  const usage = {
    inputTokens: 12,
    outputTokens: 7,
    cacheReadTokens: 90,
    cacheWriteTokens: 5,
  }
  const { runtime, session } = fixture({
    harness: 'kimi-code',
    result: { output: [{ type: 'text', text: 'done' }], stopReason: 'completed', usage },
  })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  const chunks = await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }],
  }, fallback().next))

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage'), [{ type: 'usage', usage }])
  const types = chunks.map((chunk) => chunk.type)
  assert.equal(types.lastIndexOf('block-end') < types.indexOf('usage'), true)
  assert.equal(types.at(-1), 'finish')
})

test('external Harness owns only the model adapter while Agent owns the turn', async () => {
  const { runtime, session, starts, persists, recordedDispatches } = fixture({ harness: 'codex' })
  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 1 })
  const pass = fallback()
  const options = {
    sessionId: session.id, agentLoop: true,
    provider: 'configured-provider',
    model: 'configured-model',
    reasoningEffort: 'high',
    temperature: 0.2,
    maxTokens: 4096,
    stop: ['STOP'],
    system: 'system rules',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do work' }] }],
    signal: new AbortController().signal,
  }

  const chunks = await collect(runtime.route(options, pass.next))

  assert.equal(pass.called, 0)
  assert.equal(starts[0].selected, 'codex')
  assert.equal(starts[0].request.model, 'configured-model')
  assert.equal(starts[0].request.reasoningEffort, 'high')
  assert.equal(starts[0].request.temperature, 0.2)
  assert.equal(starts[0].request.maxTokens, 4096)
  assert.deepEqual(starts[0].request.stop, ['STOP'])
  assert.match(starts[0].request.prompt[0].text, /system rules[\s\S]*do work/)
  assert.deepEqual(session.events.map((event) => event.type), ['turn/start', 'step/start'])
  const dispatch = recordedDispatches[0]
  assert.equal(dispatch.turn, 3)
  assert.equal(dispatch.step, 1)
  assert.equal(dispatch.harness, 'codex')
  assert.equal(dispatch.provider, 'configured-provider')
  assert.equal(dispatch.model, 'configured-model')
  assert.equal(dispatch.started, true)
  assert.deepEqual(persists, [session.id, session.id])
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'usage', 'finish',
  ])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('external Harness shows a running status before the CLI emits output', async () => {
  let releaseOutput
  const outputGate = new Promise((resolve) => { releaseOutput = resolve })
  const stream = (async function* () {
    await outputGate
    yield { type: 'text-delta', text: 'ready' }
  })()
  const { runtime, session } = fixture({
    harness: 'codex',
    stream,
    result: { output: [{ type: 'text', text: 'ready' }], stopReason: 'completed' },
  })
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  const iterator = runtime.route({
    sessionId: session.id,
    agentLoop: true,
    provider: 'configured-provider',
    model: 'configured-model',
    messages: [],
  }, fallback().next)[Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'block-start', index: 1, blockType: 'reasoning' } })
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'reasoning-delta', index: 1, text: 'Codex · 正在执行' } })
  const waitingForCli = iterator.next()
  assert.equal(await Promise.race([waitingForCli.then(() => 'output'), new Promise((resolve) => setImmediate(() => resolve('waiting')))]), 'waiting')

  releaseOutput()
  assert.deepEqual(await waitingForCli, { done: false, value: { type: 'block-start', index: 0, blockType: 'text' } })
  while (!(await iterator.next()).done) {}
})

test('external Harness forwards text deltas before its process completes', async () => {
  let finish
  const result = new Promise((resolve) => { finish = resolve })
  const stream = (async function* () {
    yield { type: 'text-delta', text: 'first' }
  })()
  const { runtime, session } = fixture({ harness: 'claude-code', result, stream })
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  const iterator = runtime.route({
    sessionId: session.id,
    agentLoop: true,
    provider: 'configured-provider',
    model: 'configured-model',
    messages: [],
  }, fallback().next)[Symbol.asyncIterator]()

  const pendingFirst = iterator.next()
  const first = await Promise.race([
    pendingFirst,
    new Promise((resolve) => setImmediate(() => resolve('blocked'))),
  ])
  if (first === 'blocked') {
    finish({ output: [{ type: 'text', text: 'first' }], stopReason: 'completed' })
    await pendingFirst
    assert.fail('first external delta remained blocked on process completion')
  }
  assert.deepEqual(first, { done: false, value: { type: 'block-start', index: 1, blockType: 'reasoning' } })
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'reasoning-delta', index: 1, text: 'Claude Code · 正在执行' } })
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'block-start', index: 0, blockType: 'text' } })
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text-delta', index: 0, text: 'first' } })
  finish({ output: [{ type: 'text', text: 'first' }], stopReason: 'completed' })

  const tail = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    tail.push(next.value)
  }
  assert.deepEqual(tail.map((chunk) => chunk.type), ['block-end', 'block-end', 'usage', 'finish'])
  assert.equal(tail.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').block.text, 'first')
})

test('external reasoning and tool activity stay visible without becoming DSH tool calls', async () => {
  const stream = (async function* () {
    yield { type: 'reasoning-delta', text: 'Inspect the workspace.' }
    yield { type: 'activity', id: 'tool-1', name: 'Bash', summary: '统计项目文件夹数量', status: 'running' }
    yield { type: 'activity', id: 'tool-1', name: 'Bash', summary: '统计项目文件夹数量', status: 'completed' }
    yield { type: 'text-delta', text: '完成。' }
  })()
  const { runtime, session } = fixture({
    harness: 'kimi-code',
    stream,
    result: { output: [{ type: 'text', text: '完成。' }], stopReason: 'completed' },
  })
  session.append('turn/start', { turn: 5 })
  session.append('step/start', { turn: 5, step: 1 })

  const chunks = await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    provider: 'configured-provider',
    model: 'configured-model',
    messages: [],
  }, fallback().next))

  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.blockType), ['reasoning', 'text'])
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text), [
    'Kimi Code · 正在执行',
    '\n\nInspect the workspace.',
    '\n\nBash · 统计项目文件夹数量',
    '\n\nBash · 统计项目文件夹数量 · 已完成',
  ])
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning').block.text,
    'Inspect the workspace.\n\nBash · 统计项目文件夹数量\n\nBash · 统计项目文件夹数量 · 已完成')
})

test('external stream keeps the calibrated final block when deltas diverge', async () => {
  const stream = (async function* () {
    yield { type: 'text-delta', text: 'draf' }
  })()
  const { runtime, session } = fixture({
    harness: 'codex',
    stream,
    result: { output: [{ type: 'text', text: 'final' }], stopReason: 'completed' },
  })
  session.append('turn/start', { turn: 5 })
  session.append('step/start', { turn: 5, step: 1 })

  const chunks = await collect(runtime.route({
    sessionId: session.id,
    agentLoop: true,
    provider: 'configured-provider',
    model: 'configured-model',
    messages: [],
  }, fallback().next))

  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'draf')
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').block.text, 'final')
})

test('standard sessions can never enter the external LLM router', async () => {
  const { runtime, session, starts } = fixture({ preset: 'standard', harness: 'codex' })
  const pass = fallback()

  await collect(runtime.route({ sessionId: session.id, agentLoop: true, messages: [] }, pass.next))

  assert.equal(pass.called, 1)
  assert.equal(starts.length, 0)
})

test('auxiliary model calls bypass the selected Harness', async () => {
  const { runtime, session, starts } = fixture({ harness: 'codex' })
  const pass = fallback()

  await collect(runtime.route({ sessionId: session.id, agentLoop: true, purpose: 'session-title', messages: [] }, pass.next))

  assert.equal(pass.called, 1)
  assert.equal(starts.length, 0)
})

test('gateway start failures never produce a visible ran-through-Harness badge', async () => {
  const { runtime, session, recordedDispatches } = fixture({ harness: 'codex', startError: new Error('spawn failed') })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  await assert.rejects(collect(runtime.route({
    sessionId: session.id, agentLoop: true, provider: 'p', model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }, fallback().next)), /spawn failed/)
  assert.equal(recordedDispatches[0].started, false)
})

test('later-step start failures preserve the prior visible turn badge', async () => {
  const { runtime, session, recordedDispatches } = fixture({ harness: 'codex', startError: new Error('spawn failed') })
  recordedDispatches.push({ turn: 1, step: 1, harness: 'codex', model: 'prior-model', started: true })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 2 })

  await assert.rejects(collect(runtime.route({
    sessionId: session.id, agentLoop: true, provider: 'p', model: 'new-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
  }, fallback().next)), /spawn failed/)
  assert.equal(recordedDispatches[0].model, 'prior-model')
  assert.equal(recordedDispatches[0].started, true)
})

test('external Harness rejects image input instead of silently dropping it', async () => {
  const { runtime, session, starts, recordedDispatches } = fixture({ harness: 'codex' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  await assert.rejects(collect(runtime.route({
    sessionId: session.id, agentLoop: true, provider: 'p', model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }] }],
  }, fallback().next)), /不支持图片输入/)
  assert.equal(starts.length, 0)
  assert.deepEqual(recordedDispatches, [])
})

test('shutdown waits for pre-active startup and disposes the resulting run', async () => {
  let releaseDispatch
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve })
  const { runtime, session, starts, createdRuns } = fixture({ harness: 'codex', dispatchGate })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const routeResult = collect(runtime.route({
    sessionId: session.id, agentLoop: true, provider: 'p', model: 'm', messages: [],
  }, fallback().next))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(starts.length, 1)

  let closed = false
  const shutdown = runtime.shutdown().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  releaseDispatch()
  await Promise.all([routeResult, shutdown])
  assert.equal(createdRuns[0].disposed, true)
})

test('aborted Harness results become a terminal aborted model chunk', async () => {
  const { runtime, session } = fixture({ harness: 'codex', result: { output: [], stopReason: 'aborted' } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const controller = new AbortController()
  controller.abort()

  const chunks = await collect(runtime.route({
    sessionId: session.id, agentLoop: true,
    provider: 'p',
    model: 'm',
    messages: [],
    signal: controller.signal,
  }, fallback().next))

  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})
