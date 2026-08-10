export type AdminHubKey = 'onboarding' | 'product' | 'retention' | 'customers' | 'revenue' | 'platform'

/** Primary route suffix (under /admin/dashboard) highlighted for each hub. */
export const adminHubPrimaryKey: Record<AdminHubKey, string> = {
  onboarding: '/onboarding',
  product: '/product/updates',
  retention: '/retention',
  customers: '/customers/organizations',
  revenue: '/revenue',
  platform: '/platform/replication',
}

export const adminHubPathPrefix: Record<AdminHubKey, string> = {
  onboarding: '/onboarding',
  product: '/product',
  retention: '/retention',
  customers: '/customers',
  revenue: '/revenue',
  platform: '/platform',
}
