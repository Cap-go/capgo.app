// August uses Central European Summer Time (UTC+2).
export const ONBOARDING_REDIRECT_CUTOFF = Date.parse('2026-08-04T01:00:00+02:00')

let dashboardExplorationUserId: string | null = null
let dashboardExplorationResumeAppId: string | null = null

export function allowOnboardingDashboardExploration(userId: string | null | undefined, resumeAppId?: string | null) {
  dashboardExplorationUserId = userId ?? null
  dashboardExplorationResumeAppId = resumeAppId ?? null
}

export function canExploreOnboardingDashboard(userId: string | null | undefined) {
  return !!userId && dashboardExplorationUserId === userId
}

export function shouldConfirmOnboardingDashboardExploration(options: {
  destination: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
}) {
  return options.destination === '/dashboard'
    && !!options.resumeAppId
    && !canExploreOnboardingDashboard(options.userId)
}

export function getOnboardingResumeAppId(userId: string | null | undefined) {
  return canExploreOnboardingDashboard(userId) ? dashboardExplorationResumeAppId : null
}

export function isNewOnboardingUser(createdAt: string | null | undefined) {
  if (!createdAt)
    return false

  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) && timestamp > ONBOARDING_REDIRECT_CUTOFF
}

export function getOnboardingResumeRedirect(options: {
  appId: string | null | undefined
  appCount: number
  createdAt: string | null | undefined
  organizationCount: number
  path: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
}) {
  if (canExploreOnboardingDashboard(options.userId))
    return null
  if (!isNewOnboardingUser(options.createdAt))
    return null
  if (options.organizationCount !== 1 || options.appCount !== 1 || !options.appId)
    return null
  if (options.path === '/app/new' && options.resumeAppId === options.appId)
    return null

  return {
    path: '/app/new',
    query: { resume: options.appId },
  }
}
