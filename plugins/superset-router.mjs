/**
 * Superset tool catalog with phase policy.
 *
 * Plan mode needs the native tools (a plan review is an ordinary tool call, so
 * the program budget never covers the wait); execution needs PTC's run_code.
 * Swapping executors at that boundary rewrites the request prefix — the tool
 * array is its first segment — so every plan <-> act crossing would recompute
 * the whole prompt instead of reading it from the provider cache.
 *
 * This router therefore advertises ONE catalog and enforces the phase with
 * policy instead:
 *
 *   every visible native tool (always) + run_code (always)
 *
 * - plan: run_code is refused, everything else direct-callable
 *   => the effective set is the standard preset's;
 * - act: only run_code is direct-callable; inside a program the tools the PTC
 *   preset disables (workflow, plugin_manager) are refused
 *   => the effective set is the PTC preset's.
 *
 * Cache stability also needs a byte-identical system prompt, so plan-mode's
 * 'plan:policy' section is stripped in system-prompt/assemble and the phase
 * guidance moves to the runtime-context reminder (which only appends a user
 * message). The catalog is read from the registry view rather than from the
 * step's admitted set, so plan-mode's progressive disclosure of exit_plan_mode
 * does not change the declaration list either.
 *
 * Failure direction: if the official executor modules cannot be loaded or the
 * executor cannot be installed, the plugin leaves the preset's own PTC executor
 * in place (run_code only) and logs why — degraded, never half-installed.
 *
 * Two failure modes are handled explicitly, because either one used to make the
 * session unusable:
 *
 * - the PTC transport cannot be described (no `run_code` in the catalog) —
 *   the plugin degrades to the native tools, logs an error, and says so in the
 *   runtime-context reminder; execution mode then fail-opens instead of denying
 *   every direct call while advertising a transport it cannot dispatch;
 * - a batch arrives for dispatch — `ToolExecutor.execute()` receives the whole
 *   `ToolBatchInput` (a `calls` array), not one call, so routing must look at
 *   the calls. Checking `input.name` never matched and silently sent `run_code`
 *   to the native executor, which answered `unknown tool "run_code"`.
 */

/** Cordis plugin name. */
export const name = 'superset-router'

/** Services this plugin needs before it can route. */
export const inject = ['tools', 'systemPrompt']

/** Reserved PTC transport name. */
const RUN_CODE_NAME = 'run_code'

/** Plan-mode's guidance section, stripped from every assembly (cache stability). */
const PLAN_POLICY_SECTION = 'plan:policy'

/** Constant tool-usage guidance section; must never depend on the phase. */
const GUIDE_SECTION = 'superset:guide'

/** Phase reminder context name (runtime-context channel). */
const PHASE_CONTEXT = 'phase:mode'

const DEFAULT_MESSAGES = {
  planDenied: 'superset-router: run_code is disabled in plan mode. Explore with the native tools (read / grep / glob / pwsh ...) and submit the finished plan through exit_plan_mode; run_code becomes available once the plan is approved.',
  actDirect: 'superset-router: execution mode allows only run_code as a direct tool call. Put this call inside a run_code program: await tools.{tool}(args).',
  actHidden: 'superset-router: "{tool}" is not available in execution mode (the PTC preset disables it); orchestrate with subagent / subagent_fork instead.',
  degradedDenied: 'superset-router DEGRADED: run_code cannot run in this session (the PTC transport could not be loaded), so execution mode runs the native tools instead. Do not call run_code — call the native tool directly.',
}

/**
 * Program rules the stock PTC prompt normally carries in its `tools:sdk` system
 * section (per-call runtime). The reminder is a runtime-context message, so the
 * system prompt and the request prefix stay byte-identical across the boundary.
 */
const ACT_PROGRAM_RULES = 'The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.'

