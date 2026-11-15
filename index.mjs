/**
 * Phase router for a hybrid preset: plan mode runs the native tool executor,
 * everything after approval runs PTC (run_code only).
 *
 * Executor selection is scope-aware: ToolsService.selectExecutor(agent) walks
 * the agent scope chain, and an agent is itself a scope key. Registering a
 * router in the agent's own scope therefore overrides the preset-scope PTC
 * executor for that session only, without touching app.asar.
 *
 * The phase flip mutates the router in place instead of disposing it: a
 * disposed registration leaves selectExecutor with an unavailable selection
 * (dsh-tools/src/index.ts), not a fallback to the preset executor.
 *
 * The phase reminder rides the runtime-context channel: a scoped prompt
 * context whose text depends on the phase. DSH appends a new
 * <system-reminder> user message only when that text changes, so the request
 * prefix stays intact (the same shape ZCode uses for mode reminders).
 */

/** Cordis plugin name. */
export const name = 'plan-act-router'

/** Services this plugin needs before it can route. */
export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  presets: ['ptc-hybrid'],
  subCallsPerMinute: 256,
  maxParallelSubCalls: 10,
  reminderOrder: 9000,
  planReminder: '计划阶段：用标准工具（read / grep / glob / pwsh 等）逐步探索，方案确定后调用 exit_plan_mode 请人审批；不要写文件、不要执行有副作用的命令。',
  actReminder: '执行阶段：顶层工具不可用，只能用 run_code 编写程序批量执行。按已批准的计划推进；程序的预算就是运行时配置的那一个值（默认 120 秒，审批等待也计入），超时会被直接终止——把长任务拆成多次调用，不要写超预算的程序。',
}

/**
 * Resolve the installed DSH package root that holds the executor modules.
 * @returns absolute path to the @deepseek-ai directory.
 */
async function resolveInstallBase() {
  const path = await import('node:path')
  const { existsSync } = await import('node:fs')
  const tail = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai']
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) candidates.push(path.join(process.env.DSH_INSTALL_DIR, 'node_modules', '@deepseek-ai'))
  const resources = process.resourcesPath ?? path.join(path.dirname(process.execPath), 'resources')
  candidates.push(path.join(resources, ...tail))
  // macOS: Contents/MacOS/<binary> + Contents/Resources/app.asar
  candidates.push(path.join(path.dirname(process.execPath), '..', 'Resources', ...tail))
  // CLI layouts (resources/runtime/...): walk up looking for a resources/app.asar.
  let dir = path.dirname(process.execPath)
  for (let i = 0; i < 4; i++) {
    candidates.push(path.join(dir, 'resources', ...tail))
    candidates.push(path.join(dir, '..', 'Resources', ...tail))
    dir = path.dirname(dir)
  }
  for (const base of candidates) {
    if (existsSync(path.join(base, 'dsh-tool-executor-native', 'lib', 'index.js'))) return base
  }
  throw new Error('cannot locate the installed @deepseek-ai packages')
}

/**
 * Import one official package, preferring normal module resolution (a bundle
 * installed in a profile resolves peers from the installation) and falling
 * back to the running app's own copy.
 * @param name - the @deepseek-ai package name.
 * @returns the module namespace.
 */
async function loadOfficial(name) {
  try {
    return await import(name)
  } catch {
    const path = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const base = await resolveInstallBase()
    return import(pathToFileURL(path.join(base, name, 'lib', 'index.js')).href)
  }
}

/**
 * Import the executor and scope modules from the running installation.
 * @returns the three module namespaces.
 */
async function loadModules() {
  const [native, ptc, scope] = await Promise.all([
    loadOfficial('@deepseek-ai/dsh-tool-executor-native'),
    loadOfficial('@deepseek-ai/dsh-tool-executor-ptc'),
    loadOfficial('@deepseek-ai/dsh-scope'),
  ])
  return { native, ptc, scope }
}

/**
 * Read the committed plan-mode state.
 *
 * `ctx.planMode` sits inside the preset's `planning` isolate realm
 * (`isolate: { planMode: true }`), and this plugin mounts in the sibling
 * `ptc-scope` group, so the owning service is invisible here. The plan
 * projection is the supported substitute: a synchronous, cached cut over the
 * committed `plan/mode` events, read through the non-deprecated `snapshot`
 * reader (`Session.eventAt` is prohibited for new calls by the 2026-09-09
 * Agent Note).
 * @param ctx - context providing the projection registry.
 * @param session - session to inspect.
 * @param event - the event that triggered the sync, when it carries the flip.
 * @returns whether plan mode is committed, or undefined when the unit is unavailable.
 */
