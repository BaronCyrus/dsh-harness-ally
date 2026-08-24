import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { startKimiAcpRun } from '../lib/kimi-acp.js'

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function fixture({
  modeAdvertised = true,
  skillStall = false,
  skillEarlyEnd = false,
  skillRecoveryEmpty = false,
  skillRecoveryStall = false,
  skillRecoverySlowAfterTool = false,
  skillRecoveryEmptyAfterTool = false,
  skillPartialThenStall = false,
  nonSkillToolBeforeSkill = false,
  stalePermissionOnRecovery = false,
  delayRecoverySession = false,
  prematureToolEnd = false,
  prematureMarkerBeforeText = false,
  prematureMarkerBeforeTool = false,
  finalizationOmitsMarker = false,
  finalizationWhitespaceOnly = false,
  nativeSession,
  resumeAdvertised = true,
  resumeFails = false,
  loadReplay = false,
  ignoreGracefulExit = false,
  skillLateMessageOnCancel = false,
  skillLateCompleteOnCancel = false,
  skillTitle = 'Skill',
  skillContinuationTimeoutMs,
  sessionFlushTimeoutMs,
} = {}) {
  const messages = []
  const spawns = []
  let terminal
  const terminalGate = new Promise((resolve) => { terminal = resolve })
  let recoverySessionStarted
  const recoverySessionGate = new Promise((resolve) => { recoverySessionStarted = resolve })
  const controller = new AbortController()
  let bridgeCloses = 0
  let homeRemovals = 0
  const bridgeOpens = []
  const createdDirectories = []
  let promptRequest
  let promptCount = 0
  let sessionCount = 0
  let pendingRecoverySession
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
      stdin.on('finish', () => queueMicrotask(() => {
        if (ignoreGracefulExit || terminated > 0) return
        stdout.end()
        stderr.end()
        resolveDone({ exitCode: 0, signal: null })
      }))
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
            send({ id: message.id, result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: resumeAdvertised,
                sessionCapabilities: resumeAdvertised ? { resume: {} } : {},
              },
              agentInfo: { name: 'Kimi Code CLI', version: 'test' },
            } })
          } else if (message.method === 'session/load') {
            if (resumeFails) send({ id: message.id, error: { code: -32602, message: 'session not found' } })
            else {
              if (loadReplay) {
                send({
                  method: 'session/update',
                  params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY␞' } } },
                })
                send({
                  id: 103,
                  method: 'session/request_permission',
                  params: {
                    sessionId: message.params.sessionId,
                    options: [{ optionId: 'approve_once', kind: 'allow_once' }, { optionId: 'approve_always', kind: 'allow_always' }],
                    toolCall: { toolCallId: 'replayed-tool', title: 'Bash' },
                  },
                })
              }
              send({ id: message.id, result: {
              sessionId: message.params.sessionId,
              configOptions: modeAdvertised ? [{
                type: 'select', id: 'mode', currentValue: 'default', options: [{ value: 'auto', name: 'Auto' }],
              }] : [],
            } })
            }
          } else if (message.method === 'session/new') {
            sessionCount += 1
            const response = { id: message.id, result: {
              sessionId: sessionCount === 1 ? 'session-kimi' : 'session-kimi-recovery',
              configOptions: modeAdvertised ? [{
                type: 'select', id: 'mode', currentValue: 'default', options: [{ value: 'auto', name: 'Auto' }],
              }] : [],
            } }
            if (sessionCount > 1 && delayRecoverySession) {
              pendingRecoverySession = response
              recoverySessionStarted()
            } else {
              send(response)
            }
          } else if (message.method === 'session/set_config_option') {
            send({ id: message.id, result: {} })
            if (sessionCount > 1 && stalePermissionOnRecovery) send({
              id: 101,
              method: 'session/request_permission',
              params: {
                sessionId: 'session-kimi',
                options: [
                  { optionId: 'approve_once', kind: 'allow_once' },
                  { optionId: 'approve_always', kind: 'allow_always' },
                ],
                toolCall: { toolCallId: 'stale-tool', title: 'Bash' },
              },
            })
          } else if (message.method === 'session/prompt') {
            promptRequest = message
            promptCount += 1
            if ((skillStall || skillEarlyEnd) && promptCount === 1) {
              queueMicrotask(() => {
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Loading Skill.' } } } })
                if (nonSkillToolBeforeSkill) {
                  send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:bash-before-skill', title: 'Bash', kind: 'execute', status: 'completed', rawInput: { command: 'touch marker' } } } })
                }
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:skill-1', title: skillTitle, status: 'in_progress', rawInput: { skill: 'understand-owmini-module' } } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: '1:skill-1', status: 'completed' } } })
                terminal()
                if (skillPartialThenStall) {
                  send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial.' } } } })
                }
                if (skillEarlyEnd) send({ id: message.id, result: { stopReason: 'end_turn' } })
              })
            } else if (skillStall || skillEarlyEnd) {
              if (skillRecoveryEmptyAfterTool) {
                queueMicrotask(() => {
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '2:read-only', title: 'Read', kind: 'read', status: 'in_progress' } } })
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: '2:read-only', status: 'completed' } } })
                  send({ id: message.id, result: { stopReason: 'end_turn' } })
                })
              } else if (skillRecoverySlowAfterTool) {
                queueMicrotask(() => {
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '2:read-skill', title: 'Read', kind: 'read', status: 'in_progress' } } })
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: '2:read-skill', status: 'completed' } } })
                })
                setTimeout(() => {
                  if (terminated > 0) return
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Slow recovered answer.␞' } } } })
                  send({ id: message.id, result: { stopReason: 'end_turn' } })
                }, 25)
              } else if (!skillRecoveryStall) queueMicrotask(() => {
                if (!skillRecoveryEmpty) send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer.␞' } } } })
                send({ id: message.id, result: { stopReason: 'end_turn' } })
              })
            } else if (prematureToolEnd) {
              queueMicrotask(() => {
                if (promptCount === 1) {
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:premature-tool', title: 'Read', kind: 'read', status: 'completed' } } })
                  const draftText = prematureMarkerBeforeText
                    ? 'Draft␞Still inspecting.'
                    : prematureMarkerBeforeTool ? 'Draft␞' : 'Still inspecting.'
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: draftText } } } })
                  if (prematureMarkerBeforeTool) {
                    send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:after-marker-tool', title: 'Grep', kind: 'search', status: 'completed' } } })
                  }
                  terminal()
                } else {
                  send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finalizationWhitespaceOnly ? '\n␞' : finalizationOmitsMarker ? 'Final requested answer.' : 'Final requested answer.␞' } } } })
                }
                send({ id: message.id, result: { stopReason: 'end_turn' } })
              })
            } else {
              queueMicrotask(() => {
                send({ id: 99, method: 'session/request_permission', params: { sessionId: promptRequest.params.sessionId, options: [
                  { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
                  { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ], toolCall: { toolCallId: '1:tool-1', title: 'Bash' } } })
                send({ id: 100, method: 'session/request_permission', params: { sessionId: promptRequest.params.sessionId, options: [
                  { optionId: 'answer_a', name: 'Answer A', kind: 'allow_once' },
                  { optionId: 'dismiss', name: 'Dismiss', kind: 'reject_once' },
                ], toolCall: { toolCallId: '1:question-1', title: 'Ask user' } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect files.' } } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:tool-1', title: '统计项目文件夹数量', kind: 'execute', status: 'in_progress', rawInput: { command: 'find . -type d' } } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: '1:tool-1', status: 'completed' } } })
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '␞' } } } })
                terminal()
              })
            }
          } else if (message.method === 'session/cancel') {
            if (skillLateCompleteOnCancel) {
              send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final answer.␞' } } } })
              if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'end_turn' } })
            } else {
              if (skillLateMessageOnCancel) {
                send({ method: 'session/update', params: { sessionId: promptRequest.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Late partial.' } } } })
              }
              if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'cancelled' } })
            }
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
        async waitForExit(signal) {
          if (!signal) { await done; return true }
          return Promise.race([
            done.then(() => true),
            new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true })),
          ])
        },
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
    usage() { return { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 } },
    close() { bridgeCloses += 1 },
  }
  const deps = {
    subprocess,
    skillContinuationTimeoutMs,
    sessionFlushTimeoutMs,
    sandbox: { confine(argv) { return { argv, enforcement: 'full' } } },
    policyFor: () => ({ mode: 'danger-full-access' }),
    authorize() {},
    cliManager: {
      managedRoot: '/managed/dsh-ally',
      async resolve() { return '/bin/kimi' },
    },
    bridge: { async open(...args) { bridgeOpens.push(args); return bridgeRoute } },
    stateDir: '/managed-state',
    async makeDirectory(path, options) { createdDirectories.push({ path, options }) },
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
    parent: { session: { id: 'session-1', header: { cwd: '/workspace', agentPreset: 'harness-ally' } } },
    prompt: [{ type: 'text', text: 'do work' }],
    provider: 'provider',
    model: 'model',
    reasoningEffort: 'high',
    signal: controller.signal,
    ...(nativeSession ? { nativeSession } : {}),
  }
  return {
    deps, request, messages, spawns, terminalGate, recoverySessionGate, controller, bridgeOpens, createdDirectories,
    completeRecoverySession() {
      if (!pendingRecoverySession) return
      spawns[0].handle.send(pendingRecoverySession)
      pendingRecoverySession = undefined
    },
    emitOldSessionNoiseDuringRecovery() {
      spawns[0].handle.send({
        id: 102,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-kimi',
          options: [{ optionId: 'approve_once', kind: 'allow_once' }],
          toolCall: { toolCallId: 'stale-gap-tool', title: 'Bash' },
        },
      })
      spawns[0].handle.send({
        method: 'session/update',
        params: {
          sessionId: 'session-kimi',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_OLD_SESSION' } },
        },
      })
    },
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
    { type: 'activity', id: '1:tool-1', name: 'Bash', summary: '统计项目文件夹数量', status: 'completed' },
  ])
  assert.deepEqual(result, {
    output: [{ type: 'text', text: 'Hello' }],
    stopReason: 'completed',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 },
  })
  assert.deepEqual(f.spawns[0].spec.argv, ['/bin/kimi', 'acp'])
  assert.equal(f.spawns[0].spec.argv.join(' ').includes('do work'), false)
  assert.equal(f.spawns[0].spec.argv.join(' ').includes('route-token'), false)
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_NAME, 'model')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_API_KEY, 'route-token')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_PROVIDER_TYPE, 'anthropic')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_BASE_URL, 'http://127.0.0.1:9999/claude/route')
  assert.equal(f.spawns[0].spec.env.KIMI_MODEL_THINKING_EFFORT, 'high')
  assert.equal(f.spawns[0].spec.env.KIMI_CODE_HOME, '/tmp/dsh-ally-kimi-test')
  assert.equal(f.bridgeOpens[0][2].sessionId, 'session-1')
  assert.deepEqual(f.messages.filter((message) => message.method).map((message) => message.method), [
    'initialize', 'session/new', 'session/set_config_option', 'session/prompt',
  ])
  assert.equal(f.messages[0].params.clientInfo.version, '0.12.0')
  assert.deepEqual(f.messages[0].params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false })
  assert.deepEqual(f.messages[2].params, { sessionId: 'session-kimi', configId: 'mode', value: 'auto' })
  assert.match(f.messages[3].params.prompt[0].text, /^do work\n\nKIMI CODE REPOSITORY SKILL POLICY/)
  assert.match(f.messages[3].params.prompt[0].text, /Do not invoke the native Skill tool/)
  assert.match(f.messages[3].params.prompt[0].text, /End every complete final answer with the exact marker ␞/)
  assert.deepEqual(f.messages.find((message) => message.id === 99 && !message.method)?.result, {
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  })
  assert.deepEqual(f.messages.find((message) => message.id === 100 && !message.method)?.result, {
    outcome: { outcome: 'cancelled' },
  })
  assert.equal(f.spawns[0].handle.terminated, 0)
  assert.equal(f.bridgeCloses, 1)
  assert.equal(f.homeRemovals, 1)
})

