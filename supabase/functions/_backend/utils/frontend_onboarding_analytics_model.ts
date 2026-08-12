export const FRONTEND_ONBOARDING_VERSION = 2 as const
export const FRONTEND_ONBOARDING_FOLLOWUP_MS = 24 * 60 * 60 * 1000

export type FrontendOnboardingStageKey = 'intent' | 'details' | 'organization' | 'setup'

export interface FrontendOnboardingAttempt {
  attemptId: string
  intentMs: number
  detailsMs: number | null
  organizationMs: number | null
  setupMs: number | null
}

export interface FrontendOnboardingFunnelStage {
  key: FrontendOnboardingStageKey
  label: 'Intent' | 'App details' | 'Organization' | 'Setup reached'
  reached: number
  of_start_percent: number
  dropoff_percent: number
}

export interface FrontendOnboardingLargestDropoff {
  from: Exclude<FrontendOnboardingStageKey, 'setup'>
  to: Exclude<FrontendOnboardingStageKey, 'intent'>
  percentage: number
}

export interface FrontendOnboardingPeriodKpis {
  attempts: number
  completed: number
  completion_rate: number
  median_completion_ms: number | null
  largest_dropoff: FrontendOnboardingLargestDropoff | null
}

export interface FrontendOnboardingComparison {
  attempts_percent: number | null
  completion_rate_points: number | null
  median_completion_ms: number | null
  largest_dropoff_points: number | null
}

export interface FrontendOnboardingDailyAttempt {
  date: string
  attempts: number
}

export interface FrontendOnboardingAnalytics {
  kpis: FrontendOnboardingPeriodKpis & { comparison: FrontendOnboardingComparison }
  daily_attempts: FrontendOnboardingDailyAttempt[]
  funnel: FrontendOnboardingFunnelStage[]
}

const DAY_MS = 24 * 60 * 60 * 1000

const FUNNEL_STAGES: Array<Pick<FrontendOnboardingFunnelStage, 'key' | 'label'>> = [
  { key: 'intent', label: 'Intent' },
  { key: 'details', label: 'App details' },
  { key: 'organization', label: 'Organization' },
  { key: 'setup', label: 'Setup reached' },
]

interface PeriodSummary {
  kpis: FrontendOnboardingPeriodKpis
  funnel: FrontendOnboardingFunnelStage[]
}

function isStepInFollowupWindow(timestamp: number | null, intentMs: number): timestamp is number {
  return timestamp !== null
    && timestamp >= intentMs
    && timestamp <= intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS
}

