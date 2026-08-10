import type { FrontendOnboardingAnalytics } from '../src/services/adminFrontendOnboarding'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  createFrontendOnboardingAnalyticsLoader,
  formatFrontendOnboardingDuration,
} from '../src/services/adminFrontendOnboarding'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

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

  it('commits only the latest analytics request and lets only it clear loading', async () => {
    const first = deferred<FrontendOnboardingAnalytics | null>()
    const second = deferred<FrontendOnboardingAnalytics | null>()
    const requests = [first.promise, second.promise]
    const analyticsUpdates: Array<FrontendOnboardingAnalytics | null> = []
    const loadingUpdates: boolean[] = []
    const errors: unknown[] = []
    let requestIndex = 0
    const latestAnalytics = {
      ...analytics,
      kpis: { ...analytics.kpis, attempts: 20 },
    }
    const load = createFrontendOnboardingAnalyticsLoader(
      () => requests[requestIndex++],
      {
        onAnalytics: value => analyticsUpdates.push(value),
        onError: error => errors.push(error),
        onLoading: value => loadingUpdates.push(value),
      },
    )

    const firstLoad = load()
    const secondLoad = load()
    expect(loadingUpdates).toEqual([true, true])

    second.resolve(latestAnalytics)
    await secondLoad
    expect(analyticsUpdates).toEqual([latestAnalytics])
    expect(loadingUpdates).toEqual([true, true, false])

    first.resolve(analytics)
    await firstLoad
    expect(analyticsUpdates).toEqual([latestAnalytics])
    expect(loadingUpdates).toEqual([true, true, false])
    expect(errors).toEqual([])
  })

  it('ignores a stale analytics rejection', async () => {
    const first = deferred<FrontendOnboardingAnalytics | null>()
    const second = deferred<FrontendOnboardingAnalytics | null>()
    const requests = [first.promise, second.promise]
    const analyticsUpdates: Array<FrontendOnboardingAnalytics | null> = []
    const loadingUpdates: boolean[] = []
    const errors: unknown[] = []
    let requestIndex = 0
    const load = createFrontendOnboardingAnalyticsLoader(
      () => requests[requestIndex++],
      {
        onAnalytics: value => analyticsUpdates.push(value),
        onError: error => errors.push(error),
        onLoading: value => loadingUpdates.push(value),
      },
    )

    const firstLoad = load()
    const secondLoad = load()
    second.resolve(analytics)
    await secondLoad

    first.reject(new Error('stale failure'))
    await firstLoad
    expect(analyticsUpdates).toEqual([analytics])
    expect(errors).toEqual([])
    expect(loadingUpdates).toEqual([true, true, false])
  })

  it('clears analytics and reports the latest analytics rejection', async () => {
    const request = deferred<FrontendOnboardingAnalytics | null>()
    const analyticsUpdates: Array<FrontendOnboardingAnalytics | null> = []
    const loadingUpdates: boolean[] = []
    const errors: unknown[] = []
    const load = createFrontendOnboardingAnalyticsLoader(
      () => request.promise,
      {
        onAnalytics: value => analyticsUpdates.push(value),
        onError: error => errors.push(error),
        onLoading: value => loadingUpdates.push(value),
      },
    )
    const failure = new Error('latest failure')

    const pendingLoad = load()
    request.reject(failure)
    await pendingLoad

    expect(analyticsUpdates).toEqual([null])
    expect(errors).toEqual([failure])
    expect(loadingUpdates).toEqual([true, false])
  })

  it('wires the page to the frontend onboarding analytics metric', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

    expect(source).toContain(`fetchStats('frontend_onboarding_analytics')`)
    expect(source).toContain('createFrontendOnboardingAnalyticsLoader')
    expect(source.match(/watch\(\(\) => adminStore\.activeDateRange/g)).toHaveLength(1)
    expect(source).not.toContain('refreshTrigger')
    expect(source).toContain('if (!isReady.value)')
    expect(source).toContain('isReady.value = true')
    expect(source).toContain('void loadAnalytics()')
    expect(source).toContain('const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)')
  })

  it('uses the existing admin dashboard components and fixed onboarding version', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')

    expect(source).toContain('<PageLoader')
    expect(source.match(/<AdminFilterBar(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStatsCard(?:\s|\/?>)/g)).toHaveLength(4)
    expect(source.match(/<ChartCard(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStackedBarChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminFunnelChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source).toContain(`t('frontend-onboarding-version-1')`)
  })

  it('omits PostHog warnings, existing-org analytics, and selector UI', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

    expect(source).not.toContain('posthogWarning')
    expect(source).not.toContain('posthog_configured')
    expect(source).not.toContain('posthog_connected')
    expect(source).not.toContain('existing_org')
    expect(source).not.toContain('DateRangePicker')
    expect(source).not.toContain('<select')
    expect(source).not.toContain('version-selector')
    expect(source).not.toContain('intent-selector')
    expect(template).not.toContain('is-demo-data')
    expect(template).not.toContain('isDemoData')
    expect(template).not.toMatch(/\bretry\b/i)
    expect(template).not.toMatch(/\btruncat(?:e|ed|ion)\b/i)
    expect(template).not.toContain('error-message')
    expect(template).not.toContain('errorMessage')
    expect(template).not.toMatch(/v-(?:if|else-if)="[^"]*\berror\b/i)
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
