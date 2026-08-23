// Harness 联盟 Host adapter：把 session-scoped Harness 选择接入标准 Agent LLM
// waterfall。Agent 仍独占 turn/step；外部 CLI 只是可替换的模型执行 adapter。

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

import { createModelBridge } from './bridge.js'
import { createCliManager } from './cli-manager.js'
import { createHarnessGateway } from './harness.js'
import { createNativeSessionRegistry } from './native-session.js'
import { createAllianceRuntime, HARNESSES, isAllianceSession } from './runtime.js'
import { createAllianceState } from './state.js'
import { ALLY_VERSION } from './version.js'

export const name = 'ally'
export const inject = ['agents', 'llm', 'sandbox', 'sandboxPolicy', 'sessions', 'subagents', 'subprocess', 'webServer']

const ERROR_STATUS = Object.freeze({
  INVALID_HARNESS: 400,
  PRESET_REQUIRED: 403,
  SESSION_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 409,
  TURN_OPEN: 409,
  PROVIDER_UNAVAILABLE: 503,
})

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function loopbackAuthority(host) {
  if (!host) return undefined
  try {
    const authority = new URL(`http://${host}`)
    const hostname = authority.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    return loopback ? authority : undefined
  } catch {
    return undefined
  }
}

function trustedRead(req) {
  const authority = loopbackAuthority(req.headers.host)
  if (!authority || req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

export function trustedMutation(req) {
  if (!trustedRead(req) || req.headers['sec-fetch-site'] !== 'same-origin') return false
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false
  return Boolean(req.headers.origin)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let body = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 64 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      body += decoder.write(chunk)
    })
    req.on('end', () => {
      body += decoder.end()
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

function errorStatus(error) {
  if (error?.code === 'BODY_TOO_LARGE') return 413
  if (error?.code === 'INVALID_JSON') return 400
  return ERROR_STATUS[error?.code] ?? 500
}

async function loadAgentLoopGuard() {
  const entry = process.argv[1]
  if (!entry) throw new Error('无法定位 DSH 入口，拒绝启用 Harness LLM router')
  const requireFromDsh = createRequire(realpathSync(entry))
  const modulePath = requireFromDsh.resolve('@deepseek-ai/dsh-llm')
  const llmModule = await import(pathToFileURL(modulePath).href)
  if (typeof llmModule.isAgentLoopRequest !== 'function') {
    throw new Error('当前 DSH 未提供 isAgentLoopRequest，拒绝启用 Harness LLM router')
  }
  return llmModule.isAgentLoopRequest
}

export async function closeAlliance({ runtime, bridge, state, cliManager }) {
  const results = await Promise.allSettled([
    runtime ? runtime.shutdown() : Promise.resolve(),
    cliManager ? cliManager.close() : Promise.resolve(),
    bridge.close(),
    state.close(),
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

export async function apply(ctx) {
  const isAgentLoopRequest = await loadAgentLoopGuard()
  const authorize = (session) => {
    if (isAllianceSession(session)) return
    const error = new Error('只有 Harness联盟模式 会话可以委派外部 Harness')
    error.code = 'PRESET_REQUIRED'
    throw error
  }
  const state = await createAllianceState()
  const bridge = createModelBridge({ llm: ctx.llm })
  const cliManager = createCliManager({ subprocess: ctx.subprocess })
  const nativeSessions = createNativeSessionRegistry({ state, version: ALLY_VERSION })
  let runtime
  ctx.effect(() => () => closeAlliance({ runtime, bridge, state, cliManager }), 'ally.runtime')
  const gateway = createHarnessGateway({
    subprocess: ctx.subprocess,
    sandbox: ctx.sandbox,
    policyFor: (session) => ctx.sandboxPolicy.resolve({ session }),
    authorize,
    bridge,
    cliManager,
    nativeSessions,
    stateDir: state.dir,
  })
  for (const provider of gateway.providers) ctx.subagents.registerProvider(provider)

  runtime = createAllianceRuntime({
    sessions: ctx.sessions,
    agents: ctx.agents,
    gateway,
    state,
    isAgentLoopRequest,
  })
  ctx.on('llm/stream', (options, next) => runtime.route(options, next))

  const requireAllianceSession = (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error('会话不存在或当前未加载')
      error.code = 'SESSION_NOT_FOUND'
      throw error
    }
    authorize(session)
  }

  const routes = {
    'GET /ally/snapshot': async (req, res, url) => {
      if (!trustedRead(req)) return sendJson(res, 403, { error: '拒绝非可信请求' })
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      sendJson(res, 200, await runtime.snapshot(sessionId))
    },
    'POST /ally/select': async (req, res) => {
      if (!trustedMutation(req)) return sendJson(res, 403, { error: '拒绝非同源请求' })
      sendJson(res, 200, await runtime.select(await readJson(req)))
    },
    'GET /ally/cli-status': async (req, res, url) => {
      if (!trustedRead(req)) return sendJson(res, 403, { error: '拒绝非可信请求' })
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      await requireAllianceSession(sessionId)
      sendJson(res, 200, { harnesses: await cliManager.status() })
    },
    'POST /ally/cli-install': async (req, res) => {
      if (!trustedMutation(req)) return sendJson(res, 403, { error: '拒绝非同源请求' })
      const { sessionId, harness } = await readJson(req)
      if (typeof sessionId !== 'string' || !sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      if (harness === 'dsh' || !HARNESSES.includes(harness)) {
        return sendJson(res, 400, { error: '未知 Harness CLI' })
      }
      await requireAllianceSession(sessionId)
      await cliManager.install(harness)
      sendJson(res, 200, { harnesses: await cliManager.status() })
    },
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ally',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const route = routes[`${req.method} ${url.pathname}`]
        if (!route) return sendJson(res, 404, { error: 'unknown ally route' })
        try {
          await route(req, res, url)
        } catch (error) {
          ctx.logger.warn(`ally request failed: ${error instanceof Error ? error.message : String(error)}`)
          const status = errorStatus(error)
          sendJson(res, status, { error: status === 500 ? 'Harness 联盟服务失败' : error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'ally.webServer.register(/ally)',
  )
}
