import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createModelBridge } from '../lib/bridge.js'

function fixture(chunks) {
  const calls = []
  const bridge = createModelBridge({
    llm: {
      stream(options) {
        const streamChunks = typeof chunks === 'function' ? chunks(calls.length) : chunks
        calls.push(options)
        return (async function* () {
          yield* streamChunks
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
  { type: 'usage', usage: {
    inputTokens: 12, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 5, reasoningTokens: 3,
  } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('Claude bridge routes one native Messages request through the selected DSH provider/model', async () => {
  const f = fixture(textChunks)
  try {
    const route = await f.bridge.open('configured-provider', 'configured-model', {
      reasoningEffort: 'high', temperature: 0.3, maxTokens: 2048, stop: ['STOP'], sessionId: 'dsh-session-1',
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
    assert.equal(f.calls[0].sessionId, 'dsh-session-1')
    assert.equal(f.calls[0].messages[0].content[0].text, 'hello')
    const delta = sseData(body).find((event) => event.type === 'message_delta')
    assert.deepEqual(delta.usage, {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 5,
    })
    assert.deepEqual(route.usage(), {
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
      contextInputTokens: 107,
      contextOutputTokens: 7,
    })
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('bridge accumulates billing across calls while context usage follows only the latest call', async () => {
  const f = fixture((callIndex) => textChunks.map((chunk) => chunk.type === 'usage'
    ? { ...chunk, usage: callIndex === 0
      ? chunk.usage
      : { inputTokens: 20, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 6, reasoningTokens: 4 } }
    : chunk))
  try {
    const route = await f.bridge.open('provider', 'model', { sessionId: 'session-aggregate' })
    for (const prompt of ['first', 'second']) {
      const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': route.token },
        body: JSON.stringify({ model: 'model', stream: true, messages: [{ role: 'user', content: prompt }] }),
      })
      await response.text()
    }

    assert.deepEqual(route.usage(), {
      inputTokens: 32,
      outputTokens: 16,
      cacheReadTokens: 190,
      cacheWriteTokens: 11,
      reasoningTokens: 7,
      contextInputTokens: 126,
      contextOutputTokens: 9,
    })
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('bridge ignores invalid explicit context samples and derives the latest valid buckets', async () => {
  const chunks = [
    { type: 'usage', usage: {
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
      contextInputTokens: -1,
      contextOutputTokens: Number.NaN,
    } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture(chunks)
  try {
    const route = await f.bridge.open('provider', 'model')
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({ model: 'model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    await response.text()

    assert.equal(route.usage().contextInputTokens, 107)
    assert.equal(route.usage().contextOutputTokens, 7)
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('bridge derives context pressure only from validated usage buckets', async () => {
  const chunks = [
    { type: 'usage', usage: {
      inputTokens: Number.NaN,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
    } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture(chunks)
  try {
    const route = await f.bridge.open('provider', 'model')
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({ model: 'model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    await response.text()

    assert.equal(route.usage().inputTokens, 0)
    assert.equal(route.usage().contextInputTokens, 95)
    route.close()
  } finally {
    await f.bridge.close()
  }
})

test('bridge preserves explicitly reported zero-valued cache buckets', async () => {
  const chunks = [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const f = fixture(chunks)
  try {
    const route = await f.bridge.open('provider', 'model')
    const response = await fetch(`${route.claudeBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': route.token },
      body: JSON.stringify({ model: 'model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    await response.text()

    assert.deepEqual(route.usage(), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      contextInputTokens: 0,
      contextOutputTokens: 0,
    })
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
    assert.deepEqual(completed.response.usage, {
      input_tokens: 107,
      input_tokens_details: { cached_tokens: 90 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 114,
    })
    assert.deepEqual(route.usage(), {
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
      contextInputTokens: 107,
      contextOutputTokens: 7,
    })
    assert.equal(f.calls[0].provider, 'custom-openai')
    assert.equal(f.calls[0].messages[0].content[0].text, 'hello codex')
    route.close()
  } finally {
    await f.bridge.close()
  }
})
