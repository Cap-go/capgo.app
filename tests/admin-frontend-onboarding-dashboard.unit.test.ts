import type { FrontendOnboardingAnalytics } from '../src/services/adminFrontendOnboarding'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  buildFrontendOnboardingFunnelSummaries,
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

  it.concurrent('adapts funnel drop-offs into ordered stage-to-stage conversions', () => {
    expect(buildFrontendOnboardingFunnelSummaries(analytics.funnel)).toEqual([
      {
        key: 'intent',
        conversion_percent: 100,
        reached: 10,
        from_label: null,
        to_label: 'Intent',
      },
      {
        key: 'details',
        conversion_percent: 80,
        reached: 8,
        from_label: 'Intent',
        to_label: 'App details',
      },
      {
        key: 'organization',
        conversion_percent: 62.5,
        reached: 5,
        from_label: 'App details',
        to_label: 'Organization',
      },
      {
        key: 'setup',
        conversion_percent: 80,
        reached: 4,
        from_label: 'Organization',
        to_label: 'Setup reached',
      },
    ])
  })

  it.concurrent('shows zero conversion for every stage when the selected cohort is empty', () => {
    const emptyFunnel = analytics.funnel.map(stage => ({
      ...stage,
      reached: 0,
      of_start_percent: 0,
      dropoff_percent: 0,
    }))

    expect(buildFrontendOnboardingFunnelSummaries(emptyFunnel).map(stage => stage.conversion_percent)).toEqual([0, 0, 0, 0])
  })

  it.concurrent('shows zero conversion after a stage has dropped to zero', () => {
    const collapsedFunnel = analytics.funnel.map((stage, index) => ({
      ...stage,
      reached: [10, 8, 0, 0][index],
      dropoff_percent: [0, 20, 100, 0][index],
    }))

    expect(buildFrontendOnboardingFunnelSummaries(collapsedFunnel).map(stage => stage.conversion_percent)).toEqual([100, 80, 0, 0])
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

  it.concurrent('commits only the latest analytics request and lets only it clear loading', async () => {
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

  it.concurrent('ignores a stale analytics rejection', async () => {
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

  it.concurrent('clears analytics and reports the latest analytics rejection', async () => {
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

  it.concurrent('clears both page loaders when the latest request finishes before a stale request', async () => {
    const first = deferred<FrontendOnboardingAnalytics | null>()
    const second = deferred<FrontendOnboardingAnalytics | null>()
    const requests = [first.promise, second.promise]
    let requestIndex = 0
    let analyticsState: FrontendOnboardingAnalytics | null = null
    let isLoadingStats = false
    let isLoading = true
    const latestAnalytics = {
      ...analytics,
      kpis: { ...analytics.kpis, attempts: 20 },
    }
    const load = createFrontendOnboardingAnalyticsLoader(
      () => requests[requestIndex++],
      {
        onAnalytics: (value) => {
          analyticsState = value
        },
        onError: () => {},
        onLoading: (value) => {
          isLoadingStats = value
          if (!value)
            isLoading = false
        },
      },
    )

    const firstLoad = load()
    const secondLoad = load()
    expect(isLoadingStats).toBe(true)
    expect(isLoading).toBe(true)

    second.resolve(latestAnalytics)
    await secondLoad
    expect(analyticsState).toEqual(latestAnalytics)
    expect(isLoadingStats).toBe(false)
    expect(isLoading).toBe(false)

    first.resolve(analytics)
    await firstLoad
    expect(analyticsState).toEqual(latestAnalytics)
    expect(isLoadingStats).toBe(false)
    expect(isLoading).toBe(false)
  })

  it.concurrent('wires the page to the frontend onboarding analytics metric', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const onLoadingCallback = source.match(/onLoading: \(value\) => \{([\s\S]*?)\n {4}\},/)?.[1] ?? ''

    expect(source).toContain(`fetchStats('frontend_onboarding_analytics')`)
    expect(source).toContain('createFrontendOnboardingAnalyticsLoader')
    expect(source.match(/watch\(\(\) => adminStore\.activeDateRange/g)).toHaveLength(1)
    expect(source).not.toContain('refreshTrigger')
    expect(source).toContain('if (!isReady.value)')
    expect(source).toContain('isReady.value = true')
    expect(source).toContain('void loadAnalytics()')
    expect(source).not.toContain('await loadAnalytics()')
    expect(onLoadingCallback).toContain('isLoadingStats.value = value')
    expect(onLoadingCallback).toContain('if (!value)')
    expect(onLoadingCallback).toContain('isLoading.value = false')
    expect(source).toContain('const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)')
  })

  it.concurrent('uses the existing admin dashboard components and fixed onboarding version', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

    expect(source).toContain('<PageLoader')
    expect(source.match(/<AdminFilterBar(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStatsCard(?:\s|\/?>)/g)).toHaveLength(4)
    expect(source.match(/<ChartCard(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStackedBarChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminFunnelChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source).toContain(`t('frontend-onboarding-version-1')`)
    expect(source).toContain('buildFrontendOnboardingFunnelSummaries')
    expect(template).toContain('summary.conversion_percent')
    expect(template).not.toContain('of_start_percent')

    const statsCard = await readFile(new URL('../src/components/admin/AdminStatsCard.vue', import.meta.url), 'utf8')
    const funnelChart = await readFile(new URL('../src/components/admin/AdminFunnelChart.vue', import.meta.url), 'utf8')
    expect(statsCard).toContain('class="d-loading d-loading-spinner d-loading-lg"')
    expect(funnelChart).toContain('class="d-loading d-loading-spinner d-loading-lg text-primary"')
  })

  it.concurrent('shows request failures instead of zero analytics', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

    expect(source).toContain('const loadError = ref(false)')
    expect(source).toContain('loadError.value = false')
    expect(source).toContain('loadError.value = true')
    expect(template).toContain('v-if="loadError"')
    expect(template).toContain('role="alert"')
    expect(template).toContain(`t('frontend-onboarding-load-error')`)
    expect(template).toContain('<template v-else>')
  })

  it.concurrent('omits existing-org analytics and selector UI', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

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
  })

  it.concurrent('registers the frontend onboarding admin tab', async () => {
    const source = await readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8')

    expect(source).toContain(`{ label: 'frontend-onboarding', icon:`)
    expect(source).toContain(`key: '/frontend-onboarding'`)
  })

  it.concurrent('defines every frontend onboarding page label in English', async () => {
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
    expect(messages['frontend-onboarding-no-dropoff']).toBe('No drop-off')
    expect(messages['frontend-onboarding-transition']).toBe('{from} → {to}')
    expect(messages['frontend-onboarding-load-error']).toBe('Unable to load onboarding analytics. Please try again.')
  })
})
