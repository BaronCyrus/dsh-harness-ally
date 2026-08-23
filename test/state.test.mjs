import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAllianceState } from '../lib/state.js'

test('Harness selection and turn dispatch metadata persist outside Session logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-'))
  const file = join(directory, 'state.json')
  try {
    const first = await createAllianceState({ file })
    await first.setHarness('session-1', 'kimi-code')
    await first.recordDispatch('session-1', {
      turn: 2, step: 1, runId: 'run-1', harness: 'kimi-code', provider: 'configured', model: 'model-a',
    })
    await first.close()

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 3)
    assert.equal(raw.sessions['session-1'].harness, 'kimi-code')
    assert.deepEqual(raw.resumes, {})

    const restored = await createAllianceState({ file })
    assert.equal(restored.harness('session-1'), 'kimi-code')
    assert.deepEqual(restored.dispatches('session-1'), [{
      turn: 2, step: 1, runId: 'run-1', harness: 'kimi-code', provider: 'configured', model: 'model-a',
    }])
    await restored.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('state v2 lazily migrates resume records to v3 canonical watermarks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-v3-'))
  const file = join(directory, 'state.json')
  try {
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: { 'session-1': { harness: 'claude-code', dispatches: [] } },
      resumes: {
        lane: {
          revision: 1,
          vendorId: 'vendor-old',
          fingerprint: 'fingerprint',
          throughTurn: 2,
          turns: 2,
          updatedAt: 10,
        },
      },
    }))
    const state = await createAllianceState({ file })
    assert.equal(state.resume('lane').watermark, undefined)
    const upgraded = await state.compareAndSetResume('lane', 1, {
      vendorId: 'vendor-old',
      fingerprint: 'fingerprint',
      throughTurn: 3,
      turns: 3,
      updatedAt: 20,
      watermark: { messageCount: 6, digest: 'abc123' },
    })
    assert.deepEqual(upgraded.watermark, { messageCount: 6, digest: 'abc123' })
    await state.close()

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 3)
    assert.deepEqual(raw.resumes.lane.watermark, { messageCount: 6, digest: 'abc123' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native session records use CAS and retain only the newest 200 lanes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-state-resume-'))
  const file = join(directory, 'state.json')
  try {
    const state = await createAllianceState({ file })
    for (let index = 0; index < 205; index += 1) {
      const record = await state.compareAndSetResume(`lane-${index}`, 0, {
        vendorId: `vendor-${index}`,
        fingerprint: 'fingerprint',
        throughTurn: 1,
        turns: 1,
        updatedAt: index,
      })
      assert.equal(record.revision, 1)
    }
    assert.equal(state.resume('lane-0'), undefined)
    assert.equal(state.resume('lane-4'), undefined)
    assert.equal(state.resume('lane-5').vendorId, 'vendor-5')
    assert.equal(await state.compareAndSetResume('lane-5', 0, {
      vendorId: 'stale', fingerprint: 'fingerprint', throughTurn: 2, turns: 2, updatedAt: 300,
    }), undefined)
    await state.close()

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(Object.keys(raw.resumes).length, 200)
    assert.equal(raw.resumes['lane-204'].vendorId, 'vendor-204')
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
