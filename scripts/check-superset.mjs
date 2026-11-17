/**
 * Assert the cache-stable behaviour of the `ptc-hybrid` preset from session logs.
 *
 * Reports, per session: whether the tool declaration list stayed identical
 * (A1), whether the system prompt was never replaced (A2), the provider cache
 * reading after each plan/mode transition (A3), and how many programs ran
 * inside each plan window (A4).
 *
 * The log is zstd, one frame per flush; frames are split on the zstd magic and
 * decompressed independently, exactly like `check-context-integrity.mjs`.
 *
 * The preset is a flag: `--preset <id>` selects whose sessions to check
 * (default `ptc-hybrid`).
 *
 * Usage:
 *   node scripts/check-superset.mjs [--preset <id>] [--session <id>] [--all] [--assert]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')
const ROOT = path.join(HOME, 'sessions')
/** Preset checked when --preset is not given. */
const DEFAULT_PRESET = 'ptc-hybrid'

/** Cache hit a boundary request must reach to count as "did not rebuild". */
const MIN_HIT = 0.95

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * Read every event from a multi-frame zstd JSONL log.
 * @param file - absolute log path.
 * @returns parsed events, in commit order.
 */
function readEvents(file) {
  const buf = fs.readFileSync(file)
  const cuts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) cuts.push(i)
  }
  let text = ''
  for (let k = 0; k < cuts.length; k++) {
    const slice = buf.subarray(cuts[k], k + 1 < cuts.length ? cuts[k + 1] : buf.length)
    text += zstdDecompressSync(slice).toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* partial trailing frame */ }
  }
  return events
}

const assertMode = process.argv.includes('--assert')
const only = arg('--session')
const PRESET = arg('--preset') ?? DEFAULT_PRESET
const sessions = []
let failures = 0

for (const workspace of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
  const wsDir = path.join(ROOT, workspace)
  if (!fs.statSync(wsDir).isDirectory()) continue
  for (const sessionId of fs.readdirSync(wsDir)) {
    if (only !== undefined && !sessionId.includes(only)) continue
    const file = path.join(wsDir, sessionId, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    let events
    try { events = readEvents(file) } catch { continue }
    const head = events.find((e) => e.type === 'session')
    if (head === undefined) continue
    const selected = events.filter((e) => e.type === 'agent-preset/selected').at(-1)?.data?.agentPreset
    if (head.agentPreset !== PRESET && selected !== PRESET) continue
    if (events.filter((e) => e.type === 'assistant/message').length === 0) continue
    sessions.push({ sessionId, events })
  }
}

sessions.sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1))

for (const { sessionId, events } of sessions) {
  const problems = []
  const headers = events.filter((e) => e.type === 'request/header')
  const catalogues = headers.map((e) => (e.data?.header?.tools ?? []).map((tool) => tool?.name ?? tool).sort().join(','))
  const distinct = [...new Set(catalogues)]
  if (distinct.length > 1) {
    problems.push('A1 catalog changed ' + distinct.length + ' times: ' + distinct.map((set) => set.split(',').length + ' tools').join(' -> '))
  }
  const toolCount = distinct.length === 0 ? 0 : distinct[0].split(',').length

  const systemNodes = events.filter((e) => e.type === 'system/message')
  const systemReplaces = systemNodes.filter((e) => e.surfaceOp?.op === 'replace').length
  if (systemReplaces > 0) problems.push('A2 system prompt replaced ' + systemReplaces + 'x')

  const planModes = events.filter((e) => e.type === 'plan/mode')
  const firstHeaderSeq = headers[0]?.seq ?? Infinity
  const boundaries = []
  for (const mode of planModes) {
    const next = events.find((e) => e.seq > mode.seq && e.type === 'assistant/message' && e.data?.usage !== undefined)
    if (next === undefined) continue
    const usage = next.data.usage
    const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    const hit = total > 0 ? (usage.cacheReadTokens ?? 0) / total : 0
    // A request that opens a NEW series (first request of a process, a resume,
    // or the first request after a compaction) cannot be expected to read the
    // old prefix back: mark exactly those cold. A resume header stays "the
    // governing header" for every later request, so it must only count when it
    // is newer than the previous assistant message (i.e. it belongs to this
    // request), otherwise all later boundaries would look cold forever.
    const governing = headers.filter((h) => h.seq < next.seq).at(-1)
    const previousAssistant = events.filter((e) => e.type === 'assistant/message' && e.data?.usage !== undefined && e.seq < next.seq).at(-1)
    const freshSeries = governing !== undefined && (previousAssistant === undefined || governing.seq > previousAssistant.seq)
    const compacted = events.some((e) => e.type === 'compaction/end' && e.seq > mode.seq && e.seq < next.seq)
    boundaries.push({ seq: mode.seq, active: mode.data?.active === true, hit, cold: mode.seq < firstHeaderSeq || freshSeries || compacted, freshSeries, compacted, input: usage.inputTokens, cached: usage.cacheReadTokens })
  }
  const warmBoundaries = boundaries.filter((b) => !b.cold)
  for (const b of warmBoundaries) {
    if (b.hit < MIN_HIT) problems.push('A3 seq ' + b.seq + ' -> ' + (b.active ? 'plan' : 'act') + ' rebuilt the prefix: hit ' + Math.round(b.hit * 100) + '% (input ' + b.input + ', cached ' + b.cached + ')')
  }

  const windows = planModes.map((mode, index) => {
    const end = index + 1 < planModes.length ? planModes[index + 1].seq : Infinity
    const dispatches = events.filter((e) => e.type === 'tool/ptc-dispatch-start' && e.seq > mode.seq && e.seq < end).length
    return { active: mode.data?.active === true, dispatches }
  })
  const planWindows = windows.filter((w) => w.active)
  const planDispatches = planWindows.reduce((sum, w) => sum + w.dispatches, 0)
  if (planDispatches > 0) problems.push('A4 ' + planDispatches + ' program dispatch(es) inside plan windows')

  const status = problems.length === 0 ? 'ok  ' : 'FAIL'
  if (problems.length > 0) failures += 1
  console.log(status + ' ' + sessionId)
  console.log('     A1 catalog: ' + (toolCount === 0 ? '(no request yet)' : toolCount + ' tools, ' + distinct.length + ' distinct declaration(s)'))
  console.log('     A2 system/message: ' + systemNodes.length + ' node(s), ' + systemReplaces + ' replace(s)')
  console.log('     A3 boundaries: ' + (boundaries.length === 0 ? '(none)' : boundaries.map((b) => (b.active ? 'plan' : 'act') + ' ' + (b.cold ? 'cold' : Math.round(b.hit * 100) + '%') + '(seq ' + b.seq + ')').join(', ')))
  console.log('     A4 plan windows: ' + (windows.length === 0 ? '(none)' : windows.map((w) => (w.active ? 'plan' : 'act') + '=' + w.dispatches).join(', ')))
  for (const problem of problems) console.log('     ! ' + problem)
}

console.log('\n' + sessions.length + ' session(s) of preset ' + PRESET + ', ' + failures + ' failing')
if (assertMode && failures > 0) process.exitCode = 1
