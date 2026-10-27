import type { SetupMethod } from '~/utils/onboardingSetupMode'
import { computed } from 'vue'
import { replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useMainStore } from '~/stores/main'
import { readSetupMethod, withSetupMethod } from '~/utils/onboardingSetupMode'

/**
 * AI-or-manual ordering shared by every setup choice: the AI agent comes first unless the
 * user last picked the manual way. Choices are saved on the user so every device agrees.
 */
export function useSetupMethodPreference() {
  const main = useMainStore()
  const method = computed(() => readSetupMethod(main.user?.onboarding))
  const manualFirst = computed(() => method.value === 'manual')

  // Saving only reorders future choices, so a failed write never blocks the user.
  async function rememberSetupMethod(next: SetupMethod) {
    const userId = main.user?.id
    if (!userId || readSetupMethod(main.user?.onboarding) === next)
      return
    try {
      await serializeUserOnboardingWrite(userId, async () => {
        const result = await replaceUserOnboardingWithRetry(
          userId,
          main.user!.onboarding,
          current => withSetupMethod(current, next),
          () => main.user?.id === userId,
        )
        if (result.status === 'persisted' && main.user?.id === userId)
          main.user = { ...main.user, onboarding: result.onboarding }
      })
    }
    catch (error) {
      console.warn('Cannot save the setup method preference', error)
    }
  }

  return { method, manualFirst, rememberSetupMethod }
}
