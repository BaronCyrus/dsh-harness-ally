import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { createCliManager } from '../lib/cli-manager.js'

function fixture({ globals = {}, installOk = true } = {}) {
  const managedRoot = '/managed/dsh-ally'
  const managed = new Set()
  const spawns = []
  const resolves = []
  const binName = (name) => process.platform === 'win32' ? `${name}.cmd` : name
  const managedPath = (harness, name) => join(managedRoot, harness, 'node_modules', '.bin', binName(name))
  const subprocess = {
    async resolveExecutable(command) {
      resolves.push(command)
      if (command === 'npm') return '/usr/bin/npm'
      if (globals[command]) return globals[command]
      if (managed.has(command)) return command
      throw new Error(`missing ${command}`)
    },
    spawn(spec) {
      spawns.push(spec)
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      queueMicrotask(() => {
        if (installOk) {
          const packageName = spec.argv.at(-1)
          if (packageName.startsWith('@anthropic-ai/claude-code@')) managed.add(managedPath('claude-code', 'claude'))
          if (packageName.startsWith('@openai/codex@')) managed.add(managedPath('codex', 'codex'))
        }
        settle({ exitCode: installOk ? 0 : 1, signal: null })
      })
      return {
        pid: 123,
        done,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        terminate() {},
        async waitForExit() { await done; return true },
      }
    },
  }
  const manager = createCliManager({ subprocess, managedRoot, mkdir: async () => {}, rm: async () => {} })
  return { manager, managedRoot, managedPath, managed, spawns, resolves }
}

test('CLI status detects global first, then DSH-managed, then missing', async () => {
  const f = fixture({ globals: { claude: '/usr/local/bin/claude' } })
  f.managed.add(f.managedPath('claude-code', 'claude'))

  const status = await f.manager.status()

  assert.deepEqual(status, {
    'claude-code': { available: true, source: 'global', installing: false },
    codex: { available: false, source: 'missing', installing: false },
  })
  assert.equal(await f.manager.resolve('claude-code'), '/usr/local/bin/claude')
})

test('managed CLI is resolved when no global executable exists', async () => {
  const f = fixture()
  f.managed.add(f.managedPath('codex', 'codex'))

  assert.deepEqual((await f.manager.status()).codex, { available: true, source: 'managed', installing: false })
  assert.equal(await f.manager.resolve('codex'), f.managedPath('codex', 'codex'))
})

test('install writes only to the DSH-managed prefix and becomes immediately resolvable', async () => {
  const f = fixture()

  const installed = await f.manager.install('codex')

  assert.deepEqual(installed, { available: true, source: 'managed', installing: false })
  assert.equal(f.spawns.length, 1)
  assert.deepEqual(f.spawns[0].argv, [
    '/usr/bin/npm', 'install', '--prefix', join(f.managedRoot, 'codex'),
    '--no-audit', '--no-fund', '--save-exact',
    '--registry=https://registry.npmjs.org', '@openai/codex@latest',
  ])
  assert.equal(f.spawns[0].cwd, join(f.managedRoot, 'codex'))
  assert.equal(await f.manager.resolve('codex'), f.managedPath('codex', 'codex'))
})

test('install is idempotent for global CLIs and coalesces concurrent managed installs', async () => {
  const global = fixture({ globals: { claude: '/opt/bin/claude' } })
  assert.deepEqual(await global.manager.install('claude-code'), { available: true, source: 'global', installing: false })
  assert.equal(global.spawns.length, 0)

  const managed = fixture()
  const [first, second] = await Promise.all([
    managed.manager.install('claude-code'),
    managed.manager.install('claude-code'),
  ])
  assert.deepEqual(first, { available: true, source: 'managed', installing: false })
  assert.deepEqual(second, first)
  assert.equal(managed.spawns.length, 1)
})

test('failed or unsupported installs fail without exposing npm output', async () => {
  const failed = fixture({ installOk: false })
  await assert.rejects(failed.manager.install('codex'), /Codex CLI 安装失败/)
  await assert.rejects(failed.manager.install('unknown'), /不支持的 Harness/)
})
