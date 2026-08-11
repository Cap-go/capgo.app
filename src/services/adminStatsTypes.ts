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
