// Registry adapter: exposes the Appflow migration flow as a PlatformFlow, the
// same way ios-flow.ts / android-flow.ts expose theirs. The appflow flow already
// returns the neutral StepView, so this is a thin re-export.
export { appflowFlow } from '../appflow/flow.js'
export type { AppflowEffectDeps, AppflowEffectResult, AppflowValidationResult } from '../appflow/flow.js'
