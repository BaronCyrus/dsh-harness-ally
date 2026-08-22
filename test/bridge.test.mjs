import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createModelBridge } from '../lib/bridge.js'

function fixture(chunks) {
  const calls = []
  const bridge = createModelBridge({
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* () {
          yield* chunks
        })()
      },
    },
  })
  return { bridge, calls }
}

function sseData(text) {
  return text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
}

const textChunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'BRIDGE_OK' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'BRIDGE_OK' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('Claude bridge routes one native Messages request through the selected DSH provider/model', async () => {
  const f = fixture(textChunks)
  try {
    const route = await f.bridge.open('configured-provider', 'configured-model', {
      reasoningEffort: 'high', temperature: 0.3, maxTokens: 2048, stop: ['STOP'],
    })
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({
        model: 'configured-model',
        stream: true,
        system: 'system',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /content_block_delta/)
    assert.match(body, /BRIDGE_OK/)
    assert.equal(f.calls[0].provider, 'configured-provider')
    assert.equal(f.calls[0].model, 'configured-model')
    assert.equal(f.calls[0].reasoningEffort, 'high')
    assert.equal(f.calls[0].temperature, 0.3)
    assert.equal(f.calls[0].maxTokens, 2048)
    assert.deepEqual(f.calls[0].stop, ['STOP'])
    assert.equal(f.calls[0].messages[0].content[0].text, 'hello')
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('bridge request decoding preserves UTF-8 split across HTTP chunks', async () => {
  const f = fixture(textChunks)
  try {
    const route = await f.bridge.open('provider', 'model')
    const payload = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: '你' }] }))
    const character = Buffer.from('你')
    const offset = payload.indexOf(character)
    const responseBody = await new Promise((resolve, reject) => {
      const req = httpRequest(`${route.claudeBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': route.token, 'content-length': payload.length },
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk.toString('utf8') })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.flushHeaders()
      req.write(payload.subarray(0, offset + 1))
      setImmediate(() => req.end(payload.subarray(offset + 1)))
    })

    assert.match(responseBody, /message_stop/)
    assert.equal(f.calls[0].messages[0].content[0].text, '你')
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('Codex bridge exposes Responses SSE and rejects an invalid route token', async () => {
  const f = fixture(textChunks)
  try {
    const route = await f.bridge.open('custom-openai', 'custom-model')
    const denied = await fetch(`${route.codexBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: '{}',
    })
    assert.equal(denied.status, 401)

    const response = await fetch(`${route.codexBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
      body: JSON.stringify({
        model: 'custom-model',
        stream: true,
        instructions: 'system',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] }],
      }),
    })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /response\.output_text\.delta/)
    assert.match(body, /response\.completed/)
    const events = sseData(body)
    assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))
    const completed = events.find((event) => event.type === 'response.completed')
    assert.equal(completed.response.output[0].content[0].text, 'BRIDGE_OK')
    assert.equal(f.calls[0].provider, 'custom-openai')
    assert.equal(f.calls[0].messages[0].content[0].text, 'hello codex')
    route.close()
  } finally {
    await f.bridge.close()
  }
})
