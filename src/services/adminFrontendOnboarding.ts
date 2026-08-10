export type FrontendOnboardingStageKey = 'intent' | 'details' | 'organization' | 'setup'

export interface FrontendOnboardingLargestDropoff {
  from: Exclude<FrontendOnboardingStageKey, 'setup'>
  to: Exclude<FrontendOnboardingStageKey, 'intent'>
  percentage: number
}

export interface FrontendOnboardingComparison {
  attempts_percent: number | null
  completion_rate_points: number | null
  median_completion_ms: number | null
  largest_dropoff_points: number | null
}

export interface FrontendOnboardingAnalytics {
  onboarding_version: 1
  kpis: {
    attempts: number
    completed: number
    completion_rate: number
    median_completion_ms: number | null
    largest_dropoff: FrontendOnboardingLargestDropoff | null
    comparison: FrontendOnboardingComparison
  }
  daily_attempts: Array<{
    date: string
    attempts: number
  }>
  funnel: Array<{
    key: FrontendOnboardingStageKey
    label: string
    reached: number
    of_start_percent: number
    dropoff_percent: number
  }>
  posthog_configured: boolean
  posthog_connected: boolean
}

export interface FrontendOnboardingDailySeries {
  label: string
  color: '#5667d8'
  data: Array<{
    date: string
    value: number
  }>
}

export interface FrontendOnboardingFunnelDisplayStage {
  label: string
  value: number
  color: string
}

const FUNNEL_STAGE_COLORS: Record<FrontendOnboardingStageKey, string> = {
  intent: '#119eff',
  details: '#6366f1',
  organization: '#8b5cf6',
  setup: '#10b981',
}

export function buildFrontendOnboardingDailySeries(
  dailyAttempts: readonly FrontendOnboardingAnalytics['daily_attempts'][number][],
  label: string,
): FrontendOnboardingDailySeries[] {
  return [{
    label,
    color: '#5667d8',
    data: dailyAttempts.map(({ date, attempts }) => ({ date, value: attempts })),
  }]
}

export function buildFrontendOnboardingFunnelStages(
  funnel: readonly FrontendOnboardingAnalytics['funnel'][number][],
): FrontendOnboardingFunnelDisplayStage[] {
  return funnel.map(stage => ({
    label: stage.label,
    value: stage.reached,
    color: FUNNEL_STAGE_COLORS[stage.key],
  }))
}

export function formatFrontendOnboardingDuration(value: number | null): string {
  if (value === null)
    return '—'

  const seconds = Math.round(Math.max(0, value) / 1000)
  if (seconds < 60)
    return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
