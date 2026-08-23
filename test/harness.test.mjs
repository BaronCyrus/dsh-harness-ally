import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createHarnessGateway } from '../lib/harness.js'

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
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let stdinText = ''
      let terminated = 0
      let waits = 0
      stdin.on('data', (chunk) => { stdinText += chunk.toString('utf8') })
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      const settle = (outcome = events.outcome ?? { exitCode: 0, signal: null }) => {
        if (events.stdoutChunks) for (const chunk of events.stdoutChunks) stdout.write(chunk)
        else for (const line of events.stdout ?? []) stdout.write(`${line}\n`)
        for (const line of events.stderr ?? []) stderr.write(line)
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
      if (events.defer) spec.signal?.addEventListener('abort', () => {
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
    ] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: '完成。' }),
  ] })

  const run = await f.gateway.start('claude-code', request('task'))
  const [events, result] = await Promise.all([collect(run.stream), run.result])

  assert.deepEqual(events, [
    { type: 'reasoning-delta', text: 'Inspect files.' },
    { type: 'activity', id: 'tool-1', name: 'Bash', summary: '统计项目文件夹数量', status: 'running' },
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