test('Kimi bounds graceful session flushing and discards a stuck native session', async () => {
  let discards = 0
  const nativeSession = {
    mode: 'fresh',
    prompt: 'do work',
    adopt() {},
    async discard() { discards += 1 },
  }
  const f = fixture({ ignoreGracefulExit: true, sessionFlushTimeoutMs: 1, nativeSession })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  f.spawns[0].handle.complete()
  assert.equal((await run.result).stopReason, 'completed')
  await run.dispose()
  assert.equal(f.spawns[0].handle.terminated, 1)
  assert.equal(discards, 1)
})

test('Kimi resumes a durable ACP session with only the incremental prompt', async () => {
  const adopted = []
  const nativeSession = {
    mode: 'resume',
    vendorId: 'session-kimi-old',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() { throw new Error('unexpected fallback') },
  }
  const f = fixture({ nativeSession, loadReplay: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output[0].text, 'Hello')
  assert.deepEqual(f.messages.filter((message) => message.method).map((message) => message.method), [
    'initialize', 'session/load', 'session/set_config_option', 'session/prompt',
  ])
  assert.deepEqual(f.messages[1].params, { sessionId: 'session-kimi-old', cwd: '/workspace', mcpServers: [] })
  assert.match(f.messages.find((message) => message.method === 'session/prompt').params.prompt[0].text, /^USER\ncontinue\n\nKIMI CODE REPOSITORY SKILL POLICY/)
  assert.deepEqual(adopted, ['session-kimi-old'])
  assert.deepEqual(f.messages.find((message) => message.id === 103 && !message.method)?.result, {
    outcome: { outcome: 'cancelled' },
  })
  assert.equal(f.spawns[0].spec.env.KIMI_CODE_HOME, '/managed-state/native/kimi')
  assert.equal(f.homeRemovals, 0)
})

test('Kimi rolls over when the ACP server does not advertise session resume', async () => {
  let fallbacks = 0
  const adopted = []
  const nativeSession = {
    mode: 'resume',
    vendorId: 'session-kimi-old',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() {
      fallbacks += 1
      this.mode = 'fresh'
      this.vendorId = undefined
      this.prompt = 'FULL CANONICAL HISTORY'
    },
  }
  const f = fixture({ nativeSession, resumeAdvertised: false })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  f.spawns[0].handle.complete()
  await run.result
  await run.dispose()

  assert.equal(fallbacks, 1)
  assert.equal(f.messages.some((message) => message.method === 'session/load'), false)
  assert.match(f.messages.find((message) => message.method === 'session/prompt').params.prompt[0].text, /^FULL CANONICAL HISTORY/)
  assert.deepEqual(adopted, ['session-kimi'])
})

test('Kimi replaces an invalid resume with one fresh durable ACP session', async () => {
  const adopted = []
  const nativeSession = {
    mode: 'resume',
    vendorId: 'session-kimi-missing',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() {
      this.mode = 'fresh'
      this.vendorId = undefined
      this.prompt = 'FULL CANONICAL HISTORY'
    },
  }
  const f = fixture({ nativeSession, resumeFails: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(f.messages.filter((message) => message.method).map((message) => message.method), [
    'initialize', 'session/load', 'session/new', 'session/set_config_option', 'session/prompt',
  ])
  assert.match(f.messages[4].params.prompt[0].text, /^FULL CANONICAL HISTORY\n\nKIMI CODE REPOSITORY SKILL POLICY/)
  assert.deepEqual(adopted, ['session-kimi'])
  assert.equal(f.homeRemovals, 0)
})

test('Kimi finalizes a tool turn when end_turn omits the completion marker', async () => {
  const f = fixture({ prematureToolEnd: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate

  const [events, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output[0].text, 'Still inspecting.Final requested answer.')
  assert.equal(events.some((event) => event.type === 'text-delta' && event.text.includes('␞')), false)
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
  assert.match(f.messages.filter((message) => message.method === 'session/prompt')[1].params.prompt[0].text, /complete final answer/)
})

for (const [name, option] of [
  ['visible text follows the marker', 'prematureMarkerBeforeText'],
  ['a tool follows the marker', 'prematureMarkerBeforeTool'],
]) {
  test(`Kimi finalizes when ${name}`, async () => {
    const f = fixture({ prematureToolEnd: true, [option]: true })
    const run = await startKimiAcpRun(f.deps, f.request)
    await f.terminalGate

    const result = await run.result
    await run.dispose()

    assert.equal(result.stopReason, 'completed')
    assert.match(result.output[0].text, /Final requested answer\./)
    assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
  })
}

test('Kimi reports an error when the bounded finalization still omits its marker', async () => {
  const f = fixture({ prematureToolEnd: true, finalizationOmitsMarker: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'Kimi Code 最终回答缺失')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi rejects a marked finalization that adds only whitespace', async () => {
  const f = fixture({ prematureToolEnd: true, finalizationWhitespaceOnly: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'Kimi Code 最终回答缺失')
})

test('Kimi cancels one stalled post-Skill request and adopts the fresh ACP recovery session', async () => {
  const adopted = []
  const nativeSession = {
    mode: 'fresh',
    prompt: 'do work',
    adopt(id) { adopted.push(id) },
    async fallback() { throw new Error('unexpected fallback') },
  }
  const f = fixture({ skillStall: true, skillContinuationTimeoutMs: 10, nativeSession })
  const run = await startKimiAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate

  const outcome = await Promise.race([
    run.result,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
  ])
  if (outcome === 'timeout') f.controller.abort()
  await run.dispose()
  const events = await eventPromise

  assert.notEqual(outcome, 'timeout')
  assert.deepEqual(outcome, {
    output: [{ type: 'text', text: 'Loading Skill.Recovered answer.' }],
    stopReason: 'completed',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 },
  })
  assert.equal(events.some((event) => event.type === 'activity' && event.name === 'Skill' && event.status === 'completed'), true)
  assert.equal(events.some((event) => event.type === 'reasoning-delta' && event.text.includes('正在恢复')), true)
  assert.deepEqual(f.messages.filter((message) => message.method?.startsWith('session/')).map((message) => message.method), [
    'session/new',
    'session/set_config_option',
    'session/prompt',
    'session/cancel',
    'session/new',
    'session/set_config_option',
    'session/prompt',
  ])
  assert.match(f.messages.filter((message) => message.method === 'session/prompt')[1].params.prompt[0].text, /\.agents\/skills\/understand-owmini-module\/SKILL\.md/)
  assert.deepEqual(adopted, ['session-kimi', 'session-kimi-recovery'])
  assert.equal(f.homeRemovals, 0)
  assert.equal(f.spawns[0].handle.terminated, 0)
})

test('Kimi rolls a resumed Skill recovery onto full canonical history', async () => {
  const adopted = []
  let fallbacks = 0
  const nativeSession = {
    mode: 'resume',
    vendorId: 'session-kimi-old',
    prompt: 'USER\ncontinue',
    adopt(id) { adopted.push(id) },
    async fallback() {
      fallbacks += 1
      this.mode = 'fresh'
      this.vendorId = undefined
      this.prompt = 'FULL CANONICAL HISTORY'
    },
  }
  const f = fixture({ skillStall: true, skillContinuationTimeoutMs: 10, nativeSession })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  const result = await run.result
  await run.dispose()

  const prompts = f.messages.filter((message) => message.method === 'session/prompt')
  assert.equal(result.stopReason, 'completed')
  assert.equal(fallbacks, 1)
  assert.match(prompts[0].params.prompt[0].text, /^USER\ncontinue/)
  assert.match(prompts[1].params.prompt[0].text, /^FULL CANONICAL HISTORY/)
  assert.deepEqual(adopted, ['session-kimi-old', 'session-kimi'])
})

test('Kimi disarms the Skill watchdog after fresh recovery completes a native tool', async () => {
  const f = fixture({ skillStall: true, skillRecoverySlowAfterTool: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.match(result.output[0].text, /Slow recovered answer/)
  assert.equal(f.messages.filter((message) => message.method === 'session/cancel').length, 1)
})

test('Kimi never accepts tool-only fresh recovery as the requested answer', async () => {
  const f = fixture({ skillStall: true, skillRecoveryEmptyAfterTool: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /Skill 后续响应超时或缺失/)
  assert.equal(f.messages.filter((message) => message.method === 'session/cancel').length, 1)
})

test('Kimi rejects stale permission requests from the cancelled Skill session', async () => {
  const f = fixture({ skillStall: true, stalePermissionOnRecovery: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await new Promise((resolve) => setImmediate(resolve))
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(f.messages.find((message) => message.id === 101 && !message.method)?.result, {
    outcome: { outcome: 'cancelled' },
  })
})

test('Kimi detaches the cancelled session while fresh recovery creation is pending', async () => {
  const f = fixture({ skillStall: true, delayRecoverySession: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  await f.recoverySessionGate

  f.emitOldSessionNoiseDuringRecovery()
  f.completeRecoverySession()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.doesNotMatch(result.output[0].text, /STALE_OLD_SESSION/)
  assert.deepEqual(f.messages.find((message) => message.id === 102 && !message.method)?.result, {
    outcome: { outcome: 'cancelled' },
  })
})

test('user abort while recovery session creation is pending never sends its prompt', async () => {
  const f = fixture({ skillStall: true, delayRecoverySession: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate
  await f.recoverySessionGate

  f.controller.abort()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 1)
})

test('Kimi never starts a fresh recovery session after a non-Skill tool may have side effects', async () => {
  const f = fixture({ skillStall: true, nonSkillToolBeforeSkill: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(f.messages.filter((message) => message.method === 'session/new').length, 1)
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi keeps the watchdog active when a post-Skill answer starts and then stalls', async () => {
  const f = fixture({ skillStall: true, skillPartialThenStall: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const outcome = await Promise.race([
    run.result,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
  ])
  if (outcome === 'timeout') f.controller.abort()
  await run.dispose()

  assert.notEqual(outcome, 'timeout')
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.output[0].text, 'Loading Skill.Partial.Recovered answer.')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi accepts a complete answer that wins the Skill cancellation race without retrying', async () => {
  const f = fixture({ skillStall: true, skillLateCompleteOnCancel: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output[0].text, 'Loading Skill.Final answer.')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 1)
})

test('Kimi still recovers when a cancelled stalled request emits a late partial answer', async () => {
  const f = fixture({ skillStall: true, skillLateMessageOnCancel: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.deepEqual(result, {
    output: [{ type: 'text', text: 'Loading Skill.Late partial.Recovered answer.' }],
    stopReason: 'completed',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 },
  })
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi retries an end_turn that follows a completed Skill without a subsequent answer', async () => {
  const f = fixture({ skillEarlyEnd: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.deepEqual(result, {
    output: [{ type: 'text', text: 'Loading Skill.Recovered answer.' }],
    stopReason: 'completed',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 },
  })
  assert.deepEqual(f.messages.filter((message) => message.method?.startsWith('session/')).map((message) => message.method), [
    'session/new',
    'session/set_config_option',
    'session/prompt',
    'session/prompt',
  ])
})

test('Kimi recognizes a completed Skill from structured input when its display title changes', async () => {
  const f = fixture({ skillEarlyEnd: true, skillTitle: 'Load project guidance' })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output[0].text, 'Loading Skill.Recovered answer.')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi reports an explicit error after the single Skill recovery also returns no answer', async () => {
  const f = fixture({ skillEarlyEnd: true, skillRecoveryEmpty: true })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.deepEqual(result, {
    output: [{ type: 'text', text: 'Loading Skill.' }],
    stopReason: 'error',
    diagnostic: 'Kimi Code Skill 后续响应超时或缺失',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5 },
  })
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
})

test('Kimi times out a stalled Skill recovery once without starting a third prompt', async () => {
  const f = fixture({ skillStall: true, skillRecoveryStall: true, skillContinuationTimeoutMs: 10 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'Kimi Code Skill 后续响应超时或缺失')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 2)
  assert.equal(f.messages.filter((message) => message.method === 'session/cancel').length, 2)
})

test('Kimi ACP continues without forcing auto mode when the server does not advertise it', async () => {
  const f = fixture({ modeAdvertised: false })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  f.spawns[0].handle.complete()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(f.messages.filter((message) => message.method?.startsWith('session/')).map((message) => message.method), [
    'session/new', 'session/prompt',
  ])
})

test('user cancellation during the Skill continuation window never starts recovery', async () => {
  const f = fixture({ skillStall: true, skillContinuationTimeoutMs: 1000 })
  const run = await startKimiAcpRun(f.deps, f.request)
  await f.terminalGate

  f.controller.abort()
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.messages.filter((message) => message.method === 'session/prompt').length, 1)
  assert.equal(f.messages.filter((message) => message.method === 'session/cancel').length, 1)
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
