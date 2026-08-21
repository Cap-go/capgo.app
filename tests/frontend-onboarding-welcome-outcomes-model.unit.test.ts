import { describe, expect, it } from 'vitest'

import {
  buildFrontendOnboardingWelcomeOutcomes,
  FRONTEND_ONBOARDING_WELCOME_FOLLOWUP_MS,
} from '../supabase/functions/_backend/utils/frontend_onboarding_welcome_outcomes_model.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const START_MS = Date.UTC(2026, 7, 1)
const END_MS = START_MS + 3 * DAY_MS

interface AttemptOverrides {
  attemptId: string
  personId?: string
  welcomeMs?: number | null
  intentMs?: number | null
}

function attempt(overrides: AttemptOverrides) {
  return {
    personId: overrides.personId ?? overrides.attemptId,
    welcomeMs: overrides.welcomeMs ?? null,
    intentMs: overrides.intentMs ?? null,
    ...overrides,
  }
}

describe('buildFrontendOnboardingWelcomeOutcomes', () => {
  it.concurrent('classifies the three outcomes and zero-fills UTC days', () => {
    const result = buildFrontendOnboardingWelcomeOutcomes([
      attempt({
        attemptId: 'advanced-at-boundary',
        welcomeMs: START_MS + HOUR_MS,
        intentMs: START_MS + HOUR_MS + FRONTEND_ONBOARDING_WELCOME_FOLLOWUP_MS,
      }),
      attempt({
        attemptId: 'no-welcome',
        intentMs: START_MS + 2 * HOUR_MS,
      }),
      attempt({
        attemptId: 'welcome-only',
        welcomeMs: START_MS + 3 * HOUR_MS,
      }),
      attempt({
        attemptId: 'intent-before-welcome',
        welcomeMs: START_MS + DAY_MS + 2 * HOUR_MS,
        intentMs: START_MS + DAY_MS + HOUR_MS,
      }),
    ], START_MS, END_MS)

    expect(result.daily).toEqual([
      {
        date: '2026-08-01',
        welcome_advanced_to_intent: 1,
        welcome_not_viewed: 1,
        welcome_did_not_advance: 1,
      },
      {
        date: '2026-08-02',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 1,
      },
      {
        date: '2026-08-03',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 0,
      },
    ])
  })

  it.concurrent('uses the approved best-attempt ranking across the whole range', () => {
    const result = buildFrontendOnboardingWelcomeOutcomes([
      attempt({ attemptId: 'user-1-day-1', personId: 'user-1', welcomeMs: START_MS + HOUR_MS }),
      attempt({ attemptId: 'user-1-day-2', personId: 'user-1', welcomeMs: START_MS + DAY_MS + HOUR_MS, intentMs: START_MS + DAY_MS + 2 * HOUR_MS }),
      attempt({ attemptId: 'user-2-day-1', personId: 'user-2', intentMs: START_MS + 3 * HOUR_MS }),
      attempt({ attemptId: 'user-2-day-2', personId: 'user-2', welcomeMs: START_MS + DAY_MS + 3 * HOUR_MS }),
      attempt({ attemptId: 'user-3-day-1', personId: 'user-3', welcomeMs: START_MS + 4 * HOUR_MS, intentMs: START_MS + 5 * HOUR_MS }),
      attempt({ attemptId: 'user-3-day-2', personId: 'user-3', welcomeMs: START_MS + DAY_MS + 4 * HOUR_MS }),
      attempt({ attemptId: 'user-4-day-1', personId: 'user-4', intentMs: START_MS + 6 * HOUR_MS }),
      attempt({ attemptId: 'user-4-day-2', personId: 'user-4', welcomeMs: START_MS + DAY_MS + 6 * HOUR_MS, intentMs: START_MS + DAY_MS + 7 * HOUR_MS }),
    ], START_MS, END_MS)

    expect(result.deduplicated).toEqual([
      {
        date: '2026-08-01',
        welcome_advanced_to_intent: 1,
        welcome_not_viewed: 1,
        welcome_did_not_advance: 0,
      },
      {
        date: '2026-08-02',
        welcome_advanced_to_intent: 2,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 0,
      },
      {
        date: '2026-08-03',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 0,
      },
    ])
  })

  it.concurrent('uses the latest anchor for equal outcomes and keeps missing identities separate', () => {
    const result = buildFrontendOnboardingWelcomeOutcomes([
      attempt({ attemptId: 'older', personId: 'same-user', welcomeMs: START_MS + HOUR_MS }),
      attempt({ attemptId: 'newer', personId: 'same-user', welcomeMs: START_MS + DAY_MS + HOUR_MS }),
      attempt({ attemptId: 'blank-one', personId: '', welcomeMs: START_MS + 2 * HOUR_MS }),
      attempt({ attemptId: 'blank-two', personId: '', welcomeMs: START_MS + 3 * HOUR_MS }),
    ], START_MS, END_MS)

    expect(result.deduplicated).toEqual([
      {
        date: '2026-08-01',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 2,
      },
      {
        date: '2026-08-02',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 1,
      },
      {
        date: '2026-08-03',
        welcome_advanced_to_intent: 0,
        welcome_not_viewed: 0,
        welcome_did_not_advance: 0,
      },
    ])
  })

  it.concurrent('ignores attempts whose anchors are outside the selected range', () => {
    const result = buildFrontendOnboardingWelcomeOutcomes([
      attempt({ attemptId: 'before', welcomeMs: START_MS - HOUR_MS, intentMs: START_MS + HOUR_MS }),
      attempt({ attemptId: 'after', intentMs: END_MS }),
      attempt({ attemptId: 'empty' }),
    ], START_MS, END_MS)

    expect(result.daily.every(point => (
      point.welcome_advanced_to_intent === 0
      && point.welcome_not_viewed === 0
      && point.welcome_did_not_advance === 0
    ))).toBe(true)
    expect(result.deduplicated).toEqual(result.daily)
  })
})
