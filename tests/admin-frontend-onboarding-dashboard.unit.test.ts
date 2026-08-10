import type { FrontendOnboardingAnalytics } from '../src/services/adminFrontendOnboarding'
import { readFile } from 'node:fs/promises'
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

  it('wires the page to the frontend onboarding analytics metric', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

    expect(source).toContain(`fetchStats('frontend_onboarding_analytics')`)
  })

  it('uses the existing admin dashboard components and fixed onboarding version', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

    expect(source).toContain('<AdminFilterBar')
    expect(source.match(/<AdminStatsCard\b/g)).toHaveLength(4)
    expect(source).toContain('<AdminStackedBarChart')
    expect(source).toContain('<AdminFunnelChart')
    expect(source).toContain(`t('frontend-onboarding-version-1')`)
  })

  it('omits PostHog warnings, existing-org analytics, and selector UI', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

    expect(source).not.toContain('posthogWarning')
    expect(source).not.toContain('posthog_configured')
    expect(source).not.toContain('posthog_connected')
    expect(source).not.toContain('existing_org')
    expect(source).not.toContain('<select')
    expect(source).not.toContain('version-selector')
    expect(source).not.toContain('intent-selector')
  })

  it('registers the frontend onboarding admin tab', async () => {
    const source = await readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8')

    expect(source).toContain(`{ label: 'frontend-onboarding', icon:`)
    expect(source).toContain(`key: '/frontend-onboarding'`)
  })

  it('defines every frontend onboarding page label in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['frontend-onboarding']).toBe('Frontend onboarding')
    expect(messages['frontend-onboarding-version-1']).toBe('Onboarding v1')
    expect(messages['frontend-onboarding-attempts']).toBe('Onboarding attempts')
    expect(messages['frontend-onboarding-attempts-subtitle']).toBe('Unique frontend attempts')
    expect(messages['frontend-onboarding-completed']).toBe('Frontend onboarding completed')
    expect(messages['frontend-onboarding-completed-subtitle']).toBe('{count} attempts reached setup')
    expect(messages['frontend-onboarding-median-time']).toBe('Median completion time')
    expect(messages['frontend-onboarding-median-time-subtitle']).toBe('Completed attempts only')
    expect(messages['frontend-onboarding-largest-dropoff']).toBe('Largest drop-off')
    expect(messages['frontend-onboarding-daily-attempts']).toBe('Daily onboarding attempts')
    expect(messages['frontend-onboarding-funnel']).toBe('Frontend onboarding funnel')
    expect(messages['frontend-onboarding-funnel-description']).toBe('Progress through the new-user app-creation wizard')
    expect(messages['frontend-onboarding-new-users']).toBe('New user onboarding')
    expect(messages['frontend-onboarding-selected-period']).toBe('Selected period')
    expect(messages['frontend-onboarding-no-dropoff']).toBe('No drop-off')
    expect(messages['frontend-onboarding-transition']).toBe('{from} → {to}')
  })
})
