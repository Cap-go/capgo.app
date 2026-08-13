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

export interface FrontendOnboardingFunnelStage {
  key: FrontendOnboardingStageKey
  label: 'Intent' | 'App details' | 'Organization' | 'Setup reached'
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

export interface FrontendOnboardingAnalytics {
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
    v1_attempts: number
    v2_attempts: number
  }>
  daily_conversions: {
    intent_to_details: FrontendOnboardingDailyConversionPoint[]
    details_to_organization: FrontendOnboardingDailyConversionPoint[]
    organization_to_setup: FrontendOnboardingDailyConversionPoint[]
  }
  funnels: {
    v1: FrontendOnboardingFunnelStage[]
    v2: FrontendOnboardingFunnelStage[]
  }
  v2_graph: {
    nodes: Array<{
      key: string
      count: number
    }>
  }
  posthog_configured: boolean
  posthog_connected: boolean
}

export interface FrontendOnboardingDailySeries {
  label: string
  color: string
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

const FUNNEL_STAGE_COLORS: Record<FrontendOnboardingStageKey, string> = {
  intent: '#119eff',
  details: '#6366f1',
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
  ]
}

export function buildFrontendOnboardingDailyConversionPoints(
  points: readonly FrontendOnboardingDailyConversionPoint[],
): FrontendOnboardingDailyConversionPoint[] {
  return points.map(point => ({ ...point }))
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
  nodes: readonly FrontendOnboardingAnalytics['v2_graph']['nodes'][number][],
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
