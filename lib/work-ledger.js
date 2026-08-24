export const WORK_LEDGER_VERSION = 1

const FILES_CAP = 20
const COMMANDS_CAP = 10
const FAILURES_CAP = 10
const ENTRY_CHARS_CAP = 240
const FILE_ACTIVITY_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'str_replace_editor'])
const COMMAND_ACTIVITY_NAMES = new Set(['Bash', 'shell', 'exec_command', 'local_shell'])

function line(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, ENTRY_CHARS_CAP)
}

function stringList(value, cap, { unique = false } = {}) {
  if (!Array.isArray(value)) return []
  const values = value.map(line).filter(Boolean)
  return (unique ? [...new Set(values)] : values).slice(-cap)
}

export function normalizeWorkLedger(value) {
  if (!value || typeof value !== 'object' || value.version !== WORK_LEDGER_VERSION) return undefined
  const filesChanged = stringList(value.filesChanged, FILES_CAP, { unique: true })
  const commands = Array.isArray(value.commands)
    ? value.commands.flatMap((item) => {
      const command = line(item?.command)
      if (!command) return []
      const outcome = item?.outcome === 'completed' || item?.outcome === 'failed' ? item.outcome : undefined
      return [{ command, ...(outcome ? { outcome } : {}) }]
    }).slice(-COMMANDS_CAP)
    : []
  const failedAttempts = stringList(value.failedAttempts, FAILURES_CAP)
  if (!filesChanged.length && !commands.length && !failedAttempts.length) return undefined
  return { version: WORK_LEDGER_VERSION, filesChanged, commands, failedAttempts }
}

export function mergeWorkLedgers(entries, boundary) {
  const filesChanged = []
  const commands = []
  const failedAttempts = []
  for (const entry of entries ?? []) {
    if (!Number.isSafeInteger(entry?.turn)) continue
    if (boundary && (entry.turn <= boundary.afterTurn || entry.turn >= boundary.beforeTurn)) continue
    const ledger = normalizeWorkLedger(entry.ledger)
    if (!ledger) continue
    filesChanged.push(...ledger.filesChanged)
    commands.push(...ledger.commands)
    failedAttempts.push(...ledger.failedAttempts)
  }
  return normalizeWorkLedger({ version: WORK_LEDGER_VERSION, filesChanged, commands, failedAttempts })
}

export function renderWorkLedger(entries, boundary) {
  const ledger = mergeWorkLedgers(entries, boundary)
  if (!ledger) return undefined
  const lines = [
    'WORK LEDGER (AUTO-EXTRACTED)',
    'This is a bounded record of observed external Harness activity. Verify the workspace before continuing; the workspace is authoritative.',
  ]
  if (ledger.filesChanged.length) {
    lines.push('Files changed:', ...ledger.filesChanged.map((path) => `- ${path}`))
  }
  if (ledger.commands.length) {
    lines.push('Commands (most recent):', ...ledger.commands.map((item) => `- ${item.command}${item.outcome ? ` → ${item.outcome}` : ''}`))
  }
  if (ledger.failedAttempts.length) {
    lines.push('Failed attempts:', ...ledger.failedAttempts.map((attempt) => `- ${attempt}`))
  }
  return lines.join('\n')
}

export function workLedgerFromActivities(activities) {
  const filesChanged = []
  const commands = []
  const failedAttempts = []
  for (const activity of activities ?? []) {
    const name = line(activity?.name)
    const summary = line(activity?.summary)
    const status = activity?.status === 'completed' || activity?.status === 'failed' ? activity.status : 'running'
    if (FILE_ACTIVITY_NAMES.has(name) && summary && status !== 'failed') filesChanged.push(summary)
    if (COMMAND_ACTIVITY_NAMES.has(name) && summary) {
      commands.push({
        command: summary,
        ...(status === 'completed' || status === 'failed' ? { outcome: status } : {}),
      })
    }
    if (status === 'failed') failedAttempts.push(`${name || 'Tool'}${summary ? ` · ${summary}` : ''}`)
  }
  return normalizeWorkLedger({ version: WORK_LEDGER_VERSION, filesChanged, commands, failedAttempts })
}
