import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAllianceState } from '../lib/state.js'

test('Harness selection and turn dispatch metadata persist outside Session logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-'))
  const file = join(directory, 'state.json')
  try {
    const first = await createAllianceState({ file })
    await first.setHarness('session-1', 'codex')
    await first.recordDispatch('session-1', {
      turn: 2, step: 1, runId: 'run-1', harness: 'codex', provider: 'configured', model: 'model-a',
    })
    await first.close()

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.sessions['session-1'].harness, 'codex')

    const restored = await createAllianceState({ file })
    assert.equal(restored.harness('session-1'), 'codex')
    assert.deepEqual(restored.dispatches('session-1'), [{
      turn: 2, step: 1, runId: 'run-1', harness: 'codex', provider: 'configured', model: 'model-a',
    }])
    await restored.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('dispatch replacement keeps one authoritative badge per turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-'))
  const file = join(directory, 'state.json')
  try {
    const state = await createAllianceState({ file })
    await state.recordDispatch('session-1', { turn: 1, harness: 'codex', model: 'old', started: false })
    await state.recordDispatch('session-1', { turn: 1, harness: 'claude-code', model: 'new', started: true })

    assert.deepEqual(state.dispatches('session-1'), [{
      turn: 1, harness: 'claude-code', model: 'new', started: true,
    }])
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
