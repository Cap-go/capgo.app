import { adminTabs } from '~/constants/adminTabs'

export type AdminHubKey = 'onboarding' | 'product' | 'retention' | 'customers' | 'revenue' | 'platform'

export const adminHubPathPrefix: Record<AdminHubKey, string> = {
  onboarding: '/onboarding',
  product: '/product',
  retention: '/retention',
  customers: '/customers',
  revenue: '/revenue',
  platform: '/platform',
}

/** Resolve the primary admin tab key for a hub from `adminTabs` (single source of truth). */
export function getAdminHubPrimaryKey(hub: AdminHubKey): string {
  const prefix = adminHubPathPrefix[hub]
  const tab = adminTabs.find((entry) => {
    const key = entry.key.replace(/\/$/, '')
    return key === prefix || key.startsWith(`${prefix}/`)
  })
  return tab?.key ?? prefix
}
