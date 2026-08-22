import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('installer links one fixed harness-ally preset into the Web Profile idempotently', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ally-install-'))
  const presetRoot = join(dshHome, '.agent-presets', 'harness-ally')
  const setupDir = join(presetRoot, 'setup')
  const profileDir = join(dshHome, 'profiles', 'web')
  await mkdir(setupDir, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await copyFile(join(ROOT, 'setup', 'install.mjs'), join(setupDir, 'install.mjs'))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'fixture-web-profile',
    private: true,
    dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }, null, 2))

  const run = () => spawnSync(process.execPath, [join(setupDir, 'install.mjs'), '--skip-pnpm'], {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
  })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(installed.dependencies['dsh-ally'], 'link:../../.agent-presets/harness-ally')
  assert.deepEqual(installed.dsh.profile.bundles, ['existing', 'dsh-ally'])

  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')), installed)
})
