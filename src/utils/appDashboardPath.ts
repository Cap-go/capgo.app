export const APP_DASHBOARD_SUBTABS = ['native', 'installs', 'active-bundle'] as const

export type AppDashboardSubtab = typeof APP_DASHBOARD_SUBTABS[number]
export type AppDashboardSection = 'usage' | AppDashboardSubtab

const RESERVED_APP_SEGMENTS = new Set(['new', 'modules', 'modules_test'])

export function isAppDashboardPath(path: string) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  if (parts[0] !== 'app' || parts.length < 2 || parts.length > 3)
    return false
  if (RESERVED_APP_SEGMENTS.has(parts[1]))
    return false
  if (parts.length === 2)
    return true
  return (APP_DASHBOARD_SUBTABS as readonly string[]).includes(parts[2])
}
