import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelBridge } from '../lib/bridge.js'

function events(text) {
  return text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
}

const reasoningThenText = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'VISIBLE' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'VISIBLE' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

function bridgeFor(chunks) {
  return createModelBridge({ llm: { stream() { return (async function* () { yield* chunks })() } } })
}

test('Responses bridge hides reasoning blocks and compacts output indexes', async () => {
  const bridge = bridgeFor(reasoningThenText)
  try {
    const route = await bridge.open('provider', 'model')
    const response = await fetch(`${route.codexBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
      body: JSON.stringify({ stream: true, input: 'hello' }),
    })
    const body = await response.text()
    const data = events(body)
    const added = data.find((event) => event.type === 'response.output_item.added')
    const completed = data.find((event) => event.type === 'response.completed')

    assert.equal(body.includes('PRIVATE_REASONING'), false)
    assert.equal(added.output_index, 0)
    assert.equal(completed.response.output[0].content[0].text, 'VISIBLE')
    route.close()
  } finally {
    await bridge.close()
  }
})

test('post-header model failures use protocol-native terminal SSE events', async () => {
  const bridge = createModelBridge({ llm: { stream() { return (async function* () { throw new Error('boom') })() } } })
  try {
    const route = await bridge.open('provider', 'model')
    const [claude, codex] = await Promise.all([
      fetch(`${route.claudeBaseUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': route.token },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }),
      }).then((response) => response.text()),
      fetch(`${route.codexBaseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
        body: JSON.stringify({ stream: true, input: 'hello' }),
      }).then((response) => response.text()),
    ])

    assert.equal(events(claude).at(-1).type, 'error')
    assert.equal(events(codex).at(-1).type, 'response.failed')
    assert.equal(claude.includes('{"error":"model bridge failed"}'), false)
    assert.equal(codex.includes('{"error":"model bridge failed"}'), false)
    route.close()
  } finally {
    await bridge.close()
  }
})

test('Messages bridge preserves tool arguments from block-end-only streams', async () => {
  const bridge = bridgeFor([
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  try {
    const route = await bridge.open('provider', 'model')
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'read' }] }),
    })
    const data = events(await response.text())
    const delta = data.find((event) => event.type === 'content_block_delta')

    assert.equal(delta.delta.partial_json, '{"path":"README.md"}')
    assert.equal(data.find((event) => event.type === 'message_delta').delta.stop_reason, 'tool_use')
    route.close()
  } finally {
    await bridge.close()
  }
})

test('Messages bridge maps max-token finishes without exposing reasoning', async () => {
  const chunks = reasoningThenText.map((chunk) => chunk.type === 'finish'
    ? { type: 'finish', reason: { kind: 'max-tokens' } }
    : chunk)
  const bridge = bridgeFor(chunks)
  try {
    const route = await bridge.open('provider', 'model')
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    const body = await response.text()
    const delta = events(body).find((event) => event.type === 'message_delta')

    assert.equal(body.includes('PRIVATE_REASONING'), false)
    assert.equal(delta.delta.stop_reason, 'max_tokens')
    route.close()
  } finally {
    await bridge.close()
  }
})
