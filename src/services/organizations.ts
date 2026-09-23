import type { Database } from '~/types/supabase.types'
import { invokeCapgoApi } from '~/services/capgoApi'

export type OrganizationListRow = Database['public']['Functions']['get_orgs_v7']['Returns'][number]

export interface OrgSecuritySettings {
  enforcing_2fa: boolean
  enforce_hashed_api_keys: boolean
  enforce_encrypted_bundles: boolean
  required_encryption_key: string | null
}

export interface OrgSupportChannel {
  support_channel_type: 'slack' | 'discord' | 'teams' | null
  support_channel_url: string | null
}

export interface OrgChartRefreshState {
  stats_updated_at: string | null
  stats_refresh_requested_at: string | null
}

export interface OrgBillingPaidAt {
  paid_at: string | null
}

export interface OrgNameRow {
  id: string
  name: string
}

export interface PasswordPolicyConfig {
  enabled: boolean
  min_length: number
  require_uppercase: boolean
  require_number: boolean
  require_special: boolean
}

export interface OrgEmailPreferences {
  usage_limit?: boolean
  credit_usage?: boolean
  onboarding?: boolean
  builder_onboarding?: boolean
  weekly_stats?: boolean
  monthly_stats?: boolean
  billing_period_stats?: boolean
  deploy_stats_24h?: boolean
  bundle_created?: boolean
  bundle_deployed?: boolean
  device_error?: boolean
  channel_self_rejected?: boolean
}

export interface UpdateOrganizationPatch {
  name?: string
  logo?: string
  password_policy_config?: PasswordPolicyConfig | null
  email_preferences?: OrgEmailPreferences
}

export async function fetchOrganizationsList() {
  return await invokeCapgoApi<OrganizationListRow[]>('private/orgs', {
    method: 'GET',
  })
}

export async function fetchOrgSecuritySettings(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<OrgSecuritySettings>(`private/orgs/security-settings?org_id=${encodedOrgId}`, {
    method: 'GET',
  })
}

export async function fetchOrgSupportChannel(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<OrgSupportChannel>(`private/orgs/support-channel?org_id=${encodedOrgId}`, {
    method: 'GET',
  })
}

export async function fetchOrgChartRefreshState(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<OrgChartRefreshState>(`private/orgs/chart-refresh-state?org_id=${encodedOrgId}`, {
    method: 'GET',
  })
}

export async function fetchOrgBillingPaidAt(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<OrgBillingPaidAt>(`private/orgs/billing-paid-at?org_id=${encodedOrgId}`, {
    method: 'GET',
  })
}

export async function fetchOrgNamesByIds(orgIds: string[]) {
  if (orgIds.length === 0)
    return { data: [] as OrgNameRow[], error: null }

  const encodedIds = encodeURIComponent(orgIds.join(','))
  return await invokeCapgoApi<OrgNameRow[]>(`private/orgs/names?ids=${encodedIds}`, {
    method: 'GET',
  })
}

export async function updateOrganization(orgId: string, patch: Omit<UpdateOrganizationPatch, 'org_id'>) {
  return await invokeCapgoApi<{ status: 'ok' }>('private/orgs', {
    method: 'PATCH',
    body: {
      org_id: orgId,
      ...patch,
    },
  })
}

export async function deleteOrganization(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<{ status: 'ok' }>(`private/orgs?org_id=${encodedOrgId}`, {
    method: 'DELETE',
  })
}
