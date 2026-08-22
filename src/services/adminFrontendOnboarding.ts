export type FrontendOnboardingStageKey = 'intent' | 'details' | 'app_name' | 'app_id' | 'app_icon' | 'organization' | 'setup'

export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS = [
  'cli_copy_init',
  'ai_copy_init',
  'both_copy_init',
  'no_copy_init',
  'cli_copy_other_cli',
  'ai_copy_other_cli',
  'both_copy_other_cli',
  'no_copy_other_cli',
  'cli_copy_no_cli',
  'ai_copy_no_cli',
  'both_copy_no_cli',
  'no_action',
] as const

export type FrontendOnboardingDailySetupCliOutcomeKey = typeof FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS[number]
export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomePoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}

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

export interface FrontendOnboardingFunnelStage {
  key: FrontendOnboardingStageKey
  label: 'Intent' | 'App details' | 'App name' | 'App ID' | 'App icon' | 'Organization' | 'Organization details' | 'Setup reached'
  reached: number
  of_start_percent: number
  dropoff_percent: number
}

export interface FrontendOnboardingDailyConversionPoint {
  date: string
  started: number
  converted: number
  conversion_percent: number | null
}

export interface FrontendOnboardingDailyWelcomeOutcomePoint {
  date: string
  welcome_advanced_to_intent: number
  welcome_not_viewed: number
  welcome_did_not_advance: number
}

export type FrontendOnboardingTabSwitchStep = 'welcome' | 'intent' | 'app_name' | 'app_id' | 'app_icon' | 'organization'

export interface FrontendOnboardingDailyTabSwitchPoint extends Record<FrontendOnboardingTabSwitchStep, number> {
  date: string
}

export interface FrontendOnboardingKpis {
  attempts: number
  completed: number
  completion_rate: number
  median_completion_ms: number | null
  largest_dropoff: FrontendOnboardingLargestDropoff | null
  comparison: FrontendOnboardingComparison
}

export interface FrontendOnboardingDailyConversions {
  intent_to_details: FrontendOnboardingDailyConversionPoint[]
  details_to_organization: FrontendOnboardingDailyConversionPoint[]
  organization_to_setup: FrontendOnboardingDailyConversionPoint[]
}

export interface FrontendOnboardingAnalytics {
  kpis: FrontendOnboardingKpis
  v4_kpis?: FrontendOnboardingKpis
  daily_attempts: Array<{
    date: string
    v1_attempts: number
    v2_attempts: number
    v3_attempts: number
    v4_attempts?: number
  }>
  daily_welcome_outcomes?: FrontendOnboardingDailyWelcomeOutcomePoint[]
  daily_tab_switches?: FrontendOnboardingDailyTabSwitchPoint[]
  deduplicated: {
    daily_attempts: Array<{
      date: string
      v1_attempts: number
      v2_attempts: number
      v3_attempts: number
      v4_attempts?: number
    }>
    daily_welcome_outcomes?: FrontendOnboardingDailyWelcomeOutcomePoint[]
    funnels: {
      v3: FrontendOnboardingFunnelStage[]
      v4?: FrontendOnboardingFunnelStage[]
    }
  }
  daily_conversions: FrontendOnboardingDailyConversions
  v4_daily_conversions?: FrontendOnboardingDailyConversions
  funnels: {
    v1: FrontendOnboardingFunnelStage[]
    v2: FrontendOnboardingFunnelStage[]
    v3: FrontendOnboardingFunnelStage[]
    v4?: FrontendOnboardingFunnelStage[]
  }
  v2_graph: {
    nodes: Array<{
      key: string
      count: number
    }>
  }
  v3_graph: {
    nodes: Array<{
      key: string
      count: number
    }>
  }
  v4_graph?: {
    nodes: Array<{
      key: string
      count: number
    }>
  }
  v2_v3_setup_cli_outcomes: {
    total_users: number
    cli_only: number
    cli_and_ai_instructions: number
    no_cli: number
  }
  v2_v4_setup_cli_outcomes?: {
    total_users: number
    cli_only: number
    cli_and_ai_instructions: number
    no_cli: number
  }
  daily_setup_cli_outcomes: FrontendOnboardingDailySetupCliOutcomePoint[]
  posthog_configured: boolean
  posthog_connected: boolean
}