function median(values: number[]): number | null {
  if (values.length === 0)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function buildFunnel(attempts: FrontendOnboardingAttempt[]): FrontendOnboardingFunnelStage[] {
  const reached = [
    attempts.length,
    attempts.filter(attempt => (
      isStepInFollowupWindow(attempt.detailsMs, attempt.intentMs)
      || isStepInFollowupWindow(attempt.organizationMs, attempt.intentMs)
      || isStepInFollowupWindow(attempt.setupMs, attempt.intentMs)
    )).length,
    attempts.filter(attempt => (
      isStepInFollowupWindow(attempt.organizationMs, attempt.intentMs)
      || isStepInFollowupWindow(attempt.setupMs, attempt.intentMs)
    )).length,
    attempts.filter(attempt => isStepInFollowupWindow(attempt.setupMs, attempt.intentMs)).length,
  ]

  return FUNNEL_STAGES.map((stage, index) => {
    const previousReached = index === 0 ? 0 : reached[index - 1]
    return {
      ...stage,
      reached: reached[index],
      of_start_percent: reached[0] === 0 ? 0 : reached[index] / reached[0] * 100,
      dropoff_percent: previousReached === 0 ? 0 : (previousReached - reached[index]) / previousReached * 100,
    }
  })
}

function findLargestDropoff(funnel: FrontendOnboardingFunnelStage[]): FrontendOnboardingLargestDropoff | null {
  let largestDropoff: FrontendOnboardingLargestDropoff | null = null

  for (let index = 1; index < funnel.length; index++) {
    const previousStage = funnel[index - 1]
    const currentStage = funnel[index]
    if (previousStage.reached === 0 || previousStage.key === 'setup' || currentStage.key === 'intent')
      continue

    if (currentStage.dropoff_percent > 0
      && (largestDropoff === null || currentStage.dropoff_percent > largestDropoff.percentage)) {
      largestDropoff = {
        from: previousStage.key,
        to: currentStage.key,
        percentage: currentStage.dropoff_percent,
      }
    }
  }

  return largestDropoff
}

function summarizePeriod(attempts: FrontendOnboardingAttempt[]): PeriodSummary {
  const funnel = buildFunnel(attempts)
  const completionDurations: number[] = []
  for (const attempt of attempts) {
    const setupMs = attempt.setupMs
    if (isStepInFollowupWindow(setupMs, attempt.intentMs))
      completionDurations.push(setupMs - attempt.intentMs)
  }

  return {
    funnel,
    kpis: {
      attempts: attempts.length,
      completed: funnel[3].reached,
      completion_rate: attempts.length === 0 ? 0 : funnel[3].reached / attempts.length * 100,
      median_completion_ms: median(completionDurations),
      largest_dropoff: findLargestDropoff(funnel),
    },
  }
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function buildDailyAttempts(attempts: FrontendOnboardingAttempt[], startMs: number, endMs: number): FrontendOnboardingDailyAttempt[] {
  const attemptsByDate = new Map<string, number>()
  for (const attempt of attempts)
    attemptsByDate.set(utcDate(attempt.intentMs), (attemptsByDate.get(utcDate(attempt.intentMs)) ?? 0) + 1)

  const days: FrontendOnboardingDailyAttempt[] = []
  for (let dayStartMs = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  ); dayStartMs < endMs; dayStartMs += DAY_MS) {
    const date = utcDate(dayStartMs)
    days.push({ date, attempts: attemptsByDate.get(date) ?? 0 })
  }

  return days
}

function comparePeriods(current: FrontendOnboardingPeriodKpis, previous: FrontendOnboardingPeriodKpis): FrontendOnboardingComparison {
  const hasPreviousAttempts = previous.attempts > 0
  return {
    attempts_percent: hasPreviousAttempts ? (current.attempts - previous.attempts) / previous.attempts * 100 : null,
    completion_rate_points: hasPreviousAttempts ? current.completion_rate - previous.completion_rate : null,
    median_completion_ms: current.median_completion_ms === null || previous.median_completion_ms === null
      ? null
      : current.median_completion_ms - previous.median_completion_ms,
    largest_dropoff_points: hasPreviousAttempts
      ? (current.largest_dropoff?.percentage ?? 0) - (previous.largest_dropoff?.percentage ?? 0)
      : null,
  }
}

export function buildFrontendOnboardingAnalytics(
  attempts: FrontendOnboardingAttempt[],
  currentStartMs: number,
  currentEndMs: number,
): FrontendOnboardingAnalytics {
  if (!Number.isFinite(currentStartMs) || !Number.isFinite(currentEndMs) || currentEndMs <= currentStartMs)
    throw new RangeError('currentStartMs and currentEndMs must be finite, with currentEndMs greater than currentStartMs')

  const periodDurationMs = currentEndMs - currentStartMs
  const previousStartMs = currentStartMs - periodDurationMs
  const currentAttempts = attempts.filter(attempt => attempt.intentMs >= currentStartMs && attempt.intentMs < currentEndMs)
  const previousAttempts = attempts.filter(attempt => attempt.intentMs >= previousStartMs && attempt.intentMs < currentStartMs)
  const current = summarizePeriod(currentAttempts)
  const previous = summarizePeriod(previousAttempts)

  return {
    kpis: {
      ...current.kpis,
      comparison: comparePeriods(current.kpis, previous.kpis),
    },
    daily_attempts: buildDailyAttempts(currentAttempts, currentStartMs, currentEndMs),
    funnel: current.funnel,
  }
}
