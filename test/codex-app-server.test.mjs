import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { startCodexAppServerRun } from '../lib/codex-app-server.js'

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function fixture() {
  const requests = []
  const spawns = []
  let terminal
  const terminalGate = new Promise((resolve) => { terminal = resolve })
  const controller = new AbortController()
  let bridgeCloses = 0
  const bridgeOpens = []
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
      const send = (value) => stdout.write(`${JSON.stringify(value)}\n`)
      stdin.on('data', (chunk) => {
        input += chunk.toString('utf8')
        let newline
        while ((newline = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          if (!line) continue
          const request = JSON.parse(line)
          requests.push(request)
          if (request.method === 'initialize') {
            send({ id: request.id, result: { userAgent: 'codex-test', codexHome: '/tmp/codex' } })
          } else if (request.method === 'thread/start') {
            send({ id: request.id, result: { thread: { id: 'thread-1' }, model: 'm', modelProvider: 'dsh-ally', cwd: '/workspace' } })
          } else if (request.method === 'turn/start') {
            send({ id: request.id, result: { turn: { id: 'turn-1' } } })
            queueMicrotask(() => {
              send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: 'Inspect files.', summaryIndex: 0 } })
              send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', command: 'find . -type d', cwd: '/workspace', status: 'inProgress' } } })
              send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hel' } })
              send({ method: 'item/updated', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Hello' } } })
              send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'lo' } })
              send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Hello' } } })
              terminal()
            })
          } else if (request.method === 'turn/interrupt') {
            send({ id: request.id, result: {} })
            send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } })
          }
        }
      })
      const handle = {
        stdin, stdout, stderr, done, pid: 42,
        terminate() {
          terminated += 1
          stdout.end()
          stderr.end()
          resolveDone({ exitCode: 0, signal: null })
        },
        async waitForExit() { await done; return true },
        get terminated() { return terminated },
        send,
      }
      spawns.push({ spec, handle })
      return handle
    },
  }
  const bridgeRoute = {
    token: 'route-token',
    codexBaseUrl: 'http://127.0.0.1:9999/codex/route/v1',
    usage() { return { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 } },
    close() { bridgeCloses += 1 },
  }
  const deps = {
    subprocess,
    sandbox: { confine(argv) { return { argv, enforcement: 'full' } } },
    policyFor: () => ({ mode: 'danger-full-access' }),
    authorize() {},
    cliManager: { async resolve() { return '/bin/codex' } },
    bridge: { async open(...args) { bridgeOpens.push(args); return bridgeRoute } },
  }
  const request = {
    parent: { session: { id: 'session-1', header: { cwd: '/workspace', agentPreset: 'harness-ally' } } },
    prompt: [{ type: 'text', text: 'do work' }],
    provider: 'provider',
    model: 'model',
    reasoningEffort: 'high',
    signal: controller.signal,
  }
  return { deps, request, requests, spawns, terminalGate, controller, bridgeOpens, get bridgeCloses() { return bridgeCloses } }
}

test('Codex app-server streams dedicated agent message deltas without snapshot duplication', async () => {
  const f = fixture()
  const run = await startCodexAppServerRun(f.deps, f.request)
  const deltaPromise = collect(run.stream)
  await f.terminalGate

  assert.equal(await Promise.race([run.result.then(() => 'done'), Promise.resolve('pending')]), 'pending')
  f.spawns[0].handle.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
  const [deltas, result] = await Promise.all([deltaPromise, run.result])

  assert.deepEqual(deltas, [
    { type: 'reasoning-delta', text: 'Inspect files.' },
    { type: 'activity', id: 'command-1', name: 'Bash', summary: 'find . -type d', status: 'running' },
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
  ])
  assert.equal(result.output[0].text, 'Hello')
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 })
  assert.equal(f.bridgeOpens[0][2].sessionId, 'session-1')
  assert.equal(f.spawns[0].spec.argv[1], 'app-server')
  assert.equal(f.spawns[0].spec.argv.includes('exec'), false)
  assert.deepEqual(f.requests.map((request) => request.method), ['initialize', 'thread/start', 'turn/start'])
  assert.equal(f.requests[0].params.clientInfo.version, '0.9.2')
  assert.equal(f.requests[0].params.capabilities.experimentalApi, true)
  assert.deepEqual(f.bridgeOpens[0].slice(0, 2), ['provider', 'model'])
  assert.equal(f.requests[1].params.modelProvider, 'dsh-ally')
  assert.equal(f.requests[1].params.model, 'gpt-5.6')
  assert.equal(f.requests[1].params.ephemeral, true)
  assert.equal(f.requests[2].params.model, 'gpt-5.6')
  assert.equal(f.requests[2].params.input[0].text, 'do work')
  assert.equal(f.requests[2].params.effort, 'high')
  assert.deepEqual(f.requests[2].params.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(f.requests[2].params.summary, 'auto')
  assert.equal(f.spawns[0].handle.terminated, 1)
  assert.equal(f.bridgeCloses, 1)
})

test('Codex cancellation sends turn/interrupt before terminating the app-server', async () => {
  const f = fixture()
  const run = await startCodexAppServerRun(f.deps, f.request)
  await f.terminalGate

  f.controller.abort()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.requests.at(-1).method, 'turn/interrupt')
  assert.deepEqual(f.requests.at(-1).params, { threadId: 'thread-1', turnId: 'turn-1' })
  assert.equal(f.spawns[0].handle.terminated, 1)
  assert.equal(f.bridgeCloses, 1)
})
