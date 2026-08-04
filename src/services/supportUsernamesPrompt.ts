const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function dismissedKey(userId: string) {
  return `capgo.supportUsernames.dismissed.${userId}`
}

function lastShownKey(userId: string) {
  return `capgo.supportUsernames.lastShown.${userId}`
}

export function hasSupportUsernames(user: { discord_username?: string | null, github_username?: string | null } | null | undefined) {
  return Boolean(user?.discord_username && user?.github_username)
}

export function isOnboardingOrganizationSet(organizations: Array<{ app_count: number, all_apps_need_onboarding?: boolean }>) {
  return organizations.length === 1
    && (organizations[0].app_count <= 1 || organizations[0].all_apps_need_onboarding === true)
}

export function isSupportUsernamesPromptDismissedForever(userId: string) {
  if (typeof localStorage === 'undefined')
    return false
  return localStorage.getItem(dismissedKey(userId)) === '1'
}

export function dismissSupportUsernamesPromptForever(userId: string) {
  if (typeof localStorage === 'undefined')
    return
  localStorage.setItem(dismissedKey(userId), '1')
}

export function markSupportUsernamesPromptShown(userId: string) {
  if (typeof localStorage === 'undefined')
    return
  localStorage.setItem(lastShownKey(userId), new Date().toISOString())
}

export function shouldShowSupportUsernamesPrompt(user: { id: string, discord_username?: string | null, github_username?: string | null } | null | undefined) {
  if (!user?.id || hasSupportUsernames(user))
    return false
  if (typeof localStorage === 'undefined')
    return false
  if (isSupportUsernamesPromptDismissedForever(user.id))
    return false

  const lastShown = localStorage.getItem(lastShownKey(user.id))
  if (lastShown) {
    const lastShownAt = Date.parse(lastShown)
    if (!Number.isNaN(lastShownAt) && Date.now() - lastShownAt < WEEK_MS)
      return false
  }

  return true
}
