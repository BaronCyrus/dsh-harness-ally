import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { startKimiAcpRun } from '../lib/kimi-acp.js'

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function fixture() {
  const messages = []
  const spawns = []
  let terminal
  const terminalGate = new Promise((resolve) => { terminal = resolve })
  const controller = new AbortController()
  let bridgeCloses = 0
  let homeRemovals = 0
  let promptRequest
  const subprocess = {
    async resolveExecutable(command) { return `/bin/${command}` },
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let input = ''
      let resolveDone
      let terminated = 0
      const done = new Promise((resolve) => { resolveDone = resolve })
      const send = (value) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
      stdin.on('data', (chunk) => {
        input += chunk.toString('utf8')
        let newline
        while ((newline = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          if (!line) continue
          const message = JSON.parse(line)
          messages.push(message)
          if (message.method === 'initialize') {
            send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: 'test' } } })
          } else if (message.method === 'session/new') {
            send({ id: message.id, result: { sessionId: 'session-kimi', configOptions: [] } })
          } else if (message.method === 'session/set_config_option') {
            send({ id: message.id, result: {} })
          } else if (message.method === 'session/prompt') {
            promptRequest = message
            queueMicrotask(() => {
              send({ id: 99, method: 'session/request_permission', params: { sessionId: 'session-kimi', options: [
                { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
                { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ], toolCall: { toolCallId: '1:tool-1', title: 'Bash' } } })
              send({ method: 'session/update', params: { sessionId: 'session-kimi', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect files.' } } } })
              send({ method: 'session/update', params: { sessionId: 'session-kimi', update: { sessionUpdate: 'tool_call', toolCallId: '1:tool-1', title: '统计项目文件夹数量', kind: 'execute', status: 'in_progress', rawInput: { command: 'find . -type d' } } } })
              send({ method: 'session/update', params: { sessionId: 'session-kimi', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } } })
              send({ method: 'session/update', params: { sessionId: 'session-kimi', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } } })
              terminal()
            })
          } else if (message.method === 'session/cancel') {
            if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'cancelled' } })
          }
        }
      })
      const handle = {
        stdin, stdout, stderr, done, pid: 44,
        terminate() {
          if (terminated > 0) return
          terminated += 1
          stdout.end()
          stderr.end()
          resolveDone({ exitCode: 0, signal: null })
        },
        async waitForExit() { await done; return true },
        get terminated() { return terminated },
        send,
        complete() {
          if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'end_turn' } })
        },
      }
      spawns.push({ spec, handle })
      return handle
    },
  }
  const bridgeRoute = {
    token: 'route-token',
    claudeBaseUrl: 'http://127.0.0.1:9999/claude/route',
    close() { bridgeCloses += 1 },
  }
  const deps = {
    subprocess,
    sandbox: { confine(argv) { return { argv, enforcement: 'full' } } },
    policyFor: () => ({ mode: 'danger-full-access' }),
    authorize() {},
    cliManager: {
      managedRoot: '/managed/dsh-ally',
      async resolve() { return '/bin/kimi' },
    },
    bridge: { async open() { return bridgeRoute } },
    async makeTempDirectory(prefix) {
      assert.match(prefix, /dsh-ally-kimi-/)
      return '/tmp/dsh-ally-kimi-test'
    },
    async removeTempDirectory(path) {
      assert.equal(path, '/tmp/dsh-ally-kimi-test')
      homeRemovals += 1
    },
  }
  const request = {
    parent: { session: { header: { cwd: '/workspace', agentPreset: 'harness-ally' } } },
    prompt: [{ type: 'text', text: 'do work' }],
    provider: 'provider',
    model: 'model',
    reasoningEffort: 'high',
    signal: controller.signal,
  }
  return {
    deps, request, messages, spawns, terminalGate, controller,
    get bridgeCloses() { return bridgeCloses },
    get homeRemovals() { return homeRemovals },
  }
}

test('Kimi ACP streams message, thinking, and read-only tool activity through a DSH model route', async () => {
  const f = fixture()
  const run = await startKimiAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate

  assert.equal(await Promise.race([run.result.then(() => 'done'), Promise.resolve('pending')]), 'pending')
  f.spawns[0].handle.complete()
  const [events, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.deepEqual(events, [
    { type: 'reasoning-delta', text: 'Inspect files.' },
    { type: 'activity', id: '1:tool-1', name: 'Bash', summary: '统计项目文件夹数量', status: 'running' },
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
  ])
  assert.deepEqual(result, { output: [{ type: 'text', text: 'Hello' }], stopReason: 'completed' })
  assert.deepEqual(f.spawns[0].spec.argv, ['/bin/kimi', 'acp'])
  assert.equal(f.spawns[0].spec.argv.join(' ').includes('do work'), false)
  assert.equal(f.spawns[0].spec.argv.join(' ').includes('route-token'), false)
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_NAME, 'model')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_API_KEY, 'route-token')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_PROVIDER_TYPE, 'anthropic')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_BASE_URL, 'http://127.0.0.1:9999/claude/route')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_THINKING_EFFORT, 'high')
  assert.equal(f.spawns[0].spec.env.KIMI_CODE_HOME, '/tmp/dsh-ally-kimi-test')
  assert.deepEqual(f.messages.filter((message) => message.method).map((message) => message.method), [
    'initialize', 'session/new', 'session/set_config_option', 'session/prompt',
  ])
  assert.deepEqual(f.messages[0].params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false })
  assert.deepEqual(f.messages[2].params, { sessionId: 'session-kimi', configId: 'mode', value: 'auto' })
  assert.equal(f.messages[3].params.prompt[0].text, 'do work')
  assert.deepEqual(f.messages.find((message) => message.id === 99 && !message.method)?.result, {
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  })
  assert.equal(f.spawns[0].handle.terminated, 1)
  assert.equal(f.bridgeCloses, 1)
  assert.equal(f.homeRemovals, 1)
})

test('Kimi cancellation sends session/cancel before terminating ACP', async () => {
  const f = fixture()
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  f.controller.abort()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.messages.at(-1).method, 'session/cancel')
  assert.deepEqual(f.messages.at(-1).params, { sessionId: 'session-kimi' })
  assert.equal(f.spawns[0].handle.terminated, 1)
  assert.equal(f.bridgeCloses, 1)
  assert.equal(f.homeRemovals, 1)
})
