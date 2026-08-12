/**
 * Human-readable role capability copy for UI pickers.
 * Keys resolve through vue-i18n (`role-cap-<role>-summary|can|cannot`).
 * `can` / `cannot` values are pipe-separated bullet lists.
 */

export interface RoleCapabilityKeys {
  summaryKey: string
  canKey: string
  cannotKey: string
}

const KNOWN_ROLES = new Set([
  'org_member',
  'org_billing_admin',
  'org_admin',
  'org_super_admin',
  'apikey_manager',
  'app_admin',
  'app_developer',
  'app_uploader',
  'app_reader',
  'app_preview',
  'app_notifications',
  'channel_admin',
  'channel_developer',
  'channel_uploader',
  'channel_reader',
  'channel_preview',
])

export function getRoleCapabilityKeys(roleName: string | null | undefined): RoleCapabilityKeys | null {
  if (!roleName || !KNOWN_ROLES.has(roleName))
    return null

  const prefix = `role-cap-${roleName}`
  return {
    summaryKey: `${prefix}-summary`,
    canKey: `${prefix}-can`,
    cannotKey: `${prefix}-cannot`,
  }
}

export function splitCapabilityList(value: string | null | undefined): string[] {
  if (!value)
    return []

  return value
    .split('|')
    .map(item => item.trim())
    .filter(Boolean)
}
