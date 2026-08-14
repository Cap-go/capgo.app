import type { InitOnboardingStepId } from './onboarding-steps'
import { reportAppOnboardingProgress } from '../api/app'
import { detectOnboardingSource } from './onboarding-source'
import { initOnboardingSteps } from './onboarding-steps'

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
