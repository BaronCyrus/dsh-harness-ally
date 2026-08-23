import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNativeSessionRegistry } from '../lib/native-session.js'
import { createConversationView } from '../lib/runtime.js'
import { createAllianceState } from '../lib/state.js'

function completedRun(text = 'ok') {
  return {
    id: 'run-1',
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    async dispose() {},
  }
}

function parts(turn, overrides = {}) {
  return {
    sessionId: 'session-1',
    harness: 'codex',
    provider: 'provider-a',
    model: 'model-a',
    cwd: '/workspace',
    policyMode: 'workspace-write',
    workspaceRoot: '/workspace',
    promptSignature: 'system-a',
    turn,
    fullPrompt: `FULL-${turn}`,
    incrementalPrompt: `INCREMENTAL-${turn}`,
    ...overrides,
  }
}

async function runCompleted(registry, requestParts, vendorId, observe) {
  const run = await registry.start(requestParts, async (context) => {
    if (observe) await observe(context)
    context.adopt(vendorId)
    return completedRun()
  })
  await run.result
  await run.dispose()
}

test('consecutive successful turns resume one isolated native session with only incremental prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-session-'))
  const file = join(directory, 'state.json')
  try {
    const firstState = await createAllianceState({ file })
    const firstRegistry = createNativeSessionRegistry({ state: firstState, version: 'test-version', now: () => 10 })
    let firstContext
    const first = await firstRegistry.start(parts(1), async (context) => {
      firstContext = context
      context.adopt('vendor-1')
      return completedRun('first')
    })
    await first.result
    await first.dispose()
    await firstState.close()

    assert.equal(firstContext.mode, 'fresh')
    assert.equal(firstContext.prompt, 'FULL-1')

    const secondState = await createAllianceState({ file })
    const secondRegistry = createNativeSessionRegistry({ state: secondState, version: 'test-version', now: () => 20 })
    let secondContext
    const second = await secondRegistry.start(parts(2, {
      fullPrompt: 'FULL-1\n\nASSISTANT\nanswer\n\nUSER\nsecond',
      incrementalPrompt: 'USER\nsecond',
    }), async (context) => {
      secondContext = context
      context.adopt('vendor-1')
      return completedRun('second')
    })
    await second.result
    await second.dispose()
    await secondState.close()

    assert.equal(secondContext.mode, 'resume')
    assert.equal(secondContext.vendorId, 'vendor-1')
    assert.equal(secondContext.prompt, 'USER\nsecond')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a parked lane resumes across a restart and Harness gap with only its proven handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-parked-'))
  const file = join(directory, 'state.json')
  try {
    const firstState = await createAllianceState({ file })
    const firstRegistry = createNativeSessionRegistry({ state: firstState, version: 'test-version', now: () => 10 })
    await runCompleted(firstRegistry, parts(1, {
      conversation: {
        watermarkAfter: () => ({ messageCount: 2, digest: 'anchor-one' }),
        resumeFrom: () => undefined,
      },
    }), 'vendor-1')
    await firstState.close()

    const state = await createAllianceState({ file })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 20 })
    await runCompleted(registry, parts(3, {
      fullPrompt: 'FULL CANONICAL THROUGH TURN 3',
      incrementalPrompt: 'USER\ncurrent request',
      conversation: {
        watermarkAfter: () => ({ messageCount: 6, digest: 'anchor-three' }),
        resumeFrom(watermark) {
          assert.deepEqual(watermark, { messageCount: 2, digest: 'anchor-one' })
          return 'HARNESS HANDOFF\n\nTURN 2 HISTORY\n\nCURRENT REQUEST\n\nUSER\ncurrent request'
        },
      },
    }), 'vendor-1', (context) => {
      assert.equal(context.mode, 'resume')
      assert.equal(context.vendorId, 'vendor-1')
      assert.match(context.prompt, /^HARNESS HANDOFF/)
      assert.doesNotMatch(context.prompt, /FULL CANONICAL/)
    })
    const key = JSON.stringify(['session-1', 'codex', 'provider-a', 'model-a'])
    assert.deepEqual(state.resume(key).watermark, { messageCount: 6, digest: 'anchor-three' })
    assert.equal(state.resume(key).turns, 2)
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a parked lane rolls over when its canonical watermark cannot be proven', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-parked-mismatch-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1, {
      conversation: {
        watermarkAfter: () => ({ messageCount: 2, digest: 'anchor-one' }),
        resumeFrom: () => undefined,
      },
    }), 'vendor-1')
    await runCompleted(registry, parts(3, {
      fullPrompt: 'FULL AFTER COMPACTION',
      conversation: {
        watermarkAfter: () => ({ messageCount: 3, digest: 'replacement' }),
        resumeFrom: () => undefined,
      },
    }), 'vendor-2', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL AFTER COMPACTION')
    })
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Claude, Codex, and Kimi each resume their parked lane through one switch cycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-switch-cycle-'))
  const human = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const assistant = (text) => ({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] })
  const identities = {
    'claude-code': { provider: 'provider-claude', model: 'model-claude', vendorId: 'vendor-claude' },
    codex: { provider: 'provider-codex', model: 'model-codex', vendorId: 'vendor-codex' },
    'kimi-code': { provider: 'provider-kimi', model: 'model-kimi', vendorId: 'vendor-kimi' },
  }
  const transcript = []
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    const execute = async (harness, turn, userText, expectedMode, expectedHistory = []) => {
      transcript.push(human(userText))
      const identity = identities[harness]
      const conversation = createConversationView(transcript, {
        completedTurns: new Set(Array.from({ length: turn - 1 }, (_, index) => index + 1)),
      })
      await runCompleted(registry, parts(turn, {
        harness,
        provider: identity.provider,
        model: identity.model,
        promptSignature: `system-${harness}`,
        fullPrompt: `FULL-${harness}-${turn}`,
        incrementalPrompt: conversation.currentPrompt(),
        conversation,
      }), identity.vendorId, (context) => {
        assert.equal(context.mode, expectedMode)
        if (expectedMode === 'resume') {
          assert.match(context.prompt, /^HARNESS HANDOFF/)
          for (const text of expectedHistory) assert.match(context.prompt, new RegExp(text))
        }
      })
      transcript.push(assistant('ok'))
    }

    await execute('claude-code', 1, 'claude first', 'fresh')
    await execute('codex', 2, 'codex first', 'fresh')
    await execute('kimi-code', 3, 'kimi first', 'fresh')
    await execute('claude-code', 4, 'claude second', 'resume', ['codex first', 'kimi first'])
    await execute('codex', 5, 'codex second', 'resume', ['kimi first', 'claude second'])
    await execute('kimi-code', 6, 'kimi second', 'resume', ['claude second', 'codex second'])

    for (const [harness, identity] of Object.entries(identities)) {
      const key = JSON.stringify(['session-1', harness, identity.provider, identity.model])
      assert.equal(state.resume(key).vendorId, identity.vendorId)
      assert.equal(state.resume(key).turns, 2)
    }
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a completed vendor id is committed only after the native process is disposed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-clean-exit-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    const key = JSON.stringify(['session-1', 'codex', 'provider-a', 'model-a'])
    const run = await registry.start(parts(1), async (context) => {
      context.adopt('vendor-1')
      return completedRun()
    })
    assert.equal((await run.result).stopReason, 'completed')
    assert.equal(state.resume(key), undefined)
    await run.dispose()
    assert.equal(state.resume(key).vendorId, 'vendor-1')
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a completed run can discard an unflushed vendor session during disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-discard-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    const key = JSON.stringify(['session-1', 'codex', 'provider-a', 'model-a'])
    const run = await registry.start(parts(1), async (context) => {
      context.adopt('vendor-unflushed')
      return {
        ...completedRun(),
        async dispose() { await context.discard() },
      }
    })
    assert.equal((await run.result).stopReason, 'completed')
    await run.dispose()
    assert.equal(state.resume(key), undefined)
    const retry = await registry.start(parts(1), async (context) => {
      assert.equal(context.mode, 'fresh')
      return completedRun()
    })
    await retry.result
    await retry.dispose()
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid native resume falls back to the full canonical prompt and adopts the replacement session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-fallback-'))
  const file = join(directory, 'state.json')
  try {
    const state = await createAllianceState({ file })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')

    await runCompleted(registry, parts(2), 'vendor-2', async (context) => {
      assert.equal(context.mode, 'resume')
      assert.equal(context.vendorId, 'vendor-1')
      await context.fallback()
      assert.equal(context.mode, 'fresh')
      assert.equal(context.vendorId, undefined)
      assert.equal(context.prompt, 'FULL-2')
    })

    await runCompleted(registry, parts(3), 'vendor-2', (context) => {
      assert.equal(context.mode, 'resume')
      assert.equal(context.vendorId, 'vendor-2')
      assert.equal(context.prompt, 'INCREMENTAL-3')
    })
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('gaps, system changes, and model changes safely roll over to full canonical history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-rollover-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')
    await runCompleted(registry, parts(3), 'vendor-gap', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-3')
    })
    await runCompleted(registry, parts(4, { promptSignature: 'system-b' }), 'vendor-system', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-4')
    })
    await runCompleted(registry, parts(5, { model: 'model-b' }), 'vendor-model', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-5')
    })
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('session, Harness, provider, and model each isolate native resume lanes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-isolation-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    const variants = [
      parts(1),
      parts(1, { sessionId: 'session-2' }),
      parts(1, { harness: 'kimi-code' }),
      parts(1, { provider: 'provider-b' }),
      parts(1, { model: 'model-b' }),
    ]
    for (let index = 0; index < variants.length; index += 1) {
      await runCompleted(registry, variants[index], `vendor-${index}`, (context) => assert.equal(context.mode, 'fresh'))
    }
    for (let index = 0; index < variants.length; index += 1) {
      await runCompleted(registry, { ...variants[index], turn: 2 }, `vendor-${index}`, (context) => {
        assert.equal(context.mode, 'resume')
        assert.equal(context.vendorId, `vendor-${index}`)
      })
    }
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('turn-count rollover starts fresh with the complete canonical transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-turn-limit-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', maxTurns: 2, now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')
    await runCompleted(registry, parts(2), 'vendor-1', (context) => assert.equal(context.mode, 'resume'))
    await runCompleted(registry, parts(3), 'vendor-2', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-3')
    })
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed resumed turn poisons that vendor session and forces a fresh next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-poison-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')
    const failed = await registry.start(parts(2), async (context) => {
      assert.equal(context.mode, 'resume')
      context.adopt('vendor-1')
      return {
        id: 'failed-run',
        result: Promise.resolve({ output: [], stopReason: 'error' }),
        async dispose() {},
      }
    })
    assert.equal((await failed.result).stopReason, 'error')
    await failed.dispose()
    await runCompleted(registry, parts(3), 'vendor-2', (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-3')
    })
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a resumed starter failure quarantines the lane before releasing singleflight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-start-failure-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')
    await assert.rejects(registry.start(parts(2), async (context) => {
      assert.equal(context.mode, 'resume')
      throw new Error('turn/start failed')
    }), /turn\/start failed/)
    const retry = await registry.start(parts(2), async (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-2')
      return completedRun()
    })
    await retry.result
    await retry.dispose()
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('singleflight holds one native lane until the prior run is disposed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-singleflight-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    let resolveFirst
    let secondStarted = false
    const first = await registry.start(parts(1), async (context) => {
      context.adopt('vendor-1')
      return {
        id: 'first-run',
        result: new Promise((resolve) => { resolveFirst = () => resolve({ output: [], stopReason: 'completed' }) }),
        async dispose() {},
      }
    })
    const secondPromise = registry.start(parts(2), async (context) => {
      secondStarted = true
      assert.equal(context.mode, 'resume')
      context.adopt('vendor-1')
      return completedRun()
    })
    await Promise.resolve()
    assert.equal(secondStarted, false)
    resolveFirst()
    await first.result
    await Promise.resolve()
    assert.equal(secondStarted, false)
    await first.dispose()
    const second = await secondPromise
    assert.equal(secondStarted, true)
    await second.result
    await second.dispose()
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a durable consume claim prevents handoff replay after a success commit failure and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-consume-claim-'))
  const file = join(directory, 'state.json')
  let writes = 0
  try {
    const state = await createAllianceState({
      file,
      async writer(path, snapshot) {
        writes += 1
        // Fresh commit, durable consume claim, then the resumed final commit.
        if (writes === 3) throw new Error('disk full after prompt consumption')
        await writeFile(path, JSON.stringify(snapshot))
      },
    })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    const key = JSON.stringify(['session-1', 'codex', 'provider-a', 'model-a'])
    await runCompleted(registry, parts(1), 'vendor-1')
    await runCompleted(registry, parts(2), 'vendor-1', (context) => {
      assert.equal(context.mode, 'resume')
      assert.equal(state.resume(key).vendorId, null)
    })
    await state.close()

    const restoredState = await createAllianceState({ file })
    assert.equal(restoredState.resume(key).vendorId, null)
    const restoredRegistry = createNativeSessionRegistry({ state: restoredState, version: 'test-version', now: () => 20 })
    const retry = await restoredRegistry.start(parts(3), async (context) => {
      assert.equal(context.mode, 'fresh')
      assert.equal(context.prompt, 'FULL-3')
      context.adopt('vendor-2')
      return completedRun()
    })
    await retry.result
    await retry.dispose()
    await restoredState.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed durable consume claim forces fresh and quarantines the stale lane in memory', async () => {
  let failWrites = false
  const state = await createAllianceState({
    file: '/unused/native-session-state.json',
    async writer() {
      if (failWrites) throw new Error('disk full')
    },
  })
  const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
  await runCompleted(registry, parts(1), 'vendor-1')
  failWrites = true
  const failed = await registry.start(parts(2), async (context) => {
    assert.equal(context.mode, 'fresh')
    assert.equal(context.prompt, 'FULL-2')
    return { id: 'failed', result: Promise.resolve({ output: [], stopReason: 'error' }), async dispose() {} }
  })
  await failed.result
  await failed.dispose()
  const retry = await registry.start(parts(2), async (context) => {
    assert.equal(context.mode, 'fresh')
    assert.equal(context.prompt, 'FULL-2')
    return completedRun()
  })
  await retry.result
  await retry.dispose()
  await state.close()
})

test('stale invalid-resume recovery cannot overwrite a newer CAS record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-native-cas-'))
  try {
    const state = await createAllianceState({ file: join(directory, 'state.json') })
    const registry = createNativeSessionRegistry({ state, version: 'test-version', now: () => 10 })
    await runCompleted(registry, parts(1), 'vendor-1')
    const key = JSON.stringify(['session-1', 'codex', 'provider-a', 'model-a'])
    await runCompleted(registry, parts(2), 'vendor-stale', async (context) => {
      const current = state.resume(key)
      await state.compareAndSetResume(key, current.revision, {
        ...current,
        vendorId: 'vendor-newer',
        throughTurn: 2,
        updatedAt: 20,
      })
      await context.fallback()
    })
    assert.equal(state.resume(key).vendorId, 'vendor-newer')
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