export function planActive(ctx, session, event) {
  if (event !== undefined && event.type === 'plan/mode') return event.data.active === true
  if (session === undefined) return undefined
  try {
    const plan = ctx.get('sessionProjections')?.snapshot(session, ['plan'])?.values?.plan
    return plan === undefined ? undefined : plan.active === true
  } catch (error) {
    ctx.logger?.warn?.('plan-act-router: cannot read the plan projection: ' + (error?.message ?? String(error)))
    return undefined
  }
}

/**
 * Register the phase router and its reminder section.
 * @param ctx - context providing tools and systemPrompt.
 * @param config - optional overrides for DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const presets = new Set(Array.isArray(cfg.presets) ? cfg.presets : [cfg.presets])
  const states = new Map()
  let mods
  let failed = false

  loadModules().then((loaded) => { mods = loaded }).catch((error) => {
    failed = true
    ctx.logger?.warn?.('plan-act-router disabled: ' + (error?.message ?? String(error)))
  })

  // Phase reminder: appended by the runtime-context projection only when it changes.
  ctx.get('systemPrompt')?.context({
    name: 'phase:mode',
    order: cfg.reminderOrder,
    interpolate: false,
    text: ({ scope }) => {
      const state = scope === undefined ? undefined : states.get(scope)
      if (state === undefined) return ''
      return state.phase === 'act' ? cfg.actReminder : cfg.planReminder
    },
  })

  /**
   * Create the agent-scoped router on first use.
   * @param agent - live agent handle, also used as the scope key.
   * @returns the state, or undefined when routing is unavailable.
   */
  function ensure(agent) {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    if (failed || mods === undefined) return undefined
    let scope
    try {
      scope = mods.scope.createScope(agent.ctx, agent)
    } catch (error) {
      ctx.logger?.warn?.('plan-act-router: cannot create agent scope: ' + (error?.message ?? String(error)))
      return undefined
    }
    if (mods.scope.scopeOf(scope.ctx) !== agent) {
      ctx.logger?.warn?.('plan-act-router: module identity mismatch for dsh-scope; staying on PTC')
      void scope.dispose()
      return undefined
    }
    const native = new mods.native.NativeToolExecutor(scope.ctx)
    // Resolve the deployment's PTC runtime through the preset context, so the
    // program budget is exactly the configured one (no private override and no
    // pause wrapper): act phase behaves like the stock PTC preset.
    const ptc = new mods.ptc.PtcExecutor(ctx, {
      maxSubCallsPerMinute: cfg.subCallsPerMinute,
      maxParallelSubCalls: cfg.maxParallelSubCalls,
    })
    const state = { phase: 'plan', scope, native, ptc }
    const sections = (ptc.sections ?? []).map((section) => ({
      ...section,
      text: (tools) => state.phase === 'act'
        ? (typeof section.text === 'function' ? section.text(tools) : section.text)
        : '',
    }))
    const router = {
      sections,
      describe: (tools) => state.phase === 'plan' ? native.describe(tools) : ptc.describe(tools),
      execute: (input) => state.phase === 'plan' ? native.execute(input) : ptc.execute(input),
    }
    try {
      scope.ctx.get('tools').setExecutor(router)
    } catch (error) {
      ctx.logger?.warn?.('plan-act-router: cannot install router: ' + (error?.message ?? String(error)))
      void scope.dispose()
      return undefined
    }
    states.set(agent, state)
    scope.ctx.effect(() => () => { states.delete(agent) })
    return state
  }

  /**
   * Resolve the preset a session actually runs under.
   *
   * The header records the preset the session STARTED with (it is frozen at
   * creation); a blank session may be switched afterwards, and only the
   * `agentPreset` Session projection advances with that selection. Reading the
   * header alone silently reports the old preset for every session created
   * with the GUI default and then switched in the preset chip.
   * @param session - session to resolve.
   * @returns the current preset id, or undefined when it cannot be read.
   */
  function presetOf(session) {
    if (session === undefined) return undefined
    try {
      const current = ctx.get('agentPresets')?.presetForSession?.(session)
      if (current !== undefined && current !== null) return current
    } catch (error) {
      ctx.logger?.warn?.('plan-act-router: cannot read the agentPreset projection: ' + (error?.message ?? String(error)))
    }
    return session.header?.agentPreset
  }

  /**
   * Align one session's phase with the committed plan-mode state.
   * @param session - session whose events fired the sync.
   * @param event - the event that fired it.
   */
  function sync(session, event) {
    if (failed) return
    const agent = ctx.get('agents')?.get(session.id)
    if (agent === undefined) return
    const presetId = presetOf(session)
    if (presetId === undefined || !presets.has(presetId)) return
    const active = planActive(ctx, session, event) === true
    const known = states.get(agent)
    if (!active && known === undefined) return
    const state = active ? (known ?? ensure(agent)) : known
    if (state === undefined) return
    state.phase = active ? 'plan' : 'act'
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'plan/mode' && event.type !== 'turn/start') return
    sync(session, event)
  })
}
