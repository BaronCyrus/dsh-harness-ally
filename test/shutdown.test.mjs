import assert from 'node:assert/strict'
import test from 'node:test'

import { closeAlliance } from '../lib/index.js'

test('Host teardown always closes bridge and state when one run disposal fails', async () => {
  const calls = []
  const runtime = { async shutdown() { calls.push('runtime'); throw new Error('dispose failed') } }
  const bridge = { async close() { calls.push('bridge') } }
  const state = { async close() { calls.push('state') } }
  const cliManager = { async close() { calls.push('cli-manager') } }

  await assert.rejects(closeAlliance({ runtime, bridge, state, cliManager }), /dispose failed/)
  assert.deepEqual(calls.sort(), ['bridge', 'cli-manager', 'runtime', 'state'])
})
