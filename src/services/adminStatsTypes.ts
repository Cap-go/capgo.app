import type { AdminOnboardingFunnel } from '../../supabase/functions/_backend/utils/pg.ts'

/** Frontend alias for the backend onboarding funnel payload. */
export type OnboardingFunnelData = AdminOnboardingFunnel

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

export interface GlobalStatsTrendPoint {
  date: string
  apps?: number
  apps_active?: number
  users?: number
  users_active?: number
  paying?: number
  org_conversion_rate?: number
  plan_total_conversion_rate?: number
  plan_solo_conversion_rate?: number
  plan_maker_conversion_rate?: number
  plan_team_conversion_rate?: number
  plan_enterprise_conversion_rate?: number
  trial?: number
  not_paying?: number
  updates?: number
  updates_external?: number
  success_rate?: number
  bundle_storage_gb?: number
  plan_solo?: number
  plan_maker?: number
  plan_team?: number
  plan_enterprise?: number
  registers_today?: number
  devices_last_month?: number
  devices_last_month_ios?: number
  devices_last_month_android?: number
  stars?: number
  need_upgrade?: number
  above_plan_with_credits?: number | null
  above_plan_without_credits?: number | null
  paying_yearly?: number
  paying_monthly?: number
  new_paying_orgs?: number
  canceled_orgs?: number
  upgraded_orgs?: number
  upgrade_rate_12m?: number
  past_due_orgs?: number
  past_due_orgs_average_days?: number
  active_canceled_orgs?: number
  active_past_due_orgs?: number
  mrr?: number
  previous_mrr?: number
  previous_mrr_solo?: number
  previous_mrr_maker?: number
  previous_mrr_team?: number
  previous_mrr_enterprise?: number
  nrr?: number
  churn_revenue?: number
  churn_revenue_solo?: number
  churn_revenue_maker?: number
  churn_revenue_team?: number
  churn_revenue_enterprise?: number
  total_revenue?: number
  revenue_solo?: number
  revenue_maker?: number
  revenue_team?: number
  revenue_enterprise?: number
  average_ltv?: number
  shortest_ltv?: number
  longest_ltv?: number
  paying_orgs_subscription?: number
  paying_orgs_credits?: number
  paying_orgs_total?: number
  credits_bought?: number
  credits_consumed?: number
  trial_extended_orgs?: number
  trial_extended_subscribed_orgs?: number
  demo_apps_created?: number
}

