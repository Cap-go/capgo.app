import type { GettingStartedStepExtras } from '~/utils/appOnboardingProgress'
import { shouldShowGettingStartedNav } from '~/utils/appOnboardingProgress'

// August uses Central European Summer Time (UTC+2).
export const ONBOARDING_REDIRECT_CUTOFF = Date.parse('2026-08-04T01:00:00+02:00')
export const ONBOARDING_DASHBOARD_EXPLORED_EVENT = 'capgo:onboarding-dashboard-explored'

const DASHBOARD_EXPLORATION_STORAGE_KEY = 'capgo:onboarding-dashboard-exploration'

interface DashboardExploration {
  userId: string
  resumeAppId: string | null
}

// Module memory keeps the grant alive when session storage is blocked, for
// example in private or restricted browsing contexts.
let dashboardExplorationFallback: DashboardExploration | null = null

function canUseSessionStorage() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage !== undefined
  }
  catch {
    return false
  }
}

function readDashboardExploration(): DashboardExploration | null {
  // In-memory grant is always the latest write in this tab. Prefer it so a
  // failed sessionStorage setItem cannot keep serving an older stored user.
  if (dashboardExplorationFallback)
    return dashboardExplorationFallback
  if (!canUseSessionStorage())
    return null

  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_EXPLORATION_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed.userId === 'string') {
      return {
        userId: parsed.userId,
        resumeAppId: typeof parsed.resumeAppId === 'string' ? parsed.resumeAppId : null,
      }
    }
  }
  catch {
    // Ignore unreadable storage; there is no in-memory grant in this tab.
  }
  return null
}

function matchingDashboardExploration(userId: string | null | undefined): DashboardExploration | null {
  if (!userId)
    return null

  const state = readDashboardExploration()
  return state?.userId === userId ? state : null
}

function matchesAppPath(path: string, appId: string) {
  const candidates = new Set([appId, encodeURIComponent(appId)])
  for (const candidate of candidates) {
    const prefix = `/app/${candidate}`
    if (path === prefix || path.startsWith(`${prefix}/`))
      return true
  }
  return false
}

export function allowOnboardingDashboardExploration(userId: string | null | undefined, resumeAppId?: string | null) {
  if (!userId)
    return

  const state: DashboardExploration = { userId, resumeAppId: resumeAppId ?? null }
  dashboardExplorationFallback = state

  if (canUseSessionStorage()) {
    try {
      window.sessionStorage.setItem(DASHBOARD_EXPLORATION_STORAGE_KEY, JSON.stringify(state))
    }
    catch {
      // Storage can be blocked in private or restricted browsing contexts.
    }
  }
}

export function canExploreOnboardingDashboard(userId: string | null | undefined) {
  return !!matchingDashboardExploration(userId)
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
  return matchingDashboardExploration(userId)?.resumeAppId ?? null
}

export function getOnboardingExploreBannerAppId(options: {
  app: { app_id: string, need_onboarding: boolean } | null
  organizationAppCount: number
  organizationCount: number
}) {
  if (options.organizationCount !== 1 || options.organizationAppCount !== 1 || !options.app?.need_onboarding)
    return null

  return options.app.app_id
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
  if ((options.path === '/app/new' || options.path === '/onboarding/app') && options.resumeAppId === options.appId)
    return null
  // The pending app already exists. Let the user open it, its devices, bundles,
  // and settings without bouncing back to "create your new app".
  if (matchesAppPath(options.path, options.appId))
    return null

  return {
    path: '/onboarding/app',
    query: { resume: options.appId, step: 'setup' },
  }
}

const GETTING_STARTED_CONTINUE_PATHS = new Set(['/dashboard', '/apps', '/onboarding/app', '/app/new'])

export function getGettingStartedContinueRedirect(options: {
  appId: string | null | undefined
  appCount: number
  createdAt: string | null | undefined
  extras?: GettingStartedStepExtras
  ledger: Parameters<typeof shouldShowGettingStartedNav>[0]
  needOnboarding: boolean
  organizationCount: number
  path: string
  userId: string | null | undefined
}) {
  if (options.needOnboarding)
    return null
  if (canExploreOnboardingDashboard(options.userId))
    return null
  if (!isNewOnboardingUser(options.createdAt))
    return null
  if (options.organizationCount !== 1 || options.appCount !== 1 || !options.appId)
    return null
  if (!shouldShowGettingStartedNav(options.ledger, options.extras))
    return null
  if (!GETTING_STARTED_CONTINUE_PATHS.has(options.path))
    return null

  return {
    path: `/app/${encodeURIComponent(options.appId)}/getting-started`,
  }
}
