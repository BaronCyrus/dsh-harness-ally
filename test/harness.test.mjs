import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createHarnessGateway } from '../lib/harness.js'
import { createNativeSessionRegistry } from '../lib/native-session.js'
import { createConversationView } from '../lib/runtime.js'
import { createAllianceState } from '../lib/state.js'

function fixture(events = {}) {
  const spawns = []
  const resolves = []
  const confined = []
  const bridgeOpens = []
  const subprocess = {
    async resolveExecutable(command) {
      resolves.push(command)
      if (events.missing?.includes(command)) throw new Error('missing')
      return `/bin/${command}`
    },
    spawn(spec) {
      const spawnEvents = events.spawnEvents?.[spawns.length] ?? events
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let stdinText = ''
      let terminated = 0
      let waits = 0
      stdin.on('data', (chunk) => { stdinText += chunk.toString('utf8') })
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const settle = (outcome = spawnEvents.outcome ?? { exitCode: 0, signal: null }) => {
        if (spawnEvents.stdoutChunks) for (const chunk of spawnEvents.stdoutChunks) stdout.write(chunk)
        else for (const line of spawnEvents.stdout ?? []) stdout.write(`${line}\n`)
        for (const line of spawnEvents.stderr ?? []) stderr.write(line)
        stdout.end()
        stderr.end()
        resolveDone(outcome)
      }
      const handle = {
        stdin, stdout, stderr, done, pid: 123,
        terminate() { terminated += 1 },
        async waitForExit() { waits += 1; await done; return true },
        get stdinText() { return stdinText },
        get terminated() { return terminated },
        get waits() { return waits },
        settle,
      }
      if (spawnEvents.defer) spec.signal?.addEventListener('abort', () => {
        handle.terminate()
        settle({ exitCode: null, signal: 'SIGTERM' })
      }, { once: true })
      else queueMicrotask(() => settle())
      spawns.push({ spec, handle })
      return handle
    },
  }
  const sandbox = {
    confine(argv, policy) {
      confined.push({ argv, policy })
      return { argv: ['sandbox-runner', '--', ...argv], enforcement: events.enforcement ?? 'full' }
    },
  }
  const gateway = createHarnessGateway({
    subprocess,
    sandbox,
    policyFor: (session) => ({
      mode: events.mode ?? 'danger-full-access',
      workspaceRoot: session.header.cwd,
      sessionId: 'session-1',
    }),
    authorize(session) {
      if (session?.header?.agentPreset !== 'harness-ally') throw new Error('preset required')
    },
    bridge: events.bridge ? { async open(...args) { bridgeOpens.push(args); return events.bridge } } : undefined,
    cliManager: events.cliManager,
    nativeSessions: events.nativeSessions,
    stateDir: events.stateDir,
  })
  return { gateway, spawns, resolves, confined, bridgeOpens }
}

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function request(prompt = 'do secret work', preset = 'harness-ally') {
  return {
    prompt: [{ type: 'text', text: prompt }],
    parent: { session: { id: 'session-1', header: { cwd: '/workspace', agentPreset: preset } } },
    signal: new AbortController().signal,
  }
}

