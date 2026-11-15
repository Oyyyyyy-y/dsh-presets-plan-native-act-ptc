/**
 * Regenerate `cordis.patch.yml` (the `dsh.bundle.patch` layer) from the
 * installed ptc preset.
 *
 * The plugin list is copied verbatim so a DSH upgrade only needs this script
 * re-run; the plan-mode guidance paragraph is rewritten because the hybrid
 * preset deliberately changes the tool catalog at the plan boundary.
 *
 * Usage:
 *   node scripts/gen-cordis-patch.mjs --source <ptc.patch.yml> [--package <name>] [--out <file>]
 */
import fs from 'node:fs'
import path from 'node:path'

/** The paragraph the copied preset states about plan mode that is false here. */
const PLAN_GUIDANCE = {
  match: 'The tool catalog stays the same across modes for request-cache stability.',
  text: 'In this preset the tool catalog does change at the plan boundary: planning runs the native tools (read, grep, glob, pwsh, and so on) and execution collapses to run_code alone. Do not call run_code while planning, and do not expect the standard tools after approval. These plan-mode rules override any tool description that suggests using mutation tools; mutation tools are listed but must not be used during planning. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
}

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
 * Build the bundle patch.
 * @param source - extracted shipped `ptc.patch.yml`.
 * @param pkg - package name referenced from the preset's plugin list.
 * @returns the YAML document.
 */
function buildPatch(source, pkg) {
  const src = fs.readFileSync(source, 'utf8').split(/\r?\n/)
  const at = src.findIndex((line) => line === '        plugins:')
  if (at < 0) throw new Error('plugins: block not found in ' + source)
  let items = src.slice(at + 1)
  while (items.length > 0 && items[items.length - 1].trim() === '') items.pop()
  if (!items.some((line) => /^ {10}- id: tool-todo$/.test(line))) throw new Error('unexpected plugins block shape in ' + source)

  const head = [
    '# dsh.bundle.patch layer for ' + pkg + '.',
    '# `dsh plugin --profile <name> add <this package>` appends this bundle to the',
    '# profile; profile boot merges the patch below, so no profile file needs a',
    '# manual edit. Regenerate with scripts/gen-cordis-patch.mjs after a DSH upgrade.',
    '- insert:',
    '    - id: preset-ptc-hybrid',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ptc-hybrid',
    "        name: 'PTC 混合（计划=标准，执行=PTC）'",
    "        description: '与 ptc 相同；进 plan mode 时自动切到原生工具，批准后切回原始 PTC。刻意沿用 ptc 的排除项（workflow / 插件管理在 PTC 下会退化为坏工具）'",
    '        order: 3',
    '        plugins:',
  ]
  const router = [
    '          - id: plan-act-router',
    '            name: ' + pkg,
    '            config:',
    '              presets: [ptc-hybrid]',
  ]
  return [...head, ...rewritePlanGuidance(items), ...router].join('\n')
}

const source = arg('--source')
if (source === undefined) {
  console.error('usage: node scripts/gen-cordis-patch.mjs --source <extracted ptc.patch.yml> [--package <name>] [--out <file>]')
  process.exit(2)
}
const pkg = arg('--package') ?? 'dsh-presets-plan-native-act-ptc'
const out = arg('--out') ?? path.join(process.cwd(), 'cordis.patch.yml')
fs.writeFileSync(out, buildPatch(source, pkg) + '\n')
console.log(JSON.stringify({ source, package: pkg, out, bytes: fs.statSync(out).size }, null, 2))
