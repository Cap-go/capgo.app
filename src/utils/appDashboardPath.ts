const RESERVED_APP_SEGMENTS = new Set(['new', 'modules', 'modules_test'])
const DASHBOARD_SUBTABS = new Set(['native', 'installs', 'active-bundle'])

export function isAppDashboardPath(path: string) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  if (parts[0] !== 'app' || parts.length < 2 || parts.length > 3)
    return false
  if (RESERVED_APP_SEGMENTS.has(parts[1]))
    return false
  if (parts.length === 2)
    return true
  return DASHBOARD_SUBTABS.has(parts[2])
}
