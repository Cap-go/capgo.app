const PENDING_INVITE_SKIP_STORAGE_KEY = 'capgo:pending-invite-skip-user'

function canUseSessionStorage() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage !== undefined
  }
  catch {
    return false
  }
}

export function rememberPendingInviteSkip(userId: string | null | undefined) {
  if (!userId || !canUseSessionStorage())
    return

  try {
    window.sessionStorage.setItem(PENDING_INVITE_SKIP_STORAGE_KEY, userId)
  }
  catch {
    // Storage can be blocked in private or restricted browsing contexts.
  }
}

export function hasPendingInviteSkip(userId: string | null | undefined) {
  if (!userId || !canUseSessionStorage())
    return false

  try {
    return window.sessionStorage.getItem(PENDING_INVITE_SKIP_STORAGE_KEY) === userId
  }
  catch {
    return false
  }
}

export function clearPendingInviteSkip(userId: string | null | undefined) {
  if (!userId || !canUseSessionStorage())
    return

  try {
    if (window.sessionStorage.getItem(PENDING_INVITE_SKIP_STORAGE_KEY) === userId)
      window.sessionStorage.removeItem(PENDING_INVITE_SKIP_STORAGE_KEY)
  }
  catch {
    // Storage can be blocked in private or restricted browsing contexts.
  }
}
