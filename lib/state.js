import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const VALID_HARNESSES = new Set(['dsh', 'claude-code', 'codex', 'kimi-code'])
const MAX_DISPATCHES_PER_SESSION = 400

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-ally.json')
}

function parseState(text) {
  const parsed = JSON.parse(text)
  if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
    throw new Error('dsh-ally state has an unsupported format')
  }
  const sessions = new Map()
  for (const [sessionId, value] of Object.entries(parsed.sessions)) {
    if (!value || typeof value !== 'object' || !VALID_HARNESSES.has(value.harness)) continue
    const dispatches = Array.isArray(value.dispatches)
      ? value.dispatches.filter((item) => item && Number.isSafeInteger(item.turn) && typeof item.harness === 'string')
        .slice(-MAX_DISPATCHES_PER_SESSION)
      : []
    sessions.set(sessionId, { harness: value.harness, dispatches })
  }
  return sessions
}

async function writeSnapshot(file, snapshot) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export async function createAllianceState({ file = statePath(), writer = writeSnapshot } = {}) {
  let sessions = new Map()
  try {
    sessions = parseState(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let writes = Promise.resolve()

  function session(sessionId, source = sessions) {
    return source.get(sessionId) ?? { harness: 'dsh', dispatches: [] }
  }

  function snapshot(source) {
    return {
      version: 1,
      sessions: Object.fromEntries([...source].map(([sessionId, value]) => [sessionId, {
        harness: value.harness,
        dispatches: value.dispatches,
      }])),
    }
  }

  function transaction(mutate) {
    const operation = writes.then(async () => {
      const candidate = new Map(sessions)
      if (mutate(candidate) === false) return
      await writer(file, snapshot(candidate))
      sessions = candidate
    })
    writes = operation.catch(() => {})
    return operation
  }

  return {
    harness(sessionId) {
      return session(sessionId).harness
    },
    dispatches(sessionId) {
      return session(sessionId).dispatches.map((item) => ({ ...item }))
    },
    setHarness(sessionId, harness) {
      if (!VALID_HARNESSES.has(harness)) return Promise.reject(new Error(`unknown Harness ${String(harness)}`))
      return transaction((candidate) => {
        const current = session(sessionId, candidate)
        if (current.harness === harness) return false
        candidate.set(sessionId, { harness, dispatches: current.dispatches })
      })
    },
    recordDispatch(sessionId, dispatch) {
      return transaction((candidate) => {
        const current = session(sessionId, candidate)
        const dispatches = [...current.dispatches.filter((item) => item.turn !== dispatch.turn), { ...dispatch }]
          .slice(-MAX_DISPATCHES_PER_SESSION)
        candidate.set(sessionId, { harness: current.harness, dispatches })
      })
    },
    async close() {
      await writes
    },
  }
}
