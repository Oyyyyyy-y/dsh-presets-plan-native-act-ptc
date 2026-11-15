/**
 * Inspect DSH session logs for context integrity and phase-budget behaviour.
 *
 * Reports, per session: message counts (must only grow), system-node operations
 * (replace vs append), plan/mode transitions with the provider cache reading of
 * the next request, and how many PTC dispatches happened inside each plan window.
 *
 * Usage: node tools/check-context-integrity.mjs [--preset ptc-hybrid] [--all] [--session <id>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')
const ROOT = path.join(HOME, 'sessions')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

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

const presetFilter = process.argv.includes('--all') ? undefined : arg('--preset', 'ptc-hybrid')
const only = arg('--session', undefined)
const sessions = []

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
    const selectedPreset = events.filter((e) => e.type === 'agent-preset/selected').at(-1)?.data?.agentPreset
    // The header records the preset a session STARTED with; the authoritative one is the projection.
    if (presetFilter !== undefined && head.agentPreset !== presetFilter && selectedPreset !== presetFilter) continue

    const counts = {}
    const headers = []
    const planModes = []
    let systemReplace = 0
    let nonSystemReplace = 0
    let compactionReplace = 0
    for (const e of events) {
      counts[e.type] = (counts[e.type] ?? 0) + 1
      const op = e.surfaceOp
      if (op !== undefined && typeof op === 'object' && op.op === 'replace') {
        if (e.type === 'system/message') systemReplace += 1
        else if (e.type.startsWith('compaction/')) compactionReplace += 1
        else nonSystemReplace += 1
      }
      if (e.type === 'request/header') {
        headers.push({ seq: e.seq, reason: e.data?.reason, series: e.data?.startsSeries === true, tools: (e.data?.header?.tools ?? []).length })
      }
      if (e.type === 'plan/mode') planModes.push({ seq: e.seq, active: e.data?.active === true })
    }

    // PTC dispatches between plan/mode transitions.
    const windowCounts = []
    for (let i = 0; i < planModes.length; i++) {
      const start = planModes[i].seq
      const end = i + 1 < planModes.length ? planModes[i + 1].seq : Number.POSITIVE_INFINITY
      const dispatches = events.filter((e) => e.type === 'tool/ptc-dispatch-start' && e.seq > start && e.seq < end).length
      windowCounts.push({ active: planModes[i].active, dispatches })
    }

    // Provider cache reading of the first request after each plan/mode event.
    const usageAfter = planModes.map((m) => {
      const next = events.find((e) => e.seq > m.seq && e.type === 'assistant/message' && e.data?.usage !== undefined)
      if (next === undefined) return { ...m, usage: null }
      const u = next.data.usage
      const total = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0)
      return { ...m, usage: { input: u.inputTokens, cached: u.cacheReadTokens, hit: total > 0 ? Math.round((u.cacheReadTokens ?? 0) / total * 100) : 0 } }
    })

    sessions.push({
      session: sessionId,
      preset: head.agentPreset,
      created: new Date(head.createdAt).toISOString(),
      counts,
      headers,
      usageAfter,
      windowCounts,
      systemReplace,
      nonSystemReplace,
      compactionReplace,
    })
  }
}

sessions.sort((a, b) => (a.created < b.created ? 1 : -1))
if (sessions.length === 0) console.log('no sessions for preset ' + String(presetFilter))
for (const s of sessions.slice(0, 6)) {
  const c = s.counts
  console.log('\n' + s.session + '  preset=' + s.preset + '  created=' + s.created)
  console.log('  messages: user=' + (c['user/message'] ?? 0) + ' assistant=' + (c['assistant/message'] ?? 0) + ' tool=' + (c['tool/result'] ?? 0) + ' developer=' + (c['developer/message'] ?? 0))
  console.log('  system/message=' + (c['system/message'] ?? 0) + ' (replace ops ' + s.systemReplace + ')  compaction-replace=' + s.compactionReplace + '  UNEXPECTED non-system replace=' + s.nonSystemReplace)
  console.log('  headers: ' + s.headers.map((h) => h.seq + ':' + h.reason + (h.series ? '/series' : '') + '(' + h.tools + ' tools)').join(', '))
  for (const u of s.usageAfter.slice(-6)) {
    console.log('  plan/mode seq=' + u.seq + ' active=' + u.active + '  next request ' + (u.usage === null ? '(none)' : 'input=' + u.usage.input + ' cached=' + u.usage.cached + ' hit=' + u.usage.hit + '%'))
  }
  for (const w of s.windowCounts.slice(-6)) {
    console.log('  window active=' + w.active + '  ptc-dispatch=' + w.dispatches)
  }
}
