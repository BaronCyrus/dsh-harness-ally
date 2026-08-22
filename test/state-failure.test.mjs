import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAllianceState } from '../lib/state.js'

test('failed persistence keeps committed memory unchanged and later writes recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-failure-'))
  const file = join(directory, 'missing.json')
  let attempts = 0
  const snapshots = []
  try {
    const state = await createAllianceState({
      file,
      async writer(_file, snapshot) {
        attempts += 1
        if (attempts === 1) throw new Error('disk full')
        snapshots.push(snapshot)
      },
    })

    await assert.rejects(state.setHarness('session-1', 'codex'), /disk full/)
    assert.equal(state.harness('session-1'), 'dsh')

    await state.setHarness('session-1', 'claude-code')
    assert.equal(state.harness('session-1'), 'claude-code')
    assert.equal(snapshots[0].sessions['session-1'].harness, 'claude-code')
    await state.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
