import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createModelBridge } from '../lib/bridge.js'

function events(text) {
  return text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
}

async function codexResponse(route, input) {
  const response = await fetch(`${route.codexBaseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
    body: JSON.stringify({ stream: true, input }),
  })
  const body = await response.text()
  return { body, data: events(body) }
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

test('Responses bridge round-trips private reasoning across a tool call without exposing it', async () => {
  const calls = []
  const bridge = createModelBridge({ llm: { stream(options) {
    calls.push(options)
    return (async function* () {
      if (calls.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'text-delta', index: 1, text: 'CHECKING' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'CHECKING' } }
        yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })()
  } } })
  try {
    const route = await bridge.open('provider', 'model', { reasoningEffort: 'high' })
    const first = await codexResponse(route, 'inspect')
    const completed = first.data.find((event) => event.type === 'response.completed').response

    assert.equal(first.body.includes('PRIVATE_REASONING'), false)
    assert.deepEqual(completed.output.map((item) => item.type), ['reasoning', 'message', 'function_call'])
    assert.equal(completed.output[0].summary.length, 0)
    assert.match(completed.output[0].encrypted_content, /^dsh-ally\.reasoning\.v1\./)
    assert.equal(completed.output[1].content[0].text, 'CHECKING')

    await codexResponse(route, [
      { role: 'user', content: 'inspect' },
      ...completed.output,
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    ])
    const assistant = calls[1].messages.find((item) => item.role === 'assistant')
    assert.deepEqual(assistant.content.map((block) => block.type), ['reasoning', 'text', 'tool-call'])
    assert.equal(assistant.content[0].text, 'PRIVATE_REASONING')
    assert.equal(assistant.content[2].id, 'call-1')
    route.close()
  } finally {
    await bridge.close()
  }
})

test('Responses reasoning replay survives a bridge restart without persisting plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ally-reasoning-'))
  let replayOutput
  try {
    const firstBridge = createModelBridge({
      stateDir: directory,
      llm: { stream() { return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'RESTART_PRIVATE_REASONING' } }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-restart', name: 'read_file', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })() } },
    })
    try {
      const route = await firstBridge.open('provider', 'model', { reasoningEffort: 'high' })
      const first = await codexResponse(route, 'inspect')
      replayOutput = first.data.find((event) => event.type === 'response.completed').response.output
      route.close()
    } finally {
      await firstBridge.close()
    }

    const calls = []
    const secondBridge = createModelBridge({
      stateDir: directory,
      llm: { stream(options) {
        calls.push(options)
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      } },
    })
    try {
      const route = await secondBridge.open('provider', 'model', { reasoningEffort: 'high' })
      await codexResponse(route, [
        { role: 'user', content: 'inspect' },
        ...replayOutput,
        { type: 'function_call_output', call_id: 'call-restart', output: 'ok' },
      ])
      assert.equal(calls[0].messages.find((item) => item.role === 'assistant').content[0].text, 'RESTART_PRIVATE_REASONING')
      route.close()
    } finally {
      await secondBridge.close()
    }

    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const keyPath = join(directory, files[0])
    assert.equal((await readFile(keyPath)).includes(Buffer.from('RESTART_PRIVATE_REASONING')), false)
    if (process.platform !== 'win32') assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Responses bridge fails closed for invalid opaque reasoning', async () => {
  let calls = 0
  const bridge = createModelBridge({ llm: { stream() {
    calls += 1
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  } } })
  try {
    const route = await bridge.open('provider', 'model', { reasoningEffort: 'high' })
    const response = await codexResponse(route, [
      { role: 'user', content: 'inspect' },
      { id: 'rs-invalid', type: 'reasoning', summary: [], encrypted_content: 'dsh-ally.reasoning.v1.invalid', status: 'completed' },
      { id: 'call-invalid', type: 'function_call', call_id: 'call-invalid', name: 'read_file', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call-invalid', output: 'ok' },
    ])
    assert.equal(response.data.at(-1).type, 'response.failed')
    assert.equal(response.body.includes('PRIVATE_REASONING'), false)
    assert.equal(calls, 0)
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
