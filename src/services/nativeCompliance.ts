import { Capacitor } from '@capacitor/core'

const nativeExternalPurchaseRestrictedPaths = [
  '/billing',
  '/invitation',
  '/onboarding/app',
  '/onboarding/invitation',
  '/onboarding/organization',
  '/register',
  '/settings/organization/credits',
  '/settings/organization/plans',
]

function normalizePath(path: string) {
  let normalized = path
  while (normalized.length > 1 && normalized.endsWith('/'))
    normalized = normalized.slice(0, -1)
  return normalized || '/'
}

export function isNativeAppStoreContext() {
  return Capacitor.isNativePlatform()
}

export function isNativeExternalPurchaseRestrictedPath(path: string) {
  const normalizedPath = normalizePath(path)
  return nativeExternalPurchaseRestrictedPaths.some((restrictedPath) => {
    return normalizedPath === restrictedPath || normalizedPath.startsWith(`${restrictedPath}/`)
  })
}

export function getNativeExternalPurchaseRedirect(path: string) {
  const normalizedPath = normalizePath(path)
  if (
    normalizedPath === '/register'
    || normalizedPath.startsWith('/register/')
    || normalizedPath === '/invitation'
    || normalizedPath.startsWith('/invitation/')
  ) {
    return '/login'
  }

  if (
    normalizedPath === '/onboarding/app'
    || normalizedPath.startsWith('/onboarding/app/')
    || normalizedPath === '/onboarding/invitation'
    || normalizedPath.startsWith('/onboarding/invitation/')
    || normalizedPath === '/onboarding/organization'
    || normalizedPath.startsWith('/onboarding/organization/')
  ) {
    return '/scan'
  }

  if (
    normalizedPath === '/settings/organization/credits'
    || normalizedPath.startsWith('/settings/organization/credits/')
    || normalizedPath === '/settings/organization/plans'
    || normalizedPath.startsWith('/settings/organization/plans/')
    || normalizedPath === '/billing'
    || normalizedPath.startsWith('/billing/')
  ) {
    return '/settings/organization/usage'
  }

  // Fallback for future restricted paths that are not explicitly mapped above.
  return '/dashboard'
}
