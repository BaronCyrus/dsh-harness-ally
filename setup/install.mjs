#!/usr/bin/env node
/**
 * Harness联盟模式跨平台安装脚本：
 * 1. 校验仓库位于 ~/.dsh/.agent-presets/harness-ally；
 * 2. 将仓库根目录作为 dsh-ally link 依赖写入 Web Profile；
 * 3. 将 dsh-ally 加入 Profile bundle 清单并执行 pnpm install。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRESET_ID = 'harness-ally'
const PACKAGE_NAME = 'dsh-ally'
const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const DSH_HOME_INPUT = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const DSH_HOME = realpathSync.native(DSH_HOME_INPUT)
const EXPECTED_ROOT = resolve(join(DSH_HOME, '.agent-presets', PRESET_ID))
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'web')
const PROFILE_PACKAGE = join(PROFILE_DIR, 'package.json')
const SKIP_PNPM = process.argv.includes('--skip-pnpm')

const comparable = (value) => process.platform === 'win32' ? value.toLowerCase() : value
if (comparable(realpathSync.native(ROOT)) !== comparable(realpathSync.native(EXPECTED_ROOT))) {
  console.error(`❌ 请把仓库克隆到 ${EXPECTED_ROOT}`)
  console.error(`   git clone https://github.com/BaronCyrus/dsh-harness-ally.git "${EXPECTED_ROOT}"`)
  process.exit(1)
}
if (!existsSync(PROFILE_PACKAGE)) {
  console.error(`❌ 未找到 Web Profile：${PROFILE_PACKAGE}`)
  console.error('   请先运行一次 dsh web，再重新执行安装脚本。')
  process.exit(1)
}

const profile = JSON.parse(readFileSync(PROFILE_PACKAGE, 'utf8'))
profile.dependencies ||= {}
profile.dsh ||= {}
profile.dsh.profile ||= {}
profile.dsh.profile.bundles ||= []

const relativeRoot = relative(PROFILE_DIR, ROOT).split(sep).join('/')
const linkTarget = `link:${relativeRoot}`
let changed = false
if (profile.dependencies[PACKAGE_NAME] !== linkTarget) {
  profile.dependencies[PACKAGE_NAME] = linkTarget
  changed = true
  console.log(`+ ${PACKAGE_NAME}: ${linkTarget}`)
} else {
  console.log(`= ${PACKAGE_NAME} link 依赖已存在`)
}
if (!profile.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  profile.dsh.profile.bundles.push(PACKAGE_NAME)
  changed = true
  console.log(`+ Profile bundle: ${PACKAGE_NAME}`)
} else {
  console.log(`= Profile bundle ${PACKAGE_NAME} 已存在`)
}

if (changed) {
  const temporary = `${PROFILE_PACKAGE}.dsh-ally.tmp`
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, PROFILE_PACKAGE)
}

if (!SKIP_PNPM) {
  console.log('→ 执行 pnpm install 建立本地 link…')
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], {
    cwd: PROFILE_DIR,
    stdio: 'inherit',
  })
}

console.log('')
console.log('✅ Harness联盟模式安装完成。')
console.log('   1. 重启现有 dsh web 进程。')
console.log('   2. 新建「Harness联盟模式」会话。')
console.log('   3. 在「选择Harness」中选择 DeepSeek Harness、Claude Code 或 Codex。')
console.log('   Claude Code/Codex 缺失时，可直接使用选择菜单中的「安装」按钮。')
