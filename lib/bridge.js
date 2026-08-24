import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import { createReasoningCodec } from './reasoning-codec.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024

export function openModelBridgeRoute(bridge, request, sessionId) {
  if (!bridge || !request.provider || !request.model) return undefined
  return bridge.open(request.provider, request.model, {
    reasoningEffort: request.reasoningEffort,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    stop: request.stop,
    sessionId,
  })
}

export function attachBridgeUsage(route, result) {
  const usage = route?.usage?.()
  return usage ? { ...result, usage } : result
}

function createUsageTracker() {
  const seen = new Set()
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let contextInputTokens
  let contextOutputTokens
  return {
    record(usage) {
      if (!usage || typeof usage !== 'object') return
      const latest = {}
      for (const key of Object.keys(totals)) {
        const value = usage[key]
        if (!Number.isFinite(value) || value < 0) continue
        totals[key] += value
        seen.add(key)
        latest[key] = value
      }
      if (Object.keys(latest).length === 0) return
      contextInputTokens = Number.isFinite(usage.contextInputTokens) && usage.contextInputTokens >= 0
        ? usage.contextInputTokens
        : (latest.inputTokens ?? 0) + (latest.cacheReadTokens ?? 0) + (latest.cacheWriteTokens ?? 0)
      contextOutputTokens = Number.isFinite(usage.contextOutputTokens) && usage.contextOutputTokens >= 0
        ? usage.contextOutputTokens
        : latest.outputTokens ?? 0
    },
    snapshot() {
      if (seen.size === 0) return undefined
      return {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        ...(seen.has('cacheReadTokens') ? { cacheReadTokens: totals.cacheReadTokens } : {}),
        ...(seen.has('cacheWriteTokens') ? { cacheWriteTokens: totals.cacheWriteTokens } : {}),
        ...(seen.has('reasoningTokens') ? { reasoningTokens: totals.reasoningTokens } : {}),
        contextInputTokens,
        contextOutputTokens,
      }
    },
  }
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function message(role, content, source) {
  return { id: `ally-bridge-${randomUUID()}`, role, content, source }
}

function claudeMessages(body, route) {
  const messages = []
  for (const item of body.messages ?? []) {
    const blocks = []
    const values = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content ?? []
    for (const block of values) {
      if (block?.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
      else if (block?.type === 'tool_use') blocks.push({
        type: 'tool-call',
        id: String(block.id),
        name: String(block.name),
        arguments: JSON.stringify(block.input ?? {}),
      })
      else if (block?.type === 'tool_result') blocks.push({
        type: 'tool-result',
        toolCallId: String(block.tool_use_id),
        content: [{ type: 'text', text: textOf(block.content) }],
        isError: Boolean(block.is_error),
      })
    }
    if (!blocks.length) continue
    const source = item.role === 'assistant'
      ? { kind: 'model', provider: route.provider, model: route.model }
      : blocks.length === 1 && blocks[0].type === 'tool-result'
        ? { kind: 'tool', callId: blocks[0].toolCallId }
        : { kind: 'user' }
    messages.push(message(item.role === 'assistant' ? 'assistant' : 'user', blocks, source))
  }
  return messages
}

function codexMessages(body, route) {
  const messages = []
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []
  let assistantBlocks = []
  const flushAssistant = () => {
    if (!assistantBlocks.length) return
    messages.push(message('assistant', assistantBlocks, { kind: 'model', provider: route.provider, model: route.model }))
    assistantBlocks = []
  }
  for (const item of input) {
    if (item?.type === 'reasoning') {
      flushAssistant()
      assistantBlocks.push({ type: 'reasoning', text: route.reasoning.open(item.encrypted_content) })
      continue
    }
    if (item?.type === 'function_call') {
      assistantBlocks.push({
        type: 'tool-call',
        id: String(item.call_id ?? item.id),
        name: String(item.name),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      })
      continue
    }
    if (item?.type === 'function_call_output') {
      flushAssistant()
      const callId = String(item.call_id)
      messages.push(message('user', [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: textOf(item.output) }],
      }], { kind: 'tool', callId }))
      continue
    }
    const values = typeof item?.content === 'string' ? [{ text: item.content }] : item?.content ?? []
    const text = values.map((part) => part?.text ?? part?.input_text ?? part?.output_text ?? '').filter(Boolean).join('\n')
    if (!text) continue
    if (item.role === 'assistant') {
      assistantBlocks.push({ type: 'text', text })
    } else {
      flushAssistant()
      messages.push(message('user', [{ type: 'text', text }], { kind: 'user' }))
    }
  }
  flushAssistant()
  return messages
}

