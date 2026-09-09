import { shouldSkipOnboardingResume } from '~/utils/appOnboardingProgress'

// August uses Central European Summer Time (UTC+2).
export const ONBOARDING_REDIRECT_CUTOFF = Date.parse('2026-08-04T01:00:00+02:00')
export const ONBOARDING_DASHBOARD_EXPLORED_EVENT = 'capgo:onboarding-dashboard-explored'

const DASHBOARD_EXPLORATION_STORAGE_KEY = 'capgo:onboarding-dashboard-exploration'
const PENDING_FIRST_UPLOAD_STORAGE_KEY = 'capgo:onboarding-pending-first-upload'

interface DashboardExploration {
  userId: string
  resumeAppId: string | null
}

interface PendingFirstUpload {
  userId: string
  appId: string
}

// Module memory keeps the grant alive when session storage is blocked, for
// example in private or restricted browsing contexts.
let dashboardExplorationFallback: DashboardExploration | null = null
let pendingFirstUploadFallback: PendingFirstUpload | null = null

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

function parsePendingFirstUpload(raw: string | null): PendingFirstUpload | null {
  if (!raw)
    return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as { userId?: unknown }).userId === 'string'
      && typeof (parsed as { appId?: unknown }).appId === 'string'
    ) {
      return {
        userId: (parsed as { userId: string }).userId,
        appId: (parsed as { appId: string }).appId,
      }
    }
  }
  catch {
    // Ignore unreadable storage.
  }
  return null
}

function readStoredPendingFirstUpload(): PendingFirstUpload | null {
  for (const storage of webStorages()) {
    try {
      const parsed = parsePendingFirstUpload(storage.getItem(PENDING_FIRST_UPLOAD_STORAGE_KEY))
      if (parsed)
        return parsed
    }
    catch {
      // Ignore unreadable storage.
    }
  }
  return null
}

function writeStoredPendingFirstUpload(state: PendingFirstUpload) {
  const raw = JSON.stringify(state)
  for (const storage of webStorages()) {
    try {
      storage.setItem(PENDING_FIRST_UPLOAD_STORAGE_KEY, raw)
    }
    catch {
      // Storage can be blocked in private or restricted browsing contexts.
    }
  }
}

function removeStoredPendingFirstUpload() {
  for (const storage of webStorages()) {
    try {
      storage.removeItem(PENDING_FIRST_UPLOAD_STORAGE_KEY)
    }
    catch {
      // Ignore blocked storage.
    }
  }
}

function readPendingFirstUpload(): PendingFirstUpload | null {
  if (pendingFirstUploadFallback)
    return pendingFirstUploadFallback
  return readStoredPendingFirstUpload()
}

function matchingPendingFirstUpload(userId: string | null | undefined): PendingFirstUpload | null {
  if (!userId)
    return null
  const state = readPendingFirstUpload()
  return state?.userId === userId ? state : null
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

function hasScopedDashboardExplorationGrant(
  userId: string | null | undefined,
  resumeAppId: string | null | undefined,
): boolean {
  const state = matchingDashboardExploration(userId)
  if (!state)
    return false

  return state.resumeAppId === (resumeAppId ?? null)
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
  // Explore anyway (and other explicit grants) end the post-create hard-gate.
  clearPendingFirstUploadAppId(userId)
}

export function setPendingFirstUploadAppId(userId: string | null | undefined, appId: string | null | undefined) {
  if (!userId || !appId)
    return

  const state: PendingFirstUpload = { userId, appId }
  pendingFirstUploadFallback = state
  writeStoredPendingFirstUpload(state)
}

export function getPendingFirstUploadAppId(userId: string | null | undefined) {
  return matchingPendingFirstUpload(userId)?.appId ?? null
}

export function clearPendingFirstUploadAppId(userId: string | null | undefined) {
  if (!userId)
    return

  const current = matchingPendingFirstUpload(userId)
  if (!current)
    return

  pendingFirstUploadFallback = null
  removeStoredPendingFirstUpload()
}

export function canExploreOnboardingDashboard(
  userId: string | null | undefined,
  resumeAppId?: string | null,
) {
  return hasScopedDashboardExplorationGrant(userId, resumeAppId)
}

const ONBOARDING_CONSOLE_ESCAPE_DESTINATIONS = new Set([
  '/dashboard',
  '/apps',
  '/apikeys',
  '/scan',
])

export function isPreCreateOnboardingPath(
  path: string | null | undefined,
  options?: { source?: string | null },
) {
  if (!path)
    return false
  if (path === '/app/new' || path === '/onboarding/app')
    return true
  // /onboarding/organization is shared: first-app create hard-gates, but
  // org-switcher / add-another-org should not. Other /onboarding/* routes
  // (invitation, set_password, …) are not first-app create.
  if (path === '/onboarding/organization' || path.startsWith('/onboarding/organization/'))
    return options?.source !== 'org-switcher'
  return false
}

export function getOnboardingContinueSetupRoute(options: {
  currentPath?: string | null
  currentSource?: string | null
  currentStep?: string | null
  resumeAppId: string | null | undefined
}) {
  if (isPreCreateOnboardingPath(options.currentPath, { source: options.currentSource }))
    return null
  if (!options.resumeAppId)
    return null

  const query: Record<string, string> = { resume: options.resumeAppId }
  if (typeof options.currentStep === 'string' && options.currentStep)
    query.step = options.currentStep

  return { path: '/app/new', query }
}

export function shouldConfirmOnboardingDashboardExploration(options: {
  currentPath?: string | null
  currentSource?: string | null
  destination: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
}) {
  if (!ONBOARDING_CONSOLE_ESCAPE_DESTINATIONS.has(options.destination))
    return false
  if (canExploreOnboardingDashboard(options.userId, options.resumeAppId))
    return false

  // Org-switcher / add-another-org remains a power-user escape even when a
  // first app still has a sticky pending-first-upload flag.
  const onOrganizationOnboarding = options.currentPath === '/onboarding/organization'
    || !!options.currentPath?.startsWith('/onboarding/organization/')
  if (onOrganizationOnboarding && options.currentSource === 'org-switcher')
    return false

  // Confirm before empty-product escapes while first-app create or first-bundle
  // setup is still in progress — resume id, sticky pending upload, or active path.
  return !!options.resumeAppId
    || !!getPendingFirstUploadAppId(options.userId)
    || isPreCreateOnboardingPath(options.currentPath, {
      source: options.currentSource,
    })
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
  if (canExploreOnboardingDashboard(options.userId, options.appId))
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
