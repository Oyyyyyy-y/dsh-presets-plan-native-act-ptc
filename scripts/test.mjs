/**
 * Unit tests for the pure parts of the superset router (no DSH runtime needed).
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, decide, needsPtc, stripPlanPolicy } from '../index.mjs'

/** Repository root, one level above scripts/. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const cases = []
/**
 * Register one assertion case.
 * @param label - what is being checked.
 * @param run - the assertions.
 */
function test(label, run) {
  cases.push({ label, run })
}

const NESTED = Symbol('parent-token')
const HIDDEN = ['workflow', 'plugin_manager']

test('plan allows every native tool', () => {
  for (const name of ['read', 'grep', 'pwsh', 'write', 'exit_plan_mode']) {
    assert.equal(decide('plan', { name }), undefined, name)
  }
})

test('plan refuses run_code, directly and nested', () => {
  assert.equal(decide('plan', { name: 'run_code' })?.kind, 'deny')
  assert.equal(decide('plan', { name: 'run_code', parent: NESTED })?.kind, 'deny')
})

test('plan refusal names exit_plan_mode', () => {
  const decision = decide('plan', { name: 'run_code' })
  assert.match(decision.reason, /exit_plan_mode/)
})

test('act allows run_code as a direct call', () => {
  assert.equal(decide('act', { name: 'run_code' }, HIDDEN), undefined)
})

test('act refuses a direct native call', () => {
  // ask_user_question included on purpose: act is exactly the PTC preset, which
  // allows run_code only. Questions belong inside a program (with timeoutMs).
  for (const name of ['read', 'pwsh', 'exit_plan_mode', 'ask_user_question', 'subagent']) {
    assert.equal(decide('act', { name }, HIDDEN)?.kind, 'deny', name)
  }
})

test('act reminder carries the run_code program rules', () => {
  // The stock PTC prompt puts these rules in its tools:sdk system section; the
  // preset must deliver them through the runtime-context reminder instead.
  assert.match(DEFAULTS.actReminder, /async TypeScript function/)
  assert.match(DEFAULTS.actReminder, /Top-level await and return are supported/)
  assert.match(DEFAULTS.actReminder, /fresh Node process/)
})

test('act hidden tools match the built-in ptc preset disabled rows', () => {
  // Built-in ptc.patch.yml sets workflow-ptc / tool-workflow / tool-plugin-manager
  // to disabled; the policy hides exactly those inside programs.
  assert.deepEqual(DEFAULTS.actHiddenTools, ['workflow', 'plugin_manager'])
})

test('act refusal tells the model to use run_code', () => {
  assert.match(decide('act', { name: 'read' }, HIDDEN).reason, /run_code/)
  assert.match(decide('act', { name: 'read' }, HIDDEN).reason, /tools\.read/)
})

test('act allows a nested native call', () => {
  for (const name of ['read', 'pwsh', 'present', 'todo_read']) {
    assert.equal(decide('act', { name, parent: NESTED }, HIDDEN), undefined, name)
  }
})

test('act refuses nested workflow and plugin_manager', () => {
  assert.equal(decide('act', { name: 'workflow', parent: NESTED }, HIDDEN)?.kind, 'deny')
  assert.equal(decide('act', { name: 'plugin_manager', parent: NESTED }, HIDDEN)?.kind, 'deny')
  assert.equal(decide('act', { name: 'workflow', parent: NESTED }, 'workflow')?.kind, 'deny')
})

test('unknown phase never blocks', () => {
  assert.equal(decide(undefined, { name: 'read' }), undefined)
  assert.equal(decide('idle', { name: 'run_code' }), undefined)
})

test('a batch containing run_code routes to the PTC executor', () => {
  assert.equal(needsPtc([{ name: 'run_code' }]), true)
  assert.equal(needsPtc([{ name: 'read' }, { name: 'run_code' }]), true)
  assert.equal(needsPtc([{ name: 'read' }]), false)
  assert.equal(needsPtc([]), false)
  assert.equal(needsPtc(undefined), false)
})

test('degraded execution mode allows native calls instead of locking the session', () => {
  for (const name of ['read', 'pwsh', 'edit', 'exit_plan_mode']) {
    assert.equal(decide('act', { name }, HIDDEN, undefined, false), undefined, name)
  }
})

test('degraded execution mode refuses run_code with an explicit reason', () => {
  const decision = decide('act', { name: 'run_code' }, HIDDEN, undefined, false)
  assert.equal(decision?.kind, 'deny')
  assert.match(decision.reason, /DEGRADED/)
  assert.match(decision.reason, /native/)
})

test('degraded execution mode allows nested calls too (no program can run)', () => {
  // No run_code program can start while the transport is missing, so the nested
  // allow-list is unreachable; the branch stays permissive rather than denying.
  assert.equal(decide('act', { name: 'workflow', parent: NESTED }, HIDDEN, undefined, false), undefined)
})

test('plan mode is unchanged when the transport is missing', () => {
  assert.equal(decide('plan', { name: 'read' }, HIDDEN, undefined, false), undefined)
  assert.equal(decide('plan', { name: 'run_code' }, HIDDEN, undefined, false)?.kind, 'deny')
})

test('missing tool identity never blocks', () => {
  assert.equal(decide('act', undefined, HIDDEN), undefined)
  assert.equal(decide('plan', { name: '' }, HIDDEN), undefined)
})

test('stripPlanPolicy removes only plan:policy', () => {
  const sections = [
    { name: 'harness:identity', text: 'a' },
    { name: 'plan:policy', text: 'b' },
    { name: 'superset:guide', text: 'c' },
  ]
  const stripped = stripPlanPolicy({ sections, contexts: [], variables: {} })
  assert.deepEqual(stripped.sections.map(section => section.name), ['harness:identity', 'superset:guide'])
})

test('stripPlanPolicy leaves other assemblies identical', () => {
  const sections = [{ name: 'harness:identity', text: 'a' }]
  const presentation = { sections, contexts: [], variables: { model: 'm' } }
  assert.equal(stripPlanPolicy(presentation), presentation)
})

test('stripPlanPolicy tolerates missing shapes', () => {
  assert.equal(stripPlanPolicy(undefined), undefined)
  assert.deepEqual(stripPlanPolicy({}), {})
  assert.deepEqual(stripPlanPolicy({ sections: 'nope' }), { sections: 'nope' })
})

test('bundle patch mounts the router under its package name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lines = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  const at = lines.findIndex((line) => line.trim() === '- id: superset-router')
  assert.notEqual(at, -1, 'superset-router row is missing from cordis.patch.yml')
  const nameLine = lines.slice(at + 1, at + 4).map((line) => /^\s*name:\s*(.+?)\s*$/.exec(line)).find(Boolean)
  assert.ok(nameLine !== undefined, 'superset-router row has no name')
  assert.equal(nameLine[1].replace(/^['"]|['"]$/g, ''), pkg.name)
})

let failed = 0
for (const item of cases) {
  try {
    item.run()
    console.log('ok   ' + item.label)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + item.label)
    console.log('     ' + (error instanceof Error ? error.message : String(error)))
  }
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed')
if (failed > 0) process.exitCode = 1
