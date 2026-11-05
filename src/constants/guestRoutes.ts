// Routes that render without the dashboard shell (naked layout) and skip the auth guard.
// Shared with vite.config.mts, which preloads each route's chunks from index.html.
export const GUEST_ROUTE_PATHS = ['/login', '/delete_account', '/confirm-signup', '/forgot_password', '/resend_email', '/onboarding', '/register', '/invitation', '/email-preferences', '/scan', '/sso-callback']

export function isGuestRoutePath(path: string) {
  return GUEST_ROUTE_PATHS.includes(path) || path === '/preview' || path.startsWith('/preview/')
}
