import { rm as remove, mkdir as makeDirectory } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTALL_GRACE_MS = 5000
const OUTPUT_LIMIT = 64 * 1024

const SPECS = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    command: 'claude',
    package: '@anthropic-ai/claude-code@latest',
  }),
  codex: Object.freeze({
    label: 'Codex',
    command: 'codex',
    package: '@openai/codex@latest',
  }),
  'kimi-code': Object.freeze({
    label: 'Kimi Code',
    command: 'kimi',
    package: '@moonshot-ai/kimi-code@latest',
  }),
})

function defaultManagedRoot() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'tools', 'dsh-ally')
}

function binaryName(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

export function createCliManager({
  subprocess,
  managedRoot = defaultManagedRoot(),
  mkdir = makeDirectory,
  rm = remove,
} = {}) {
  if (!subprocess) throw new Error('CLI manager requires subprocess')
  const installs = new Map()
  const controllers = new Map()
  let closed = false

  const specFor = (harness) => {
    const spec = SPECS[harness]
    if (!spec) throw new Error(`不支持的 Harness：${String(harness)}`)
    return spec
  }
  const prefixFor = (harness) => join(managedRoot, harness)
  const pathFor = (harness) => {
    const spec = specFor(harness)
    return join(prefixFor(harness), 'node_modules', '.bin', binaryName(spec.command))
  }
  const resolveGlobal = async (harness) => subprocess.resolveExecutable(specFor(harness).command)
  const resolveManaged = async (harness) => subprocess.resolveExecutable(pathFor(harness))

  async function inspect(harness) {
    specFor(harness)
    try {
      await resolveGlobal(harness)
      return { available: true, source: 'global', installing: false }
    } catch {}
    if (installs.has(harness)) return { available: false, source: 'missing', installing: true }
    try {
      await resolveManaged(harness)
      return { available: true, source: 'managed', installing: false }
    } catch {
      return { available: false, source: 'missing', installing: false }
    }
  }

  async function resolve(harness) {
    specFor(harness)
    const active = installs.get(harness)
    if (active) await active
    try {
      return await resolveGlobal(harness)
    } catch {}
    try {
      return await resolveManaged(harness)
    } catch {
      const error = new Error(`${specFor(harness).label} CLI 未安装`)
      error.code = 'CLI_NOT_INSTALLED'
      throw error
    }
  }

  async function performInstall(harness) {
    const spec = specFor(harness)
    const prefix = prefixFor(harness)
    const controller = new AbortController()
    controllers.set(harness, controller)
    try {
      await rm(prefix, { recursive: true, force: true })
      await mkdir(prefix, { recursive: true, mode: 0o700 })
      const npm = await subprocess.resolveExecutable('npm', undefined, controller.signal)
      const child = subprocess.spawn({
        argv: [
          npm, 'install', '--prefix', prefix,
          '--no-audit', '--no-fund', '--save-exact',
          '--registry=https://registry.npmjs.org',
          spec.package,
        ],
        cwd: prefix,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_LIMIT },
          stderr: { maxBytes: OUTPUT_LIMIT },
        },
        graceMs: INSTALL_GRACE_MS,
        signal: controller.signal,
        env: { NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
      })
      const outcome = await child.done
      if (controller.signal.aborted) throw new Error(`${spec.label} CLI 安装已取消`)
      if (outcome.exitCode !== 0) throw new Error(`${spec.label} CLI 安装失败`)
      await resolveManaged(harness)
      return { available: true, source: 'managed', installing: false }
    } catch (error) {
      await rm(prefix, { recursive: true, force: true }).catch(() => {})
      if (error instanceof Error && /安装(?:失败|已取消)/.test(error.message)) throw error
      throw new Error(`${spec.label} CLI 安装失败`)
    } finally {
      controllers.delete(harness)
    }
  }

  async function install(harness) {
    specFor(harness)
    if (closed) throw new Error('CLI manager 已关闭')
    const active = installs.get(harness)
    if (active) return active
    const existing = await inspect(harness)
    if (existing.available) return existing
    const raced = installs.get(harness)
    if (raced) return raced
    const attempt = performInstall(harness).finally(() => installs.delete(harness))
    installs.set(harness, attempt)
    return attempt
  }

  async function status() {
    const [claude, codex, kimi] = await Promise.all([
      inspect('claude-code'),
      inspect('codex'),
      inspect('kimi-code'),
    ])
    return { 'claude-code': claude, codex, 'kimi-code': kimi }
  }

  async function close() {
    if (closed) return
    closed = true
    for (const controller of controllers.values()) controller.abort()
    await Promise.allSettled(installs.values())
  }

  return { status, resolve, install, close, managedRoot }
}
