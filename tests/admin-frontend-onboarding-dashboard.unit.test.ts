import type { FrontendOnboardingAnalytics } from '../src/services/adminFrontendOnboarding'
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  formatFrontendOnboardingDuration,
} from '../src/services/adminFrontendOnboarding'

describe('admin frontend onboarding dashboard', () => {
  const analytics: FrontendOnboardingAnalytics = {
    onboarding_version: 1,
    kpis: {
      attempts: 10,
      completed: 4,
      completion_rate: 40,
      median_completion_ms: 222000,
      largest_dropoff: {
        from: 'details',
        to: 'organization',
        percentage: 37.5,
      },
      comparison: {
        attempts_percent: 25,
        completion_rate_points: 5,
        median_completion_ms: -12000,
        largest_dropoff_points: -7.5,
      },
    },
    daily_attempts: [
      { date: '2026-08-10', attempts: 6 },
      { date: '2026-08-09', attempts: 4 },
    ],
    funnel: [
      { key: 'intent', label: 'Intent', reached: 10, of_start_percent: 100, dropoff_percent: 0 },
      { key: 'details', label: 'App details', reached: 8, of_start_percent: 80, dropoff_percent: 20 },
      { key: 'organization', label: 'Organization', reached: 5, of_start_percent: 50, dropoff_percent: 37.5 },
      { key: 'setup', label: 'Setup reached', reached: 4, of_start_percent: 40, dropoff_percent: 20 },
    ],
    posthog_configured: true,
    posthog_connected: true,
  }

  it.concurrent('adapts daily attempts into one ordered stacked-chart series', () => {
    expect(buildFrontendOnboardingDailySeries(analytics.daily_attempts, 'Attempts')).toEqual([
      {
        label: 'Attempts',
        color: '#5667d8',
        data: [
          { date: '2026-08-10', value: 6 },
          { date: '2026-08-09', value: 4 },
        ],
      },
    ])
    expect(buildFrontendOnboardingDailySeries([], 'Attempts')).toEqual([
      { label: 'Attempts', color: '#5667d8', data: [] },
    ])
  })

  it.concurrent('adapts reordered funnel stages with stable key-based colors', () => {
    expect(buildFrontendOnboardingFunnelStages([
      analytics.funnel[3],
      analytics.funnel[0],
      analytics.funnel[2],
    ])).toEqual([
      { label: 'Setup reached', value: 4, color: '#10b981' },
      { label: 'Intent', value: 10, color: '#119eff' },
      { label: 'Organization', value: 5, color: '#8b5cf6' },
    ])
  })

  it.concurrent('formats nullable durations as rounded, nonnegative minutes and seconds', () => {
    expect(formatFrontendOnboardingDuration(222000)).toBe('3m 42s')
    expect(formatFrontendOnboardingDuration(28000)).toBe('28s')
    expect(formatFrontendOnboardingDuration(null)).toBe('—')
    expect(formatFrontendOnboardingDuration(0)).toBe('0s')
    expect(formatFrontendOnboardingDuration(550)).toBe('1s')
    expect(formatFrontendOnboardingDuration(59_500)).toBe('1m 0s')
    expect(formatFrontendOnboardingDuration(-100)).toBe('0s')
  })
})