export const DEFAULTS = {
  /** Presets whose sessions this router owns. */
  presets: ['ptc-hybrid'],
  /** PTC nested-call allowance and concurrency, mirroring the stock executor. */
  subCallsPerMinute: 256,
  maxParallelSubCalls: 10,
  /** Runtime-context order for the phase reminder (after the deployment facts). */
  reminderOrder: 9000,
  /** Tools the PTC preset does not expose inside programs. */
  actHiddenTools: ['workflow', 'plugin_manager'],
  /**
   * Declare the catalog from the registry view (admission-independent) instead
   * of the step's admitted set. Keeps the declaration list constant across the
   * plan boundary; set false only when debugging admission behaviour.
   */
  stableCatalog: true,
  // Optional model-facing overrides: planDeniedMessage / actDirectMessage /
  // actHiddenMessage. The token {tool} in a message is replaced by the tool name.
  guideSection: 'Execution modes share ONE tool catalog: this request declares every native tool and run_code, and the phase decides which of them you may call. In plan mode call the native tools directly and do not call run_code. In execution mode only run_code may be called directly: put every other call inside a program as await tools.name(args), and expect workflow / plugin_manager to be refused there. The tool declarations in this request are the SDK for both modes; create the arguments from those JSON schemas.',
  /** Guide section used when the PTC transport is missing (degraded session). */
  degradedGuide: 'Execution modes: this session DEGRADED to the native tool catalog because the PTC transport (run_code) could not be loaded. Every native tool is directly callable in both phases; run_code is unavailable and must not be called. The tool declarations in this request are the SDK.',
  planReminder: 'Plan phase (plan): the tool catalog does not change, but run_code is refused here — explore with the native tools (read / grep / glob / pwsh ...) directly. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Do not use todo_write to track this planning phase. When ready, call exit_plan_mode with the complete plan markdown starting with a # title, as the only and final tool call of that response; after approval the session moves to execution mode, where only run_code is direct-callable.',
  actReminder: 'Execution mode (act): only run_code may be called directly — put every other call inside the program as await tools.name(args); workflow / plugin_manager are unavailable here, orchestrate with subagent / subagent_fork. The program budget is the runtime timeout (default 120000 ms) and it counts nested tool and approval waits, so when a program must ask the user a question or wait on an approval, pass a larger timeoutMs (the deployment caps it, 600000 ms by default); otherwise split long work into several calls instead of writing one program that overruns it. ' + ACT_PROGRAM_RULES,
  /** Reminder used when the PTC transport is missing (degraded session). */
  degradedReminder: 'Execution mode (act, DEGRADED): run_code is unavailable because the PTC transport could not be loaded, so this session runs the native tools directly. Call the native tools; do not call run_code. The catalog is unchanged, so this is the only signal that the session degraded.',
}

/**
 * Resolve the installed DSH package root that holds the executor modules.
 * @returns absolute path to the @deepseek-ai directory.
 */
export async function resolveInstallBase() {
  const path = await import('node:path')
  const { existsSync } = await import('node:fs')
  const candidates = []
  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install.length > 0) {
    // DSH_INSTALL_DIR names the dsh package itself; its parent is @deepseek-ai.
    candidates.push(path.basename(install) === 'dsh' ? path.dirname(install) : path.join(install, 'node_modules', '@deepseek-ai'))
    candidates.push(path.join(install, 'node_modules', '@deepseek-ai'))
  }
  const tail = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai']
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
 * Import one official package: normal resolution first (a profile that carries
 * the peers resolves them), then the running installation's own copy.
 *
 * The installation copy lives inside app.asar, which only Electron's own
 * loader can read; both `import()` of its file URL and `require()` through a
 * resolution root there resolve to the module the host already loaded, so the
 * classes keep their identity instead of duplicating.
 * @param name - the @deepseek-ai package name.
 * @returns the module namespace.
 */
