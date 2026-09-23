import type { UserModule } from '~/types'
import { i18n } from '~/modules/i18n'
import {
  confirmOnboardingDashboardExplorationNavigation,
  resolveOnboardingHardGateResumeAppId,
} from '~/services/onboardingDashboardExplorationConfirm'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { getOnboardingContinueSetupRoute, isOnboardingDirectEntryGuardPath } from '~/utils/onboardingRedirect'

export const install: UserModule = ({ router }) => {
  router.beforeEach(async (to, from) => {
    if (!isOnboardingDirectEntryGuardPath(to.path))
      return

    const main = useMainStore()
    const userId = main.user?.id ?? main.auth?.id
    if (!userId)
      return

    const currentSource = typeof from.query.source === 'string' ? from.query.source : null
    const currentStep = typeof from.query.step === 'string' ? from.query.step : null
    const resumeQuery = typeof from.query.resume === 'string'
      ? from.query.resume
      : typeof to.query.resume === 'string'
        ? to.query.resume
        : null
    const resumeAppId = resolveOnboardingHardGateResumeAppId(from.path, resumeQuery, userId)
    const dialogStore = useDialogV2Store()
    const result = await confirmOnboardingDashboardExplorationNavigation({
      currentPath: from.path,
      currentSource,
      currentStep,
      destination: to.path,
      resumeAppId,
      userId,
      t: i18n.global.t,
      dialogStore,
      router,
    })

    if (result === 'proceed')
      return
    if (result === 'handled')
      return false

    const continueRoute = getOnboardingContinueSetupRoute({
      currentPath: from.path,
      currentSource,
      currentStep,
      resumeAppId,
    })
    if (continueRoute)
      return continueRoute
    return false
  })
}
