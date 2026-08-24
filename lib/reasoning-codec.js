import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_FILE = 'reasoning-replay.key'
const PREFIX = 'dsh-ally.reasoning.v1.'
const AAD = Buffer.from('dsh-ally Codex reasoning replay v1', 'utf8')

async function readKey(file) {
  const key = await readFile(file)
  if (key.length !== KEY_BYTES) throw new Error('invalid reasoning replay key')
  await chmod(file, 0o600)
  return key
}

async function persistedKey(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) return randomBytes(KEY_BYTES)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, KEY_FILE)
  try {
    return await readKey(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const key = randomBytes(KEY_BYTES)
  try {
    await writeFile(file, key, { flag: 'wx', mode: 0o600 })
    return key
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readKey(file)
  }
}

export async function createReasoningCodec({ stateDir } = {}) {
  const key = await persistedKey(stateDir)
  return {
    seal(text) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(AAD)
      const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
      const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
      return `${PREFIX}${payload}`
    },
    open(value) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw new Error('invalid opaque reasoning replay')
      try {
        const payload = Buffer.from(value.slice(PREFIX.length), 'base64url')
        if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('invalid payload')
        const iv = payload.subarray(0, IV_BYTES)
        const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
        const encrypted = payload.subarray(IV_BYTES + TAG_BYTES)
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(AAD)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('invalid opaque reasoning replay')
      }
    },
  }
}