export async function loadOfficial(name) {
  const failures = []
  try {
    return await import(name)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  let base
  try {
    base = await resolveInstallBase()
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    throw new Error('cannot load ' + name + ': ' + failures.join(' | '))
  }
  const path = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  try {
    return await import(pathToFileURL(path.join(base, name, 'lib', 'index.js')).href)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const { createRequire } = await import('node:module')
    const requireFrom = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
    return requireFrom(name)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  throw new Error('cannot load ' + name + ': ' + failures.join(' | '))
}

/**
 * Import the executor modules from the running installation.
 * @returns the two module namespaces.
 */
async function loadModules() {
  const [native, ptc] = await Promise.all([
    loadOfficial('@deepseek-ai/dsh-tool-executor-native'),
    loadOfficial('@deepseek-ai/dsh-tool-executor-ptc'),
  ])
  return { native, ptc }
}

/**
 * Read committed plan-mode state from the plan projection.
 *
 * `ctx.planMode` lives inside the preset's `planning` isolate realm and is not
 * readable from a sibling row, so the projection is the supported substitute
 * (`Session.eventAt` is prohibited for new calls).
 * @param ctx - plugin context.
 * @param session - owning session.
 * @param event - the triggering event, when it carries the flip.
 * @returns whether plan mode is committed active, or undefined when unreadable.
 */
export function planActive(ctx, session, event) {
  if (event !== undefined && event.type === 'plan/mode') return event.data.active === true
  if (session === undefined) return undefined
  try {
    const plan = ctx.get('sessionProjections')?.snapshot(session, ['plan'])?.values?.plan
    return plan === undefined ? undefined : plan.active === true
  } catch (error) {
    ctx.logger?.warn?.('superset-router: cannot read the plan projection: ' + (error?.message ?? String(error)))
    return undefined
  }
}

/**
 * Drop plan-mode's guidance section from an assembled prompt. The official
 * section only exists while plan mode is active, so letting it through would
 * change the system prompt at the plan/act boundary and invalidate the whole
 * provider prefix cache. The guidance is delivered as a runtime-context user
 * message instead, which only appends.
 * @param presentation - assembled prompt sections.
 * @returns the same presentation, with the plan-policy section removed.
 */
export function stripPlanPolicy(presentation) {
  const sections = presentation?.sections
  if (!Array.isArray(sections)) return presentation
  const filtered = sections.filter(section => section?.name !== PLAN_POLICY_SECTION)
  return filtered.length === sections.length ? presentation : { ...presentation, sections: filtered }
}

/**
 * Fill the tool name into a model-facing denial.
 * @param template - message carrying an optional {tool} placeholder.
 * @param tool - the refused tool name.
 * @returns the rendered message.
 */
function renderTool(template, tool) {
  return String(template).split('{tool}').join(tool)
}

/**
 * Whether one model batch must run on the PTC executor.
 *
 * `ToolExecutor.execute()` receives the whole batch (`calls`), so the routing
 * decision is per batch, not per call: a batch that names `run_code` goes to
 * the PTC executor (which also owns the "only run_code is direct-callable"
 * refusal for any native call that shares the batch); every other batch stays
 * on the native executor.
 * @param calls - the batch's tool-call blocks.
 * @returns true when the batch contains a run_code call.
 */
export function needsPtc(calls) {
  return Array.isArray(calls) && calls.some(call => call?.name === RUN_CODE_NAME)
}

/**
 * Phase policy over the single catalog.
 *
 * Nesting is decided by `execution.parent`, the transport token a PTC program
 * sets on its sub-dispatches. `rootCallId` is NOT a nesting signal: the
 * pipeline resolves it for every root and nested execution alike.
 * @param phase - current phase.
 * @param execution - tool execution identity.
 * @param hidden - tools the PTC preset does not expose inside programs.
 * @param messages - model-facing denial texts.
 * @param ptcReady - whether the PTC transport can actually be dispatched; when
 *   false the policy fails open instead of locking every direct call.
 * @returns a deny decision, or undefined when the call may proceed.
 */
export function decide(phase, execution, hidden = DEFAULTS.actHiddenTools, messages = DEFAULT_MESSAGES, ptcReady = true) {
  const tool = String(execution?.name ?? '')
  if (tool === '') return undefined
  if (phase === 'plan') {
    if (tool !== RUN_CODE_NAME) return undefined
    return { kind: 'deny', reason: messages.planDenied }
  }
  if (phase !== 'act') return undefined
  // Degraded: run_code cannot be dispatched, so execution mode runs the native
  // tools. Never deny them here — a transport failure must not lock the session.
  if (!ptcReady) {
    if (tool !== RUN_CODE_NAME) return undefined
    return { kind: 'deny', reason: messages.degradedDenied }
  }
  if (execution?.parent !== undefined) {
    const hiddenSet = hidden instanceof Set
      ? hidden
      : new Set(Array.isArray(hidden) ? hidden : typeof hidden === 'string' ? [hidden] : [])
    if (hiddenSet.has(tool)) return { kind: 'deny', reason: renderTool(messages.actHidden, tool) }
    return undefined
  }
  if (tool === RUN_CODE_NAME) return undefined
  return { kind: 'deny', reason: renderTool(messages.actDirect, tool) }
}

/**
 * Register the superset router and its phase policy.
 * @param ctx - Cordis plugin context.
 * @param config - optional overrides for DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const presets = new Set(Array.isArray(cfg.presets) ? cfg.presets : [cfg.presets])
  const messages = {
    planDenied: cfg.planDeniedMessage ?? DEFAULT_MESSAGES.planDenied,
    actDirect: cfg.actDirectMessage ?? DEFAULT_MESSAGES.actDirect,
    actHidden: cfg.actHiddenMessage ?? DEFAULT_MESSAGES.actHidden,
    degradedDenied: cfg.degradedDeniedMessage ?? DEFAULT_MESSAGES.degradedDenied,
  }
  const states = new Map()
  let mods
  let failed = false

  loadModules().then((loaded) => {
    mods = loaded
    ctx.logger?.info?.('superset-router: executor modules loaded')
  }).catch((error) => {
    failed = true
    ctx.logger?.warn?.('superset-router: disabled (executor modules unavailable): ' + (error?.message ?? String(error)))
  })

  // Keep the system prompt byte-identical across the plan/act boundary.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => stripPlanPolicy(await next()))

  // Phase reminder: appended by the runtime-context projection only when it changes.
  ctx.get('systemPrompt')?.context({
    name: PHASE_CONTEXT,
    order: cfg.reminderOrder,
    interpolate: false,
    text: (context) => {
      const scope = context?.scope
      const state = scope === undefined ? undefined : states.get(scope)
      if (state === undefined) return ''
      if (state.phase !== 'act') return cfg.planReminder
      return state.ptcReady === false ? cfg.degradedReminder : cfg.actReminder
    },
  })

  /**
   * Describe the one catalog both phases advertise.
   * @param state - router state for the calling agent.
   * @param admitted - the step's admitted definitions.
   * @returns the model-facing schema list plus its name universe.
   */
  function describeCatalog(state, admitted) {
    let definitions = admitted
    if (cfg.stableCatalog) {
      try {
        const all = state.tools.definitions(state.agent)
        if (Array.isArray(all) && all.length > 0) definitions = all
      } catch (error) {
        ctx.logger?.warn?.('superset-router: registry view unreadable, using the admitted set: ' + (error?.message ?? String(error)))
      }
    }
    const nativeSchemas = state.native.describe(definitions).schemas
    // A degraded session never advertises a transport it cannot dispatch. A
    // describe failure here also degrades instead of failing the assembly.
    let ptcSchemas = []
    if (state.ptcReady) {
      try {
        ptcSchemas = state.ptc.describe(definitions).schemas
      } catch (error) {
        state.ptcReady = false
        ctx.logger?.error?.('superset-router DEGRADED: run_code disappeared from the catalog: ' + (error?.message ?? String(error)))
      }
    }
    const schemas = [...nativeSchemas, ...ptcSchemas]
    return { schemas, knownNames: schemas.map(schema => schema.name) }
  }

  /**
   * Probe whether the PTC transport can be described and dispatched.
   *
   * `PtcExecutor.describe()` resolves the runtime and projects the reserved
   * `run_code` schema; when that throws (no `ptcRuntime`, missing SDK renderer,
   * broken module copy) the transport cannot be dispatched either. Treating the
   * probe result as the routing capability is what keeps a broken transport
   * from locking the session: the catalog drops `run_code` and execution mode
   * fail-opens to the native tools.
   * @param ptc - the constructed PTC executor.
   * @returns whether `run_code` is present in the executor's own description.
   */
  function probePtc(ptc) {
    try {
      const schemas = ptc.describe([])?.schemas
      return Array.isArray(schemas) && schemas.some(schema => schema?.name === RUN_CODE_NAME)
    } catch (error) {
      ctx.logger?.error?.('superset-router: the PTC transport is unusable: ' + (error?.message ?? String(error)))
      return false
    }
  }

  /**
   * Create and install the agent-scoped router on first use.
   *
   * The router registers into `agent.ctx`, whose scope tag is the agent itself:
   * `ToolsService.setExecutor` resolves the scope from the CALLING context, so
   * the selection overrides the preset-scope PTC executor for this agent only.
   * It is never disposed — a released registration leaves the selection
   * unavailable instead of falling back.
   * @param agent - live agent handle, also the scope key.
   * @returns router state, or undefined when routing is unavailable.
   */
  function ensure(agent) {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    if (failed || mods === undefined) return undefined
    let tools
    try {
      tools = agent.ctx.get('tools')
    } catch (error) {
      ctx.logger?.warn?.('superset-router: cannot reach tools from the agent scope: ' + (error?.message ?? String(error)))
      return undefined
    }
    if (tools === undefined) return undefined
    let native
    let ptc
    try {
      native = new mods.native.NativeToolExecutor(agent.ctx)
      // The PTC runtime is resolved from the context, so the program budget is
      // exactly the deployment's configured one (no private override).
      ptc = new mods.ptc.PtcExecutor(agent.ctx, {
        maxSubCallsPerMinute: cfg.subCallsPerMinute,
        maxParallelSubCalls: cfg.maxParallelSubCalls,
      })
    } catch (error) {
      ctx.logger?.warn?.('superset-router: cannot build executors: ' + (error?.message ?? String(error)))
      return undefined
    }
    const sectionOrder = ctx.get('systemPrompt')?.getSectionOrder?.('TOOLS_SDK') ?? 5000
    const ptcReady = probePtc(ptc)
    const state = { phase: 'act', agent, tools, native, ptc, ptcReady }
    if (!ptcReady) {
      // Loud, once per agent: the session is running a different effective mode
      // than the preset promises, and the reminder tells the model so.
      ctx.logger?.error?.('superset-router DEGRADED for ' + String(agent.id) + ': run_code is unavailable, so execution mode falls back to the native tools instead of denying every direct call.')
    }
    const router = {
      sections: [{
        name: GUIDE_SECTION,
        order: sectionOrder,
        interpolate: false,
        text: ptcReady ? cfg.guideSection : cfg.degradedGuide,
      }],
      describe: (admitted) => describeCatalog(state, admitted),
      // `input` is the whole ToolBatchInput (`calls`), never a single call:
      // routing must inspect the batch, or run_code is silently sent to the
      // native executor and fails as `unknown tool "run_code"`.
      execute: (input) => {
        const calls = Array.isArray(input?.calls) ? input.calls : []
        if (!needsPtc(calls) || !state.ptcReady) return state.native.execute(input)
        return state.ptc.execute(input)
      },
    }
    try {
      tools.setExecutor(router)
    } catch (error) {
      ctx.logger?.warn?.('superset-router: cannot install the router (staying on the preset executor): ' + (error?.message ?? String(error)))
      return undefined
    }
    states.set(agent, state)
    agent.ctx.effect(() => () => { states.delete(agent) })
    ctx.logger?.info?.('superset-router: installed for ' + String(agent.id))
    return state
  }

  /**
   * Resolve the preset a session actually runs under. The header records the
   * preset a session STARTED with; only the agentPreset projection advances
   * with a later selection.
   * @param session - session to inspect.
   * @returns current preset id, or undefined when it cannot be read.
   */
  function presetOf(session) {
    if (session === undefined) return undefined
    try {
      const current = ctx.get('agentPresets')?.presetForSession?.(session)
      if (current !== undefined && current !== null) return current
    } catch (error) {
      ctx.logger?.warn?.('superset-router: cannot read the agentPreset projection: ' + (error?.message ?? String(error)))
    }
    return session.header?.agentPreset
  }

  /**
   * Align one agent's phase with the committed plan-mode state.
   * @param agent - live agent handle.
   * @param session - its session.
   * @param event - the event that triggered the sync, when it carries the flip.
   */
  function align(agent, session, event) {
    if (failed) return
    const presetId = presetOf(session)
    if (presetId === undefined || !presets.has(presetId)) return
    const active = planActive(ctx, session, event) === true
    const state = ensure(agent)
    if (state === undefined) return
    const next = active ? 'plan' : 'act'
    if (state.phase !== next) {
      state.phase = next
      ctx.logger?.info?.('superset-router: phase=' + next + ' session=' + String(session.id))
    }
  }

  /**
   * Align one session, recovering the live agent from the registry.
   * @param session - session whose events fired the sync.
   * @param event - the event that fired it.
   */
  function sync(session, event) {
    try {
      const agent = ctx.get('agents')?.get(session.id)
      if (agent === undefined) return
      align(agent, session, event)
    } catch (error) {
      ctx.logger?.warn?.('superset-router: sync failed: ' + (error?.message ?? String(error)))
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'plan/mode' && event.type !== 'turn/start') return
    sync(session, event)
  })

  // Backstop: the pre-step hook carries the live agent, so a router whose
  // modules finished loading late still installs before the next request.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const agent = payload?.agent
      if (agent !== undefined) align(agent, agent.session, undefined)
    } catch (error) {
      ctx.logger?.warn?.('superset-router: pre-step sync failed: ' + (error?.message ?? String(error)))
    }
    return decision
  })

  // Phase interception over the single catalog.
  ctx.on('tools/pre-execute', async (execution, next) => {
    try {
      const agent = execution?.agent
      const state = agent === undefined ? undefined : states.get(agent)
      if (state === undefined) return next()
      const decision = decide(state.phase, execution, cfg.actHiddenTools, messages, state.ptcReady !== false)
      return decision === undefined ? next() : decision
    } catch (error) {
      ctx.logger?.warn?.('superset-router: guard fail-open: ' + (error?.message ?? String(error)))
      return next()
    }
  })
}
