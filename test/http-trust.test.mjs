import assert from 'node:assert/strict'
import test from 'node:test'

import { trustedMutation } from '../lib/index.js'

function request(host, origin = `http://${host}`) {
  return { headers: {
    host,
    origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  } }
}

test('selection mutation accepts the current loopback Web authority', () => {
  assert.equal(trustedMutation(request('127.0.0.1:3080')), true)
  assert.equal(trustedMutation(request('localhost:3080')), true)
})

test('selection mutation rejects DNS-rebinding and mismatched origins', () => {
  assert.equal(trustedMutation(request('attacker.example:3080')), false)
  assert.equal(trustedMutation(request('127.0.0.1:3080', 'http://127.0.0.1:9999')), false)
  assert.equal(trustedMutation({ headers: { ...request('127.0.0.1:3080').headers, 'sec-fetch-site': 'cross-site' } }), false)
})
