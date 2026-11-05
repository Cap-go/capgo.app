import type { AppOnboardingStepId } from '~/services/appOnboarding'
import type { BuilderPlatform, BuilderStepId } from '~/services/builderOnboardingChecklist'
import { invokeCapgoApi } from '~/services/capgoApi'

// The backend only accepts steps that were passed over (a later step is done).
export async function skipOnboardingStep(appId: string, step: `ota.${AppOnboardingStepId}` | `builder.${BuilderPlatform}.${BuilderStepId}`, reason: string) {
  const { data, error } = await invokeCapgoApi<{ onboarding: unknown }>('private/onboarding_progress/skip_step', {
    body: { appId, step, reason },
    retries: 0,
  })
  if (error)
    throw error
  return data?.onboarding
}
