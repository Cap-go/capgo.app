import type { Router } from 'vue-router'
import type { useDialogV2Store } from '~/stores/dialogv2'
import {
  allowOnboardingDashboardExploration,
  getOnboardingContinueSetupRoute,
  getOnboardingResumeAppId,
  ONBOARDING_DASHBOARD_EXPLORED_EVENT,
  shouldConfirmOnboardingDashboardExploration,
} from '~/utils/onboardingRedirect'

export function resolveOnboardingHardGateResumeAppId(
  path: string,
  resumeQuery: string | null | undefined,
  userId: string | null | undefined,
) {
  const resumeQueryAppId = resumeQuery ?? null
  if (path === '/app/new' && resumeQueryAppId) {
    return resumeQueryAppId
  }
  return getOnboardingResumeAppId(userId)
}

export type OnboardingDashboardExplorationConfirmResult = 'proceed' | 'handled' | 'cancelled'

export async function confirmOnboardingDashboardExplorationNavigation(options: {
  currentPath: string
  currentSource?: string | null
  currentStep?: string | null
  destination: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
  t: (key: string) => string
  dialogStore: ReturnType<typeof useDialogV2Store>
  router: Router
}): Promise<OnboardingDashboardExplorationConfirmResult> {
  if (!shouldConfirmOnboardingDashboardExploration({
    currentPath: options.currentPath,
    currentSource: options.currentSource,
    destination: options.destination,
    resumeAppId: options.resumeAppId,
    userId: options.userId,
  })) {
    return 'proceed'
  }

  options.dialogStore.openDialog({
    title: options.t('app-onboarding-explore-dashboard-confirm-title'),
    description: options.t('app-onboarding-explore-dashboard-confirm-description'),
    buttons: [
      { text: options.t('app-onboarding-continue-setup'), role: 'primary' },
      { text: options.t('app-onboarding-explore-dashboard'), role: 'secondary' },
    ],
  })
  const wasCanceled = await options.dialogStore.onDialogDismiss()
  if (wasCanceled) {
    return 'cancelled'
  }

  if (options.dialogStore.lastButtonRole === 'primary') {
    const continueRoute = getOnboardingContinueSetupRoute({
      currentPath: options.currentPath,
      currentSource: options.currentSource,
      currentStep: options.currentStep,
      resumeAppId: options.resumeAppId,
    })
    if (continueRoute) {
      await options.router.push(continueRoute)
      return 'handled'
    }
    return 'cancelled'
  }
  if (options.dialogStore.lastButtonRole !== 'secondary') {
    return 'cancelled'
  }

  window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))
  allowOnboardingDashboardExploration(options.userId, options.resumeAppId)
  return 'proceed'
}