function claudeTools(body) {
  return (body.tools ?? []).filter((tool) => tool?.name).map((tool) => ({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object' },
  }))
}

function codexTools(body) {
  return (body.tools ?? []).filter((tool) => tool?.type === 'function' && tool.name).map((tool) => ({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object' },
  }))
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function readBody(req) {
  const decoder = new StringDecoder('utf8')
  let text = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large')
    text += decoder.write(chunk)
  }
  text += decoder.end()
  return text ? JSON.parse(text) : {}
}

function authorized(req, route) {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const apiKey = String(req.headers['x-api-key'] ?? '')
  return bearer === route.token || apiKey === route.token
}

function streamOptions(route, body, protocol, signal) {
  const isClaude = protocol === 'claude'
  return {
    provider: route.provider,
    model: route.model,
    system: isClaude ? textOf(body.system) : String(body.instructions ?? ''),
    messages: isClaude ? claudeMessages(body, route) : codexMessages(body, route),
    tools: isClaude ? claudeTools(body) : codexTools(body),
    maxTokens: route.config.maxTokens ?? (Number.isFinite(body.max_tokens) ? body.max_tokens : undefined),
    reasoningEffort: route.config.reasoningEffort,
    temperature: route.config.temperature,
    stop: route.config.stop,
    sessionId: route.config.sessionId,
    signal,
  }
}

async function serveClaude(llm, route, body, req, res, controllers) {
  const controller = new AbortController()
  controllers.add(controller)
  req.once('aborted', () => controller.abort())
  res.once('close', () => {
    controllers.delete(controller)
    if (!res.writableEnded) controller.abort()
  })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  // DSH reports usage at the stream tail, so keep startup streaming and repeat the complete aggregate in message_delta.
  sendSse(res, 'message_start', { type: 'message_start', message: {
    id: messageId, type: 'message', role: 'assistant', model: route.model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  } })
  const protocolIndexes = new Map()
  const toolBlocks = new Set()
  let nextIndex = 0
  let finishKind = 'stop'
  let usage = { input_tokens: 0, output_tokens: 0 }
  const protocolIndex = (index) => {
    if (!protocolIndexes.has(index)) protocolIndexes.set(index, nextIndex++)
    return protocolIndexes.get(index)
  }
  for await (const chunk of llm.stream(streamOptions(route, body, 'claude', controller.signal))) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      const index = protocolIndex(chunk.index)
      sendSse(res, 'content_block_start', {
        type: 'content_block_start', index, content_block: { type: 'text', text: '' },
      })
    } else if (chunk.type === 'text-delta') {
      const index = protocolIndex(chunk.index)
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk.text } })
    } else if (chunk.type === 'tool-call-delta') {
      const index = protocolIndex(chunk.index)
      if (!toolBlocks.has(chunk.index)) {
        toolBlocks.add(chunk.index)
        sendSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: {
          type: 'tool_use', id: chunk.id, name: chunk.name ?? 'tool', input: {},
        } })
      }
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: {
        type: 'input_json_delta', partial_json: chunk.argumentsDelta,
      } })
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'tool-call')) {
      const index = protocolIndex(chunk.index)
      if (chunk.block.type === 'tool-call' && !toolBlocks.has(chunk.index)) {
        toolBlocks.add(chunk.index)
        sendSse(res, 'content_block_start', { type: 'content_block_start', index, content_block: {
          type: 'tool_use', id: chunk.block.id, name: chunk.block.name, input: {},
        } })
        sendSse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: {
          type: 'input_json_delta', partial_json: chunk.block.arguments,
        } })
      }
      sendSse(res, 'content_block_stop', { type: 'content_block_stop', index })
    } else if (chunk.type === 'usage') {
      route.recordUsage(chunk.usage)
      usage = {
        input_tokens: chunk.usage.inputTokens ?? 0,
        output_tokens: chunk.usage.outputTokens ?? 0,
        ...(chunk.usage.cacheReadTokens !== undefined
          ? { cache_read_input_tokens: chunk.usage.cacheReadTokens }
          : {}),
        ...(chunk.usage.cacheWriteTokens !== undefined
          ? { cache_creation_input_tokens: chunk.usage.cacheWriteTokens }
          : {}),
      }
    } else if (chunk.type === 'finish') {
      finishKind = chunk.reason.kind
      if (finishKind === 'error' || finishKind === 'aborted') {
        sendSse(res, 'error', { type: 'error', error: { type: 'api_error', message: chunk.reason.failure.message } })
        res.end()
        return
      }
    }
  }
  const stopReason = finishKind === 'tool-calls' ? 'tool_use' : finishKind === 'max-tokens' ? 'max_tokens' : 'end_turn'
  sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
  sendSse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