test('CLI JSON decoding preserves UTF-8 split across stdout chunks', async () => {
  const line = Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: '你' })}\n`)
  const character = Buffer.from('你')
  const offset = line.indexOf(character)
  const f = fixture({ stdoutChunks: [line.subarray(0, offset + 1), line.subarray(offset + 1)] })

  const run = await f.gateway.start('claude-code', request())
  const result = await run.result

  assert.equal(result.output[0].text, '你')
})

test('Claude adapter is stateless and receives the selected model', async () => {
  const f = fixture({ stdout: [JSON.stringify({ type: 'result', subtype: 'success', result: 'CLAUDE_OK' })] })

  const run = await f.gateway.start('claude-code', { ...request('task'), model: 'claude-opus-4-6' })
  const result = await run.result
  const argv = f.spawns[0].spec.argv

  assert.equal(argv.includes('--no-session-persistence'), true)
  assert.deepEqual(argv.slice(-2), ['--model', 'claude-opus-4-6'])
  assert.equal(result.output[0].text, 'CLAUDE_OK')
})

test('Claude persists a fresh native session and adopts its init id', async () => {
  const adopted = []
  const nativeSession = {
    mode: 'fresh',
    prompt: 'FULL CANONICAL HISTORY',
    adopt(id) { adopted.push(id) },
    async fallback() { throw new Error('unexpected fallback') },
  }
  const f = fixture({ stdout: [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }),
  ] })

  const run = await f.gateway.start('claude-code', { ...request('task'), model: 'model-a', nativeSession })
  const result = await run.result

  const argv = f.spawns[0].spec.argv
  assert.equal(result.stopReason, 'completed')
  assert.equal(argv.includes('--no-session-persistence'), false)
  assert.equal(argv.includes('--session-id'), true)
  assert.equal(f.spawns[0].handle.stdinText, 'FULL CANONICAL HISTORY')
  assert.deepEqual(adopted, ['claude-session-1'])
})

test('Claude resumes a native session with only the incremental prompt', async () => {
  const adopted = []
  const nativeSession = {
    mode: 'resume',
    vendorId: 'claude-session-old',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() { throw new Error('unexpected fallback') },
  }
  const f = fixture({ stdout: [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-old' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }),
  ] })

  const run = await f.gateway.start('claude-code', { ...request('task'), model: 'model-a', nativeSession })
  const result = await run.result

  const argv = f.spawns[0].spec.argv
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', 'claude-session-old'])
  assert.equal(f.spawns[0].handle.stdinText, 'USER\ncontinue')
  assert.deepEqual(adopted, ['claude-session-old'])
})

test('Claude retries one invalid resume as a fresh full-history session', async () => {
  const adopted = []
  let fallbacks = 0
  const nativeSession = {
    mode: 'resume',
    vendorId: 'claude-session-missing',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() {
      fallbacks += 1
      this.mode = 'fresh'
      this.vendorId = undefined
      this.prompt = 'FULL CANONICAL HISTORY'
    },
  }
  const f = fixture({ spawnEvents: [
    {
      stdout: [JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: claude-session-missing'],
      })],
      stderr: ['x'.repeat(70 * 1024)],
      outcome: { exitCode: 1, signal: null },
    },
    { stdout: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-new' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'RECOVERED' }),
    ] },
  ] })

  const run = await f.gateway.start('claude-code', { ...request('task'), model: 'model-a', nativeSession })
  const result = await run.result

  assert.equal(result.stopReason, 'completed')
  assert.equal(f.spawns.length, 2)
  assert.equal(f.spawns[0].spec.argv.includes('--resume'), true)
  assert.equal(f.spawns[1].spec.argv.includes('--resume'), false)
  assert.equal(f.spawns[1].spec.argv.includes('--session-id'), true)
  assert.equal(f.spawns[1].handle.stdinText, 'FULL CANONICAL HISTORY')
  assert.equal(fallbacks, 1)
  assert.deepEqual(adopted, ['claude-session-new'])
})

test('Claude never replays an invalid resume after any visible output', async () => {
  let fallbacks = 0
  const nativeSession = {
    mode: 'resume',
    vendorId: 'claude-session-old',
    prompt: 'USER\ncontinue',
    adopt() {},
    async fallback() { fallbacks += 1 },
  }
  const f = fixture({
    stdout: [
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      }),
      JSON.stringify({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: ['No conversation found with session ID: claude-session-old'],
      }),
    ],
    outcome: { exitCode: 1, signal: null },
  })
  const run = await f.gateway.start('claude-code', { ...request('task'), nativeSession })
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.equal(result.output[0].text, 'partial')
  assert.equal(f.spawns.length, 1)
  assert.equal(fallbacks, 0)
})

test('gateway resumes only a consecutive matching DSH session lane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-gateway-resume-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const nativeSessions = createNativeSessionRegistry({ state, version: 'test-version' })
    const f = fixture({
      nativeSessions,
      stateDir: directory,
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }),
      ],
    })
    const first = await f.gateway.start('claude-code', {
      ...request('FULL FIRST'),
      incrementalPrompt: [{ type: 'text', text: 'USER\nfirst' }],
      promptSignature: 'system-a',
      turn: 1,
      provider: 'provider-a',
      model: 'model-a',
    })
    await first.result
    await first.dispose()

    const second = await f.gateway.start('claude-code', {
      ...request('FULL FIRST\n\nASSISTANT\nOK\n\nUSER\nsecond'),
      incrementalPrompt: [{ type: 'text', text: 'USER\nsecond' }],
      promptSignature: 'system-a',
      turn: 2,
      provider: 'provider-a',
      model: 'model-a',
    })
    await second.result
    await second.dispose()
    await state.close()

    assert.equal(f.spawns[0].spec.argv.includes('--session-id'), true)
    assert.deepEqual(f.spawns[1].spec.argv.slice(f.spawns[1].spec.argv.indexOf('--resume'), f.spawns[1].spec.argv.indexOf('--resume') + 2), [
      '--resume', 'claude-session-1',
    ])
    assert.equal(f.spawns[0].handle.stdinText, 'FULL FIRST')
    assert.equal(f.spawns[1].handle.stdinText, 'USER\nsecond')
    assert.equal(f.spawns[1].spec.env.CLAUDE_CONFIG_DIR, join(directory, 'native', 'claude'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('gateway restores a parked Claude lane with only cross-Harness handoff context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-gateway-parked-'))
  const human = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const assistant = (text) => ({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] })
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const nativeSessions = createNativeSessionRegistry({ state, version: 'test-version' })
    const f = fixture({
      nativeSessions,
      stateDir: directory,
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-parked' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'FIRST' }),
      ],
    })
    const firstMessages = [human('first')]
    const first = await f.gateway.start('claude-code', {
      ...request('FULL FIRST'),
      incrementalPrompt: [{ type: 'text', text: 'USER\nfirst' }],
      conversation: createConversationView(firstMessages),
      promptSignature: 'system-a',
      turn: 1,
      provider: 'provider-a',
      model: 'model-a',
    })
    await first.result
    await first.dispose()

    const currentMessages = [
      human('first'), assistant('FIRST'),
      human('handled elsewhere'), assistant('OTHER RESULT'),
      human('return to Claude'),
    ]
    const third = await f.gateway.start('claude-code', {
      ...request('FULL THROUGH TURN 3'),
      incrementalPrompt: [{ type: 'text', text: 'USER\nreturn to Claude' }],
      conversation: createConversationView(currentMessages, { completedTurns: new Set([1, 2]) }),
      promptSignature: 'system-a',
      turn: 3,
      provider: 'provider-a',
      model: 'model-a',
    })
    await third.result
    await third.dispose()
    await state.close()

    assert.deepEqual(f.spawns[1].spec.argv.slice(f.spawns[1].spec.argv.indexOf('--resume'), f.spawns[1].spec.argv.indexOf('--resume') + 2), [
      '--resume', 'claude-session-parked',
    ])
    assert.match(f.spawns[1].handle.stdinText, /^HARNESS HANDOFF/)
    assert.match(f.spawns[1].handle.stdinText, /USER\nhandled elsewhere/)
    assert.match(f.spawns[1].handle.stdinText, /ASSISTANT\nOTHER RESULT/)
    assert.match(f.spawns[1].handle.stdinText, /CURRENT REQUEST FOR RESUMED HARNESS: selected Harness\n\nUSER\nreturn to Claude$/)
    assert.doesNotMatch(f.spawns[1].handle.stdinText, /FULL THROUGH TURN 3/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Claude adapter exposes partial text before its final result', async () => {
  const f = fixture({ stdout: [
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } }),
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }),
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Hello' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello' }),
  ] })

  const run = await f.gateway.start('claude-code', request('task'))
  const [deltas, result] = await Promise.all([collect(run.stream), run.result])

  assert.equal(f.spawns[0].spec.argv.includes('--include-partial-messages'), true)
  assert.deepEqual(deltas, [
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
  ])
  assert.equal(result.output[0].text, 'Hello')
})

test('Claude adapter exposes thinking and read-only tool activity events', async () => {
  const f = fixture({ stdout: [
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Inspect files.' } } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { description: '统计项目文件夹数量', command: 'find . -type d' } },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { description: '执行失败命令', command: 'false' } },
    ] } }),
    JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false },
      { type: 'tool_result', tool_use_id: 'tool-2', content: 'failed', is_error: true },
    ] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: '完成。' }),
  ] })

  const run = await f.gateway.start('claude-code', request('task'))
  const [events, result] = await Promise.all([collect(run.stream), run.result])

  assert.deepEqual(events, [
    { type: 'reasoning-delta', text: 'Inspect files.' },
    { type: 'activity', id: 'tool-1', name: 'Bash', summary: '统计项目文件夹数量', command: 'find . -type d', status: 'running' },
    { type: 'activity', id: 'tool-2', name: 'Bash', summary: '执行失败命令', command: 'false', status: 'running' },
    { type: 'activity', id: 'tool-1', name: 'Bash', summary: '统计项目文件夹数量', command: 'find . -type d', status: 'completed' },
    { type: 'activity', id: 'tool-2', name: 'Bash', summary: '执行失败命令', command: 'false', status: 'failed' },
  ])
  assert.equal(result.output[0].text, '完成。')
})

test('Claude completed message calibrates a divergent partial transcript', async () => {
  const f = fixture({ stdout: [
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } }),
    JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Helo' } } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Hello' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello' }),
  ] })

  const run = await f.gateway.start('claude-code', request('task'))
  const [deltas, result] = await Promise.all([collect(run.stream), run.result])

  assert.deepEqual(deltas, [{ type: 'text-delta', text: 'Helo' }])
  assert.equal(result.output[0].text, 'Hello')
})

test('foreground Claude routes the configured provider/model without putting its token in argv', async () => {
  let closed = 0
  const bridge = {
    token: 'secret-route-token',
    claudeBaseUrl: 'http://127.0.0.1:1234/claude/route',
    codexBaseUrl: 'http://127.0.0.1:1234/codex/route/v1',
    usage() { return { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 } },
    close() { closed += 1 },
  }
  const f = fixture({ bridge, stdout: [JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' })] })

  const run = await f.gateway.start('claude-code', {
    ...request('task'), provider: 'configured-provider', model: 'configured-model',
  })
  const result = await run.result

  const argv = f.spawns[0].spec.argv
  assert.equal(argv.includes('--bare'), true)
  assert.equal(argv.join(' ').includes('secret-route-token'), false)
  assert.equal(f.spawns[0].spec.env.ANTHROPIC_API_KEY, 'secret-route-token')
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 })
  assert.equal(f.bridgeOpens[0][2].sessionId, 'session-1')
  assert.equal(closed, 1)
})

test('non-danger modes are wrapped by the DSH sandbox', async () => {
  const f = fixture({ mode: 'workspace-write', stdout: [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
  ] })

  const run = await f.gateway.start('claude-code', request())
  await run.result

  assert.equal(f.confined.length, 1)
  assert.equal(f.confined[0].policy.workspaceRoot, '/workspace')
  assert.equal(f.spawns[0].spec.argv[0], 'sandbox-runner')
})

test('provider diagnostics never expose raw stderr', async () => {
  const f = fixture({ stderr: ['API_KEY=secret'], outcome: { exitCode: 1, signal: null } })

  const run = await f.gateway.start('claude-code', request())
  const result = await run.result

  assert.equal(result.stopReason, 'error')
  assert.doesNotMatch(result.diagnostic, /secret|API_KEY/)
})

test('provider boundary rejects a non-alliance parent before spawn', async () => {
  const f = fixture()

  await assert.rejects(f.gateway.provider('codex').start(request('task', 'standard')), /preset required/)
  assert.equal(f.spawns.length, 0)
})

test('already-aborted requests never spawn a process', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(f.gateway.start('claude-code', { ...request(), signal: controller.signal }), /before spawn/)
  assert.equal(f.spawns.length, 0)
})

test('live Agent cancellation terminates the subprocess, waits for exit, and closes its bridge', async () => {
  let closeCalls = 0
  let closed = false
  const bridge = {
    token: 'secret-route-token',
    claudeBaseUrl: 'http://127.0.0.1:1234/claude/route',
    codexBaseUrl: 'http://127.0.0.1:1234/codex/route/v1',
    close() {
      if (closed) return
      closed = true
      closeCalls += 1
    },
  }
  const f = fixture({ defer: true, bridge })
  const controller = new AbortController()
  const run = await f.gateway.start('claude-code', {
    ...request(), provider: 'configured-provider', model: 'configured-model', signal: controller.signal,
  })

  controller.abort()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.spawns[0].handle.terminated >= 1, true)
  assert.equal(f.spawns[0].handle.waits, 1)
  assert.equal(closeCalls, 1)
})

test('lifecycle disposal classifies holder termination as aborted without a signal race', async () => {
  const f = fixture({ defer: true })
  const run = await f.gateway.start('claude-code', request())
  const disposal = run.dispose()
  f.spawns[0].handle.settle({ exitCode: 143, signal: 'SIGTERM' })

  await disposal
  assert.equal((await run.result).stopReason, 'aborted')
})

test('gateway execution and availability both use the shared CLI manager', async () => {
  const calls = []
  const cliManager = {
    async resolve(harness) {
      calls.push(harness)
      return `/managed/${harness}`
    },
  }
  const f = fixture({
    cliManager,
    stdout: [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })],
  })

  const run = await f.gateway.start('claude-code', request())
  await run.result
  assert.equal(f.spawns[0].spec.argv[0], '/managed/claude-code')
  assert.equal(await f.gateway.available('claude-code'), true)
  assert.deepEqual(calls, ['claude-code', 'claude-code'])
  assert.deepEqual(f.resolves, [])
})

test('availability reflects executable resolution', async () => {
  const f = fixture({ missing: ['claude'] })

  assert.deepEqual(await f.gateway.availability(), { 'claude-code': false, codex: true, 'kimi-code': true })
  assert.deepEqual(f.resolves.sort(), ['claude', 'codex', 'kimi'])
})
