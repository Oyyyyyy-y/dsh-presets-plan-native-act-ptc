/**
 * Regenerate `cordis.patch.yml` (the `dsh.bundle.patch` layer) from the
 * shipped **standard** preset.
 *
 * The hybrid preset is the standard preset's plugin tree plus the PTC
 * transport: one request then declares both catalogs, and the router enforces
 * the phase with policy. So the source is `standard.patch.yml`, not
 * `ptc.patch.yml` — plan mode must be able to call exactly what standard can
 * call, including `workflow` and `plugin_manager`.
 *
 * Usage:
 *   node scripts/gen-cordis-patch.mjs --source <standard.patch.yml> [--package <name>] [--out <file>]
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * The paragraph the copied preset states about plan mode. Standard's wording
 * still holds after the rewrite (one catalog for both modes); the replacement
 * names the enforcement so a reader knows why the tools are all listed.
 */
const PLAN_GUIDANCE = {
  match: 'The tool catalog stays the same across modes for request-cache stability.',
  text: 'The tool catalog is identical in both modes: every native tool and run_code are always declared, plan mode refuses run_code, and execution mode refuses direct native calls. These plan-mode rules override any tool description that suggests using mutation tools; mutation tools are listed but must not be used during planning. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
}

/** The PTC transport row, inserted at the position the shipped ptc preset uses. */
const PTC_EXECUTOR_ROWS = [
  '          - id: tool-executor-ptc',
  "            name: '@deepseek-ai/dsh-tool-executor-ptc'",
]

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * Rewrite the plan guidance the copied preset carries verbatim.
 * @param lines - preset plugin lines, indentation preserved.
 * @returns the lines with the matched paragraph replaced.
 */
function rewritePlanGuidance(lines) {
  let hits = 0
  const out = lines.map((line) => {
    const indent = line.length - line.trimStart().length
    if (line.slice(indent).startsWith(PLAN_GUIDANCE.match)) {
      hits++
      return line.slice(0, indent) + PLAN_GUIDANCE.text
    }
    return line
  })
  if (hits !== 1) throw new Error('expected exactly one plan-guidance paragraph, rewrote ' + hits)
  return out
}

/**
 * Insert the PTC transport row before `present`, matching the shipped ptc
 * preset's position so both catalogs are declared by the same tree.
 * @param lines - preset plugin lines.
 * @returns the lines with the transport row inserted.
 */
function insertPtcExecutorRow(lines) {
  const at = lines.findIndex((line) => line === '          - id: present')
  if (at < 0) throw new Error('insertion point "- id: present" not found in the plugin list')
  return [...lines.slice(0, at), ...PTC_EXECUTOR_ROWS, ...lines.slice(at)]
}

// This preset carries no agent-layer rows.

const ROUTER_NAME_LINE = '            name: PKG'

const ROUTER_PLUGIN = [
  '          - id: superset-router',
  ROUTER_NAME_LINE,
  '            config:',
  '              presets: [ptc-hybrid]',
  '              actHiddenTools: [workflow, plugin_manager]',
]

/**
 * Build the bundle patch.
 * @param source - extracted shipped `standard.patch.yml`.
 * @param pkg - package name referenced from the preset's plugin list.
 * @returns the YAML document.
 */
function buildPatch(source, pkg) {
  const src = fs.readFileSync(source, 'utf8').split(/\r?\n/)
  if (src.some((line) => /^ {8}id: ptc$/.test(line))) {
    throw new Error(source + ' is a ptc preset; pass the standard preset (plan mode needs workflow / plugin_manager)')
  }
  const at = src.findIndex((line) => line === '        plugins:')
  if (at < 0) throw new Error('plugins: block not found in ' + source)
  let items = src.slice(at + 1)
  while (items.length > 0 && items[items.length - 1].trim() === '') items.pop()
  if (!items.some((line) => /^ {10}- id: tool-todo$/.test(line))) throw new Error('unexpected plugins block shape in ' + source)
  // Inside the delegation group, so the row is indented deeper than a top-level one.
  if (!items.some((line) => /^\s+- id: tool-workflow$/.test(line))) throw new Error('source preset has no workflow row; it is not the standard preset')

  const head = [
    '# dsh.bundle.patch layer for ' + pkg.replace(/'/g, '') + '.',
    '# `dsh plugin --profile <name> add <this package>` appends this bundle to the',
    '# profile; profile boot merges the patch below, so no profile file needs a',
    '# manual edit. Regenerate with scripts/gen-cordis-patch.mjs after a DSH upgrade.',
    '#',
    '# This preset carries no agent-layer rows.',
    '#',
    '# The plan-mode `section` below is not what the model sees: the router replaces',
    '# it with its own reminder, configured in plugins/superset-router.mjs.',
    '- insert:',
    '    - id: preset-ptc-hybrid',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ptc-hybrid',
    "        name: 'PTC 混合（计划=标准，执行=PTC）'",
    "        description: '工具表恒定：一次请求同时声明全部原生工具与 run_code。plan 阶段拒绝 run_code（生效工具集=标准预设，含 workflow / plugin_manager），批准后只允许 run_code、程序内拒绝 workflow / plugin_manager（生效工具集=PTC 预设）。工具声明与系统提示跨边界不变，plan 边界不再重建前缀缓存。'",
    '        order: 3',
    '        plugins:',
  ]
  // Match the whole line: comparing against the bare token emitted `name: PKG`
  // into the patch, which no profile can resolve.
  const router = ROUTER_PLUGIN.map((line) => line === ROUTER_NAME_LINE ? '            name: ' + pkg : line)
  if (router.includes(ROUTER_NAME_LINE)) throw new Error('router row name was not substituted with ' + pkg)
  return [...head, ...rewritePlanGuidance(insertPtcExecutorRow(items)), ...router].join('\n')
}

const source = arg('--source')
if (source === undefined) {
  console.error('usage: node scripts/gen-cordis-patch.mjs --source <extracted standard.patch.yml> [--package <name>] [--out <file>]')
  process.exit(2)
}
const pkg = arg('--package') ?? "'dsh-presets-plan-native-act-ptc'"
const out = arg('--out') ?? path.join(process.cwd(), 'cordis.patch.yml')
fs.writeFileSync(out, buildPatch(source, pkg) + '\n')
console.log('wrote ' + out)