async function serveCodex(llm, route, body, req, res, controllers) {
  const controller = new AbortController()
  controllers.add(controller)
  req.once('aborted', () => controller.abort())
  res.once('close', () => {
    controllers.delete(controller)
    if (!res.writableEnded) controller.abort()
  })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`
  const response = { id: responseId, object: 'response', status: 'in_progress', model: route.model, output: [] }
  let sequenceNumber = 0
  res.allyResponseId = responseId
  res.allyNextSequence = () => sequenceNumber++
  const emit = (event, data) => sendSse(res, event, { ...data, sequence_number: res.allyNextSequence() })
  emit('response.created', { type: 'response.created', response })
  const itemIds = new Map()
  const outputIndexes = new Map()
  const announcedTools = new Set()
  const announcedReasoning = new Set()
  const outputByIndex = new Map()
  res.allyFailedResponse = () => ({
    ...response,
    status: 'failed',
    output: [...outputByIndex.entries()].sort(([left], [right]) => left - right).map(([, item]) => item),
    error: { code: 'bridge_error', message: 'model bridge failed' },
  })
  let nextOutputIndex = 0
  let finishKind = 'stop'
  let usage
  const outputIndex = (index) => {
    if (!outputIndexes.has(index)) outputIndexes.set(index, nextOutputIndex++)
    return outputIndexes.get(index)
  }
  for await (const chunk of llm.stream(streamOptions(route, body, 'codex', controller.signal))) {
    if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
      const itemId = `rs_${randomUUID().replaceAll('-', '')}`
      const index = outputIndex(chunk.index)
      itemIds.set(chunk.index, itemId)
      announcedReasoning.add(chunk.index)
      emit('response.output_item.added', { type: 'response.output_item.added', output_index: index,
        item: { id: itemId, type: 'reasoning', summary: [], status: 'in_progress' } })
    } else if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      const itemId = `item_${randomUUID().replaceAll('-', '')}`
      const index = outputIndex(chunk.index)
      itemIds.set(chunk.index, itemId)
      emit('response.output_item.added', { type: 'response.output_item.added', output_index: index,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
      emit('response.content_part.added', {
        type: 'response.content_part.added', item_id: itemId, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    } else if (chunk.type === 'text-delta') {
      const index = outputIndex(chunk.index)
      emit('response.output_text.delta', {
        type: 'response.output_text.delta', item_id: itemIds.get(chunk.index), output_index: index, content_index: 0, delta: chunk.text,
      })
    } else if (chunk.type === 'tool-call-delta') {
      const index = outputIndex(chunk.index)
      const itemId = itemIds.get(chunk.index) ?? `item_${randomUUID().replaceAll('-', '')}`
      itemIds.set(chunk.index, itemId)
      if (!announcedTools.has(chunk.index)) {
        announcedTools.add(chunk.index)
        emit('response.output_item.added', { type: 'response.output_item.added', output_index: index,
          item: { id: itemId, type: 'function_call', call_id: chunk.id, name: chunk.name ?? 'tool', arguments: '', status: 'in_progress' } })
      }
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: itemId, output_index: index, delta: chunk.argumentsDelta,
      })
    } else if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
      const index = outputIndex(chunk.index)
      const itemId = itemIds.get(chunk.index) ?? `rs_${randomUUID().replaceAll('-', '')}`
      itemIds.set(chunk.index, itemId)
      if (!announcedReasoning.has(chunk.index)) emit('response.output_item.added', {
        type: 'response.output_item.added', output_index: index,
        item: { id: itemId, type: 'reasoning', summary: [], status: 'in_progress' },
      })
      announcedReasoning.add(chunk.index)
      const item = {
        id: itemId,
        type: 'reasoning',
        summary: [],
        encrypted_content: route.reasoning.seal(chunk.block.text),
        status: 'completed',
      }
      outputByIndex.set(index, item)
      emit('response.output_item.done', { type: 'response.output_item.done', output_index: index, item })
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'tool-call')) {
      const block = chunk.block
      const index = outputIndex(chunk.index)
      const itemId = itemIds.get(chunk.index) ?? `item_${randomUUID().replaceAll('-', '')}`
      itemIds.set(chunk.index, itemId)
      let item
      if (block.type === 'text') {
        const part = { type: 'output_text', text: block.text, annotations: [] }
        emit('response.output_text.done', {
          type: 'response.output_text.done', item_id: itemId, output_index: index, content_index: 0, text: block.text,
        })
        emit('response.content_part.done', {
          type: 'response.content_part.done', item_id: itemId, output_index: index, content_index: 0, part,
        })
        item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] }
      } else {
        if (!announcedTools.has(chunk.index)) emit('response.output_item.added', {
          type: 'response.output_item.added', output_index: index,
          item: { id: itemId, type: 'function_call', call_id: block.id, name: block.name, arguments: '', status: 'in_progress' },
        })
        emit('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done', item_id: itemId, output_index: index, arguments: block.arguments,
        })
        item = { id: itemId, type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments, status: 'completed' }
      }
      outputByIndex.set(index, item)
      emit('response.output_item.done', { type: 'response.output_item.done', output_index: index, item })
    } else if (chunk.type === 'usage') {
      route.recordUsage(chunk.usage)
      const inputTokens = (chunk.usage.inputTokens ?? 0) + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
      const outputTokens = chunk.usage.outputTokens ?? 0
      usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: chunk.usage.cacheReadTokens ?? 0 },
        output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: chunk.usage.reasoningTokens ?? 0 },
        total_tokens: inputTokens + outputTokens }
    } else if (chunk.type === 'finish') {
      finishKind = chunk.reason.kind
      if (finishKind === 'error' || finishKind === 'aborted') {
        emit('response.failed', { type: 'response.failed', response: {
          ...response, status: 'failed', output: [...outputByIndex.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
          error: { code: chunk.reason.failure.code, message: chunk.reason.failure.message },
        } })
        res.end()
        return
      }
    }
  }
  const output = [...outputByIndex.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
  if (finishKind === 'max-tokens') {
    emit('response.incomplete', { type: 'response.incomplete', response: {
      ...response, status: 'incomplete', output, usage, incomplete_details: { reason: 'max_output_tokens' },
    } })
  } else {
    emit('response.completed', { type: 'response.completed', response: { ...response, status: 'completed', output, usage } })
  }
  res.end()
}

export function createModelBridge({ llm, stateDir }) {
  const routes = new Map()
  const controllers = new Set()
  const reasoning = createReasoningCodec({ stateDir })
  const server = createServer(async (req, res) => {
    let protocol
    try {
      if (req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      protocol = parts[0]
      const route = routes.get(parts[1])
      const pathToken = protocol === 'claude' && parts[2] === route?.token
      if (!route || (!pathToken && !authorized(req, route))) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
        return
      }
      const body = await readBody(req)
      if (protocol === 'claude' && parts.at(-1) === 'messages') await serveClaude(llm, route, body, req, res, controllers)
      else if (protocol === 'codex' && parts.at(-1) === 'responses') await serveCodex(llm, route, body, req, res, controllers)
      else res.writeHead(404).end()
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"model bridge failed"}')
      } else if (!res.writableEnded && protocol === 'claude') {
        sendSse(res, 'error', { type: 'error', error: { type: 'api_error', message: 'model bridge failed' } })
        res.end()
      } else if (!res.writableEnded && protocol === 'codex') {
        const responseId = res.allyResponseId ?? `resp_${randomUUID().replaceAll('-', '')}`
        const sequenceNumber = typeof res.allyNextSequence === 'function' ? res.allyNextSequence() : 0
        const response = typeof res.allyFailedResponse === 'function' ? res.allyFailedResponse() : {
          id: responseId, object: 'response', status: 'failed', output: [], error: { code: 'bridge_error', message: 'model bridge failed' },
        }
        sendSse(res, 'response.failed', { type: 'response.failed', sequence_number: sequenceNumber, response })
        res.end()
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  return {
    async open(provider, model, config = {}) {
      const port = await ready
      const id = randomUUID()
      const token = randomUUID()
      const usage = createUsageTracker()
      routes.set(id, { provider, model, config, token, reasoning: await reasoning, recordUsage: usage.record })
      let closed = false
      return {
        token,
        claudeBaseUrl: `http://127.0.0.1:${port}/claude/${id}`,
        codexBaseUrl: `http://127.0.0.1:${port}/codex/${id}/v1`,
        usage: usage.snapshot,
        close() {
          if (closed) return
          closed = true
          routes.delete(id)
        },
      }
    },
    async close() {
      routes.clear()
      for (const controller of controllers) controller.abort()
      controllers.clear()
      const closed = new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await closed
    },
  }
}
