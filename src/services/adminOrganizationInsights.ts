export type BillingType = 'monthly' | 'yearly' | 'usage'

export interface OrganizationInsight {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  billing_type: BillingType | null
  upload_count: number
  build_count: number
  failed_update_count: number
  install_count: number
  update_attempt_count: number
  needs_attention: boolean
  fail_rate: number
  mau: number
  members_count: number
  apps_count: number
  last_upload_at: string | null
  last_build_at: string | null
  paid_at: string | null
  registered_at: string
}

export interface OrganizationInsightsResponse {
  success: boolean
  data: {
    organizations: OrganizationInsight[]
    total: number
    plan_options: string[]
  }
}