export interface FrontendOnboardingDailySeries {
  label: string
  color: string
  stack?: 'first_time' | 'returning'
  stackLabel?: string
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

export interface FrontendOnboardingFunnelSummary {
  key: FrontendOnboardingStageKey
  conversion_percent: number
  reached: number
  from_label: string | null
  to_label: string
}

export interface FrontendOnboardingLatestFunnel {
  version: 'v3' | 'v4'
  stages: FrontendOnboardingFunnelStage[]
}

export interface FrontendOnboardingGraphMetricDefinition {
  key: string
  parentKey?: string
}

export interface FrontendOnboardingGraphMetric {
  count: number
  levelPercent: number
  previousPercent?: number
}

export interface FrontendOnboardingAnalyticsLoaderCallbacks {
  onAnalytics: (analytics: FrontendOnboardingAnalytics | null) => void
  onError: (error: unknown) => void
  onLoading: (isLoading: boolean) => void
}

export function selectLatestFrontendOnboardingFunnel(
  funnels: Pick<FrontendOnboardingAnalytics['funnels'], 'v3' | 'v4'> | null | undefined,
): FrontendOnboardingLatestFunnel {
  if (funnels?.v4 !== undefined)
    return { version: 'v4', stages: funnels.v4 }
  if (funnels === null || funnels === undefined)
    return { version: 'v4', stages: [] }
  return { version: 'v3', stages: funnels.v3 }
}

const FUNNEL_STAGE_COLORS: Record<FrontendOnboardingStageKey, string> = {
  intent: '#119eff',
  details: '#6366f1',
  app_name: '#4f7cff',
  app_id: '#6366f1',
  app_icon: '#7c3aed',
  organization: '#8b5cf6',
  setup: '#10b981',
}

export function createFrontendOnboardingAnalyticsLoader(
  fetchAnalytics: () => Promise<FrontendOnboardingAnalytics | null>,
  callbacks: FrontendOnboardingAnalyticsLoaderCallbacks,
) {
  let latestRequest = 0

  return async function loadFrontendOnboardingAnalytics() {
    const request = ++latestRequest
    callbacks.onLoading(true)

    try {
      const result = await fetchAnalytics()
      if (request !== latestRequest)
        return
      callbacks.onAnalytics(result)
    }
    catch (error) {
      if (request !== latestRequest)
        return
      callbacks.onAnalytics(null)
      callbacks.onError(error)
    }
    finally {
      if (request === latestRequest)
        callbacks.onLoading(false)
    }
  }
}

export function buildFrontendOnboardingDailySeries(
  dailyAttempts: readonly FrontendOnboardingAnalytics['daily_attempts'][number][],
  v1Label: string,
  v2Label: string,
  v3Label: string,
  v4Label: string,
): FrontendOnboardingDailySeries[] {
  return [
    {
      label: v1Label,
      color: '#a78bfa',
      data: dailyAttempts.map(({ date, v1_attempts }) => ({ date, value: v1_attempts })),
    },
    {
      label: v2Label,
      color: '#06b6d4',
      data: dailyAttempts.map(({ date, v2_attempts }) => ({ date, value: v2_attempts })),
    },
    {
      label: v3Label,
      color: '#10b981',
      data: dailyAttempts.map(({ date, v3_attempts }) => ({ date, value: v3_attempts })),
    },
    {
      label: v4Label,
      color: '#f59e0b',
      data: dailyAttempts.map(({ date, v4_attempts = 0 }) => ({ date, value: v4_attempts })),
    },
  ]
}

export function buildFrontendOnboardingDailyWelcomeOutcomeSeries(
  points: readonly FrontendOnboardingDailyWelcomeOutcomePoint[],
  advancedLabel: string,
  notViewedLabel: string,
  didNotAdvanceLabel: string,
): FrontendOnboardingDailySeries[] {
  return [
    {
      label: advancedLabel,
      color: '#10b981',
      data: points.map(point => ({ date: point.date, value: point.welcome_advanced_to_intent })),
    },
    {
      label: notViewedLabel,
      color: '#f59e0b',
      data: points.map(point => ({ date: point.date, value: point.welcome_not_viewed })),
    },
    {
      label: didNotAdvanceLabel,
      color: '#f43f5e',
      data: points.map(point => ({ date: point.date, value: point.welcome_did_not_advance })),
    },
  ]
}

const TAB_SWITCH_SERIES: Array<{ key: FrontendOnboardingTabSwitchStep, color: string }> = [
  { key: 'welcome', color: '#3b82f6' },
  { key: 'intent', color: '#06b6d4' },
  { key: 'app_name', color: '#10b981' },
  { key: 'app_id', color: '#84cc16' },
  { key: 'app_icon', color: '#f59e0b' },
  { key: 'organization', color: '#8b5cf6' },
]

export function buildFrontendOnboardingDailyTabSwitchSeries(
  points: readonly FrontendOnboardingDailyTabSwitchPoint[],
  labels: Record<FrontendOnboardingTabSwitchStep, string>,
): FrontendOnboardingDailySeries[] {
  return TAB_SWITCH_SERIES.map(({ key, color }) => ({
    label: labels[key],
    color,
    data: points.map(point => ({ date: point.date, value: point[key] })),
  }))
}

const DAILY_SETUP_CLI_OUTCOME_COLORS: Record<FrontendOnboardingDailySetupCliOutcomeKey, string> = {
  cli_copy_init: '#047857',
  ai_copy_init: '#10b981',
  both_copy_init: '#34d399',
  no_copy_init: '#86efac',
  cli_copy_other_cli: '#1d4ed8',
  ai_copy_other_cli: '#3b82f6',
  both_copy_other_cli: '#7c3aed',
  no_copy_other_cli: '#a78bfa',
  cli_copy_no_cli: '#c2410c',
  ai_copy_no_cli: '#f97316',
  both_copy_no_cli: '#fbbf24',
  no_action: '#94a3b8',
}

export function buildFrontendOnboardingDailySetupCliSeries(
  points: readonly FrontendOnboardingDailySetupCliOutcomePoint[],
  labels: Record<FrontendOnboardingDailySetupCliOutcomeKey, string>,
  firstTimeLabel: string,
  returningLabel: string,
): FrontendOnboardingDailySeries[] {
  const activeKeys = FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.filter(key => points.some(
    point => point.first_time[key] + point.returning[key] > 0,
  ))

  return activeKeys.flatMap(key => ([
    {
      label: labels[key],
      color: DAILY_SETUP_CLI_OUTCOME_COLORS[key],
      stack: 'first_time' as const,
      stackLabel: firstTimeLabel,
      data: points.map(point => ({ date: point.date, value: point.first_time[key] })),
    },
    {
      label: labels[key],
      color: DAILY_SETUP_CLI_OUTCOME_COLORS[key],
      stack: 'returning' as const,
      stackLabel: returningLabel,
      data: points.map(point => ({ date: point.date, value: point.returning[key] })),
    },
  ]))
}

export function buildFrontendOnboardingFunnelStages(
  funnel: readonly FrontendOnboardingFunnelStage[],
): FrontendOnboardingFunnelDisplayStage[] {
  return funnel.map(stage => ({
    label: stage.label,
    value: stage.reached,
    color: FUNNEL_STAGE_COLORS[stage.key],
  }))
}

export function buildFrontendOnboardingFunnelSummaries(
  funnel: readonly FrontendOnboardingFunnelStage[],
): FrontendOnboardingFunnelSummary[] {
  const hasAttempts = (funnel[0]?.reached ?? 0) > 0
  return funnel.map((stage, index) => {
    const previousStage = funnel[index - 1]
    const conversionPercent = hasAttempts && (index === 0 || (previousStage?.reached ?? 0) > 0)
      ? (index === 0 ? 100 : 100 - stage.dropoff_percent)
      : 0

    return {
      key: stage.key,
      conversion_percent: conversionPercent,
      reached: stage.reached,
      from_label: index === 0 ? null : previousStage?.label ?? null,
      to_label: stage.label,
    }
  })
}

export function buildFrontendOnboardingGraphMetrics(
  definitions: readonly FrontendOnboardingGraphMetricDefinition[],
  nodes: readonly { key: string, count: number }[],
  appDetailsCount: number | undefined,
): Record<string, FrontendOnboardingGraphMetric> {
  const counts = new Map(nodes.map(node => [node.key, node.count]))

  return Object.fromEntries(definitions.map(({ key, parentKey }) => {
    const count = counts.get(key) ?? 0
    const levelPercent = appDetailsCount ? count / appDetailsCount * 100 : 0
    const metric: FrontendOnboardingGraphMetric = { count, levelPercent }

    if (parentKey) {
      const parentCount = counts.get(parentKey) ?? 0
      metric.previousPercent = parentCount ? count / parentCount * 100 : 0
    }

    return [key, metric]
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
