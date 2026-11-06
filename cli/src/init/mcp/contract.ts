// src/init/mcp/contract.ts
// Result contract for the MCP-conducted Capgo live-update onboarding.

export type StepKind = 'auto' | 'human_gate' | 'choice' | 'done' | 'error' | 'info'
export type LiveUpdatePhase = 'preflight' | 'prepare' | 'integrate' | 'validate' | 'done'
export type Platform = 'ios' | 'android'

export interface ChoiceOption {
  value: string
  label?: string
  note?: string
}

export interface CollectField {
  field: string
  desc: string
}

export interface NextAction {
  tool: string
  with?: Record<string, unknown>
  call?: string
  instruction: string
}

export interface NextStepResult {
  onboarding: 'capgo-live-update'
  phase: LiveUpdatePhase
  state: string
  platform?: Platform
  progress: number
  kind: StepKind
  summary: string
  roadmap?: string[]
  context?: Record<string, unknown>
  options?: ChoiceOption[]
  human?: { instruction: string, resourceUri?: string }
  collect?: CollectField[]
  next?: NextAction
  rules?: string[]
}

export const NEXT_STEP_TOOL = 'capgo_live_update_onboarding_next_step'

export const LIVE_UPDATE_ROADMAP: string[] = [
  'Preflight — detect your Capacitor project and Capgo account',
  'Register the app, channel, and wire the updater plugin',
  'Build and run the baseline app on a device',
  'Upload a test bundle and confirm OTA delivery',
]

export const LIVE_UPDATE_RULES: string[] = [
  'You are conducting Capgo live-update (OTA) onboarding. Do not plan the steps yourself.',
  'Do exactly what the result\'s `next` says — never improvise the order or call other tools mid-flow.',
  'If kind is "human_gate", show `human.instruction` to the user, wait, then call `next.tool` with the values in `collect`.',
  'If kind is "choice", present `options` and call `next.tool` with the user\'s pick.',
  'Never edit the user\'s app files yourself during onboarding unless a result explicitly asks you to (only after the user chose that option), and then change only what it describes.',
  'Never tell the user a step succeeded unless a result confirms it.',
  'If the user is confused, asks what a step means, or does not understand the options, call capgo_live_update_onboarding_explain for a plain-language explanation — do not guess.',
  'Log in with `npx @capgo/cli@latest login` in the terminal. Never ask the user to paste their API key into chat.',
]

const SECRET_CONTEXT_KEY = /password|passphrase|secret|token|p12|p8|keycontent|credential/i

function redactSecretContext(context: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context))
    redacted[key] = SECRET_CONTEXT_KEY.test(key) && typeof value === 'string' ? '[redacted]' : value
  return redacted
}

export function renderResult(result: NextStepResult): string {
  const lines: string[] = []
  lines.push(`Capgo live-update onboarding — phase: ${result.phase} · step: ${result.state} · ${result.progress}%`)
  lines.push('')
  lines.push(result.summary)

  if (result.roadmap?.length) {
    lines.push('')
    lines.push('PLAN (show the user):')
    for (const item of result.roadmap)
      lines.push(`  • ${item}`)
  }
  if (result.human?.instruction) {
    lines.push('')
    lines.push(`ACTION FOR THE USER:\n${result.human.instruction}`)
    if (result.human.resourceUri)
      lines.push(`(Detailed guide: ${result.human.resourceUri})`)
  }
  if (result.options?.length) {
    lines.push('')
    lines.push('OPTIONS:')
    for (const o of result.options)
      lines.push(`  - ${o.value}${o.label ? ` (${o.label})` : ''}${o.note ? ` — ${o.note}` : ''}`)
  }
  if (result.collect?.length) {
    lines.push('')
    lines.push('COLLECT FROM THE USER:')
    for (const c of result.collect)
      lines.push(`  - ${c.field}: ${c.desc}`)
  }
  if (result.next) {
    lines.push('')
    lines.push(`DO THIS NEXT: ${result.next.instruction}`)
    if (result.next.call)
      lines.push(`Example call: ${result.next.call}`)
  }
  lines.push('')
  lines.push('---')
  const safeResult = result.context ? { ...result, context: redactSecretContext(result.context) } : result
  lines.push(JSON.stringify(safeResult, null, 2))
  return lines.join('\n')
}
