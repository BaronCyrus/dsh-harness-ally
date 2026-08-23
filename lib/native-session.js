import { createHash } from 'node:crypto'

const DEFAULT_MAX_TURNS = 32

function keyFor(parts) {
  return JSON.stringify([parts.sessionId, parts.harness, parts.provider, parts.model])
}

function fingerprintFor(parts, version) {
  return createHash('sha256').update(JSON.stringify({
    version,
    cwd: parts.cwd,
    policyMode: parts.policyMode,
    workspaceRoot: parts.workspaceRoot ?? null,
    promptSignature: parts.promptSignature,
  })).digest('hex')
}

function validParts(parts) {
  return parts
    && typeof parts.sessionId === 'string' && parts.sessionId
    && typeof parts.harness === 'string' && parts.harness
    && typeof parts.provider === 'string' && parts.provider
    && typeof parts.model === 'string' && parts.model
    && typeof parts.cwd === 'string' && parts.cwd
    && typeof parts.policyMode === 'string' && parts.policyMode
    && typeof parts.promptSignature === 'string' && parts.promptSignature
    && Number.isSafeInteger(parts.turn) && parts.turn > 0
    && typeof parts.fullPrompt === 'string' && parts.fullPrompt.trim()
    && typeof parts.incrementalPrompt === 'string' && parts.incrementalPrompt.trim()
}

export function createNativeSessionRegistry({ state, version, now = Date.now, maxTurns = DEFAULT_MAX_TURNS }) {
  if (!state || typeof state.resume !== 'function' || typeof state.compareAndSetResume !== 'function') {
    throw new Error('native session registry requires persistent state')
  }
  if (typeof version !== 'string' || !version) throw new Error('native session registry requires a version')
  const tails = new Map()
  const quarantined = new Set()

  async function start(parts, starter) {
    if (!validParts(parts)) throw new Error('invalid native session request')
    if (typeof starter !== 'function') throw new Error('native session starter must be a function')
    const key = keyFor(parts)
    const fingerprint = fingerprintFor(parts, version)
    const prior = tails.get(key) ?? Promise.resolve()
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const tail = prior.catch(() => {}).then(() => gate)
    tails.set(key, tail)
    await prior.catch(() => {})

    const stored = state.resume(key)
    const resumable = stored?.vendorId
      && !quarantined.has(key)
      && stored.fingerprint === fingerprint
      && stored.throughTurn === parts.turn - 1
      && stored.turns < maxTurns
    const initialMode = resumable ? 'resume' : 'fresh'
    let expectedRevision = stored?.revision ?? 0
    let candidateId
    let invalidated = false
    let released = false
    let disposal
    const context = {
      mode: initialMode,
      vendorId: resumable ? stored.vendorId : undefined,
      prompt: resumable ? parts.incrementalPrompt : parts.fullPrompt,
      adopt(vendorId) {
        if (typeof vendorId === 'string' && vendorId) candidateId = vendorId
      },
      async invalid() {
        if (initialMode !== 'resume' || invalidated) return false
        quarantined.add(key)
        const cleared = await state.compareAndSetResume(key, expectedRevision, {
          vendorId: null,
          fingerprint,
          throughTurn: 0,
          turns: 0,
          updatedAt: now(),
        }).catch(() => undefined)
        if (cleared) expectedRevision = cleared.revision
        invalidated = true
        return Boolean(cleared)
      },
      async fallback() {
        await context.invalid()
        candidateId = undefined
        context.mode = 'fresh'
        context.vendorId = undefined
        context.prompt = parts.fullPrompt
        return context
      },
    }

    let run
    try {
      run = await starter(context)
    } catch (error) {
      releaseGate()
      if (tails.get(key) === tail) tails.delete(key)
      throw error
    }

    const result = Promise.resolve(run.result).then(async (value) => {
      if (value?.stopReason === 'completed' && candidateId) {
        const continuing = initialMode === 'resume' && !invalidated && candidateId === stored.vendorId
        const committed = await state.compareAndSetResume(key, expectedRevision, {
          vendorId: candidateId,
          fingerprint,
          throughTurn: parts.turn,
          turns: continuing ? stored.turns + 1 : 1,
          updatedAt: now(),
        }).catch(() => undefined)
        if (committed) quarantined.delete(key)
      } else if (initialMode === 'resume' && !invalidated) {
        await context.invalid()
      }
      return value
    }, async (error) => {
      if (initialMode === 'resume' && !invalidated) await context.invalid()
      throw error
    })

    return {
      ...run,
      result,
      dispose() {
        if (!disposal) disposal = (async () => {
          try {
            await run.dispose()
            await result.catch(() => {})
          } finally {
            if (!released) {
              released = true
              releaseGate()
              if (tails.get(key) === tail) tails.delete(key)
            }
          }
        })()
        return disposal
      },
    }
  }

  return { start }
}
