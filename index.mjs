/**
 * dsh-presets-plan-native-act-ptc: the `ptc-hybrid` preset and its router.
 *
 * The preset declares the standard preset's tool catalog plus the PTC
 * transport, so one request carries both catalogs and the phase is enforced by
 * policy instead of by swapping executors. This entry point forwards to the
 * router so the preset row can name the package root; the same module is also
 * exported as `dsh-presets-plan-native-act-ptc/plugins/superset-router`.
 *
 * Why one catalog: the request prefix is tools -> system -> messages, so a
 * phase-dependent tool list (or a phase-dependent system prompt section)
 * recomputes the whole prefix at the boundary. Keeping both constant makes
 * plan <-> act an append-only transition.
 */
export { name, inject, apply, DEFAULTS, planActive, stripPlanPolicy, decide, needsPtc, loadOfficial, resolveInstallBase } from './plugins/superset-router.mjs'
