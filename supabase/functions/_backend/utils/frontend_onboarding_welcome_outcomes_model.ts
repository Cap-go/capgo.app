import { FRONTEND_ONBOARDING_FOLLOWUP_MS } from './frontend_onboarding_analytics_model.ts'

export const FRONTEND_ONBOARDING_WELCOME_FOLLOWUP_MS = FRONTEND_ONBOARDING_FOLLOWUP_MS

export interface FrontendOnboardingWelcomeAttempt {
  attemptId: string
  personId: string
  welcomeMs: number | null
  intentMs: number | null
}

export interface FrontendOnboardingDailyWelcomeOutcome {
  date: string
  welcome_advanced_to_intent: number
  welcome_not_viewed: number
  welcome_did_not_advance: number
}

export interface FrontendOnboardingWelcomeOutcomes {
  daily: FrontendOnboardingDailyWelcomeOutcome[]
  deduplicated: FrontendOnboardingDailyWelcomeOutcome[]
}

type WelcomeOutcomeKey = Exclude<keyof FrontendOnboardingDailyWelcomeOutcome, 'date'>

interface ClassifiedWelcomeAttempt extends FrontendOnboardingWelcomeAttempt {
  anchorMs: number
  outcome: WelcomeOutcomeKey
}

const DAY_MS = 24 * 60 * 60 * 1000

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function eachUtcDate(startMs: number, endMs: number): string[] {
  const dates: string[] = []
  const start = new Date(startMs)
  const firstDayMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  for (let dayMs = firstDayMs; dayMs < endMs; dayMs += DAY_MS)
    dates.push(utcDate(dayMs))
  return dates
}

function classifyAttempt(attempt: FrontendOnboardingWelcomeAttempt): ClassifiedWelcomeAttempt | null {
  if (attempt.welcomeMs === null) {
    return attempt.intentMs === null
      ? null
      : { ...attempt, anchorMs: attempt.intentMs, outcome: 'welcome_not_viewed' }
  }

  const advanced = attempt.intentMs !== null
    && attempt.intentMs >= attempt.welcomeMs
    && attempt.intentMs <= attempt.welcomeMs + FRONTEND_ONBOARDING_WELCOME_FOLLOWUP_MS

  return {
    ...attempt,
    anchorMs: attempt.welcomeMs,
    outcome: advanced ? 'welcome_advanced_to_intent' : 'welcome_did_not_advance',
  }
}

function outcomeRank(outcome: WelcomeOutcomeKey): number {
  if (outcome === 'welcome_advanced_to_intent')
    return 2
  if (outcome === 'welcome_not_viewed')
    return 1
  return 0
}

function selectDeduplicatedAttempts(attempts: ClassifiedWelcomeAttempt[]): ClassifiedWelcomeAttempt[] {
  const winners = new Map<string, ClassifiedWelcomeAttempt>()

  for (const attempt of attempts) {
    const personId = attempt.personId.trim()
    const identityKey = personId === '' ? `attempt:${attempt.attemptId}` : `person:${personId}`
    const current = winners.get(identityKey)
    if (current === undefined
      || outcomeRank(attempt.outcome) > outcomeRank(current.outcome)
      || (outcomeRank(attempt.outcome) === outcomeRank(current.outcome) && attempt.anchorMs > current.anchorMs)
      || (outcomeRank(attempt.outcome) === outcomeRank(current.outcome)
        && attempt.anchorMs === current.anchorMs
        && attempt.attemptId > current.attemptId)) {
      winners.set(identityKey, attempt)
    }
  }

  return [...winners.values()]
}

function buildDailyOutcomes(
  attempts: ClassifiedWelcomeAttempt[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailyWelcomeOutcome[] {
  const points = new Map(eachUtcDate(startMs, endMs).map(date => [date, {
    date,
    welcome_advanced_to_intent: 0,
    welcome_not_viewed: 0,
    welcome_did_not_advance: 0,
  }]))

  for (const attempt of attempts) {
    const point = points.get(utcDate(attempt.anchorMs))
    if (point)
      point[attempt.outcome] += 1
  }

  return [...points.values()]
}

export function buildFrontendOnboardingWelcomeOutcomes(
  attempts: FrontendOnboardingWelcomeAttempt[],
  startMs: number,
  endMs: number,
): FrontendOnboardingWelcomeOutcomes {
  const classified = attempts.flatMap((attempt) => {
    const result = classifyAttempt(attempt)
    return result !== null && result.anchorMs >= startMs && result.anchorMs < endMs ? [result] : []
  })

  return {
    daily: buildDailyOutcomes(classified, startMs, endMs),
    deduplicated: buildDailyOutcomes(selectDeduplicatedAttempts(classified), startMs, endMs),
  }
}
