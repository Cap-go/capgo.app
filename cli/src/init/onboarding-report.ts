import { env } from 'node:process'
import { getInvocationSource } from '../analytics/global-props'
import { reportAppOnboardingProgress } from '../api/app'
import { initOnboardingSteps, type InitOnboardingStepId } from './ui'

export type ReportedOnboardingSource = 'cli' | 'mcp' | 'ai'

const AI_AGENT_ENV_KEYS = [
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'AIDER',
  'GEMINI_CLI',
  'CODEX_CLI',
  'CAPGO_ONBOARDING_SOURCE',
] as const

export function detectOnboardingSource(): ReportedOnboardingSource {
  if (getInvocationSource() === 'mcp')
    return 'mcp'
  if (isAiAgentEnvironment())
    return 'ai'
  return 'cli'
}

export function isAiAgentEnvironment(environment: NodeJS.ProcessEnv = env): boolean {
  if (environment.CAPGO_ONBOARDING_SOURCE === 'ai')
    return true
  return AI_AGENT_ENV_KEYS.some(key => key !== 'CAPGO_ONBOARDING_SOURCE' && Boolean(environment[key]))
}

export async function reportInitOnboardingStep(
  apikey: string,
  appId: string | undefined,
  stepNumber: number,
  status: 'done' | 'skipped' = 'done',
  options?: { supaHost?: string, supaAnon?: string, outcome?: 'completed' | 'skipped' | 'in_progress' },
): Promise<void> {
  const step = initOnboardingSteps[stepNumber - 1]
  if (!appId || !step)
    return

  await reportInitOnboarding(apikey, appId, {
    [step.id]: { status },
  }, options)
}

export async function reportInitOnboarding(
  apikey: string,
  appId: string,
  steps: Partial<Record<InitOnboardingStepId, { status: 'done' | 'skipped' }>>,
  options?: { supaHost?: string, supaAnon?: string, outcome?: 'completed' | 'skipped' | 'in_progress' | 'switched_to_manual' },
): Promise<void> {
  try {
    await reportAppOnboardingProgress(apikey, appId, {
      source: detectOnboardingSource(),
      outcome: options?.outcome,
      steps,
    }, options)
  }
  catch {
    // Progress reporting must never interrupt onboarding.
  }
}
