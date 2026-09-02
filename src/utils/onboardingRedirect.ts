import { shouldSkipOnboardingResume } from '~/utils/appOnboardingProgress'

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

function webStorages(): Storage[] {
  if (typeof window === 'undefined')
    return []

  const storages: Storage[] = []
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[key]
      if (storage)
        storages.push(storage)
    }
    catch {
      // Storage can be missing or blocked in private / non-browser contexts.
    }
  }
  return storages
}

function parseExploration(raw: string | null): DashboardExploration | null {
  if (!raw)
    return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as { userId?: unknown }).userId === 'string') {
      const resumeAppId = (parsed as { resumeAppId?: unknown }).resumeAppId
      return {
        userId: (parsed as { userId: string }).userId,
        resumeAppId: typeof resumeAppId === 'string' ? resumeAppId : null,
      }
    }
  }
  catch {
    // Ignore unreadable storage.
  }
  return null
}

function readStoredExploration(): DashboardExploration | null {
  for (const storage of webStorages()) {
    try {
      const parsed = parseExploration(storage.getItem(DASHBOARD_EXPLORATION_STORAGE_KEY))
      if (parsed)
        return parsed
    }
    catch {
      // Ignore unreadable storage.
    }
  }
  return null
}

function writeStoredExploration(state: DashboardExploration) {
  const raw = JSON.stringify(state)
  for (const storage of webStorages()) {
    try {
      storage.setItem(DASHBOARD_EXPLORATION_STORAGE_KEY, raw)
    }
    catch {
      // Storage can be blocked in private or restricted browsing contexts.
    }
  }
}

function readDashboardExploration(): DashboardExploration | null {
  // In-memory grant is always the latest write in this tab. Prefer it so a
  // failed storage setItem cannot keep serving an older stored user.
  if (dashboardExplorationFallback)
    return dashboardExplorationFallback
  return readStoredExploration()
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
  writeStoredExploration(state)
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
  app: { app_id: string, need_onboarding: boolean, onboarding?: unknown } | null
  organizationAppCount: number
  organizationCount: number
}) {
  if (options.organizationCount !== 1 || options.organizationAppCount !== 1 || !options.app?.need_onboarding)
    return null
  if (shouldSkipOnboardingResume(options.app.onboarding))
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
