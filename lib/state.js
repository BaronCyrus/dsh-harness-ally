import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { HARNESSES } from './runtime.js'
import { mergeWorkLedgers, normalizeWorkLedger } from './work-ledger.js'

const VALID_HARNESSES = new Set(HARNESSES)
const MAX_DISPATCHES_PER_SESSION = 400
const MAX_RESUME_RECORDS = 200

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-ally.json')
}

function parseWatermark(value) {
  if (!value || typeof value !== 'object') return undefined
  if (!Number.isSafeInteger(value.messageCount) || value.messageCount < 1) return undefined
  if (typeof value.digest !== 'string' || !value.digest) return undefined
  return { messageCount: value.messageCount, digest: value.digest }
}

function parseResumeRecord(value) {
  if (!value || typeof value !== 'object') return undefined
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) return undefined
  if (value.vendorId !== null && (typeof value.vendorId !== 'string' || !value.vendorId)) return undefined
  if (typeof value.fingerprint !== 'string') return undefined
  if (!Number.isSafeInteger(value.throughTurn) || value.throughTurn < 0) return undefined
  if (!Number.isSafeInteger(value.turns) || value.turns < 0) return undefined
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) return undefined
  const watermark = value.watermark === undefined ? undefined : parseWatermark(value.watermark)
  if (value.watermark !== undefined && !watermark) return undefined
  return {
    revision: value.revision,
    vendorId: value.vendorId,
    fingerprint: value.fingerprint,
    throughTurn: value.throughTurn,
    turns: value.turns,
    updatedAt: value.updatedAt,
    ...(watermark ? { watermark } : {}),
  }
}

function normalizeDispatch(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.turn) || typeof value.harness !== 'string') return undefined
  const { ledger: rawLedger, ...dispatch } = value
  const ledger = rawLedger === undefined ? undefined : normalizeWorkLedger(rawLedger)
  return { ...dispatch, ...(ledger ? { ledger } : {}) }
}

function parseState(text) {
  const parsed = JSON.parse(text)
  if ((parsed?.version !== 1 && parsed?.version !== 2 && parsed?.version !== 3)
    || !parsed.sessions
    || typeof parsed.sessions !== 'object'
    || Array.isArray(parsed.sessions)) {
    throw new Error('dsh-ally state has an unsupported format')
  }
  const sessions = new Map()
  for (const [sessionId, value] of Object.entries(parsed.sessions)) {
    if (!value || typeof value !== 'object' || !VALID_HARNESSES.has(value.harness)) continue
    const dispatches = Array.isArray(value.dispatches)
      ? value.dispatches.map(normalizeDispatch).filter(Boolean).slice(-MAX_DISPATCHES_PER_SESSION)
      : []
    sessions.set(sessionId, { harness: value.harness, dispatches })
  }
  const resumes = new Map()
  if (parsed.version >= 2 && parsed.resumes && typeof parsed.resumes === 'object' && !Array.isArray(parsed.resumes)) {
    for (const [key, value] of Object.entries(parsed.resumes)) {
      const record = parseResumeRecord(value)
      if (record) resumes.set(key, record)
    }
    evictOldResumes(resumes)
  }
  return { sessions, resumes }
}

async function writeSnapshot(file, snapshot) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

function evictOldResumes(resumes) {
  if (resumes.size <= MAX_RESUME_RECORDS) return
  const oldest = [...resumes.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, resumes.size - MAX_RESUME_RECORDS)
  for (const [key] of oldest) resumes.delete(key)
}

export async function createAllianceState({ file = statePath(), writer = writeSnapshot } = {}) {
  let data = { sessions: new Map(), resumes: new Map() }
  try {
    data = parseState(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let writes = Promise.resolve()

  function session(sessionId, source = data.sessions) {
    return source.get(sessionId) ?? { harness: 'dsh', dispatches: [] }
  }

  function snapshot(source) {
    return {
      version: 3,
      sessions: Object.fromEntries([...source.sessions].map(([sessionId, value]) => [sessionId, {
        harness: value.harness,
        dispatches: value.dispatches,
      }])),
      resumes: Object.fromEntries(source.resumes),
    }
  }

  function transaction(mutate) {
    const operation = writes.then(async () => {
      const candidate = {
        sessions: new Map(data.sessions),
        resumes: new Map(data.resumes),
      }
      if (mutate(candidate) === false) return
      await writer(file, snapshot(candidate))
      data = candidate
    })
    writes = operation.catch(() => {})
    return operation
  }

  return {
    dir: dirname(file),
    harness(sessionId) {
      return session(sessionId).harness
    },
    dispatches(sessionId) {
      return session(sessionId).dispatches.map((item) => ({ ...item }))
    },
    resume(key) {
      const value = data.resumes.get(key)
      return value ? { ...value, ...(value.watermark ? { watermark: { ...value.watermark } } : {}) } : undefined
    },
    setHarness(sessionId, harness) {
      if (!VALID_HARNESSES.has(harness)) return Promise.reject(new Error(`unknown Harness ${String(harness)}`))
      return transaction((candidate) => {
        const current = session(sessionId, candidate.sessions)
        if (current.harness === harness) return false
        candidate.sessions.set(sessionId, { harness, dispatches: current.dispatches })
      })
    },
    recordDispatch(sessionId, dispatch) {
      const normalized = normalizeDispatch(dispatch)
      if (!normalized) return Promise.reject(new Error('invalid Harness dispatch'))
      return transaction((candidate) => {
        const current = session(sessionId, candidate.sessions)
        const previous = current.dispatches.find((item) => item.turn === normalized.turn)
        const ledger = mergeWorkLedgers([
          { turn: normalized.turn, ledger: previous?.ledger },
          { turn: normalized.turn, ledger: normalized.ledger },
        ])
        const next = { ...normalized, ...(ledger ? { ledger } : {}) }
        const dispatches = [...current.dispatches.filter((item) => item.turn !== normalized.turn), next]
          .slice(-MAX_DISPATCHES_PER_SESSION)
        candidate.sessions.set(sessionId, { harness: current.harness, dispatches })
      })
    },
    async compareAndSetResume(key, expectedRevision, next) {
      if (typeof key !== 'string' || !key) throw new Error('resume key must be a non-empty string')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('resume revision must be a non-negative integer')
      const parsed = parseResumeRecord({ ...next, revision: expectedRevision + 1 })
      if (!parsed) throw new Error('invalid resume record')
      let matched = false
      await transaction((candidate) => {
        const currentRevision = candidate.resumes.get(key)?.revision ?? 0
        if (currentRevision !== expectedRevision) return false
        matched = true
        candidate.resumes.set(key, parsed)
        evictOldResumes(candidate.resumes)
      })
      return matched ? { ...parsed } : undefined
    },
    async close() {
      await writes
    },
  }
}
