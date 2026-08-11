import type { RegistrationSourceTrendPoint } from '~/services/adminRegistrationSources'

/** Canonical onboarding funnel payload used across admin onboarding/pulse pages. */
export interface OnboardingFunnelData {
  total_registrations: number
  total_orgs: number
  orgs_with_app: number
  orgs_with_channel: number
  orgs_with_bundle: number
  orgs_subscribed: number
  orgs_with_production_device: number
  orgs_with_update_download: number
  activation_telemetry_available: boolean
  total_invite_registrations: number
  total_org_joins_invite_register: number
  total_org_joins_existing_account: number
  org_conversion_rate: number
  app_conversion_rate: number
  channel_conversion_rate: number
  bundle_conversion_rate: number
  subscription_conversion_rate: number
  production_device_conversion_rate: number
  update_download_conversion_rate: number
  trend: Array<{
    date: string
    new_registrations: number
    new_orgs: number
    orgs_created_app: number
    orgs_created_channel: number
    orgs_created_bundle: number
    orgs_subscribed: number
    orgs_with_production_device: number
    orgs_with_update_download: number
  }>
  invite_trend: Array<{
    date: string
    invite_registrations: number
    org_joins_invite_register: number
    org_joins_existing_account: number
  }>
  registration_source_trend: RegistrationSourceTrendPoint[]
}

export interface BuilderCapacityLive {
  workers_total: number
  workers_online: number
  used: number
  free: number
  waiting: number
  offline: number
  builder_reachable: boolean
}

export interface BuilderCapacityHourPoint {
  date: string
  workers: number
  used: number
  free: number
  waiting: number
}

export interface BuilderCapacity {
  live: BuilderCapacityLive
  hourly?: BuilderCapacityHourPoint[]
  capacity_events?: number
  runs_sampled?: number
}

/** Common global_stats_trend row fields used on pulse and related pages. */
export interface GlobalStatsTrendPoint {
  date: string
  paying: number
  trial: number
  registers_today: number
  success_rate: number
  mrr: number
  paying_orgs_total?: number
}
