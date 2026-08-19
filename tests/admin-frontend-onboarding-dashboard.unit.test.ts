import type {
  FrontendOnboardingAnalytics,
  FrontendOnboardingDailySetupCliOutcomeCounts,
} from '../src/services/adminFrontendOnboarding'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingDailySetupCliSeries,
  buildFrontendOnboardingDailyWelcomeOutcomeSeries,
  buildFrontendOnboardingFunnelStages,
  buildFrontendOnboardingFunnelSummaries,
  buildFrontendOnboardingGraphMetrics,
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

function setupCliOutcomeCounts(value: number): FrontendOnboardingDailySetupCliOutcomeCounts {
  return {
    cli_copy_init: value,
    ai_copy_init: value,
    both_copy_init: value,
    no_copy_init: value,
    cli_copy_other_cli: value,
    ai_copy_other_cli: value,
    both_copy_other_cli: value,
    no_copy_other_cli: value,
    cli_copy_no_cli: value,
    ai_copy_no_cli: value,
    both_copy_no_cli: value,
    no_action: value,
  }
}

describe('admin frontend onboarding dashboard', () => {
  const analytics: FrontendOnboardingAnalytics = {
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
      { date: '2026-08-10', v1_attempts: 6, v2_attempts: 3, v3_attempts: 2, v4_attempts: 4 },
      { date: '2026-08-09', v1_attempts: 4, v2_attempts: 2, v3_attempts: 1, v4_attempts: 2 },
    ],
    daily_welcome_outcomes: [
      { date: '2026-08-10', welcome_advanced_to_intent: 4, welcome_not_viewed: 2, welcome_did_not_advance: 1 },
      { date: '2026-08-09', welcome_advanced_to_intent: 2, welcome_not_viewed: 1, welcome_did_not_advance: 3 },
    ],
    daily_conversions: {
      intent_to_details: [
        { date: '2026-08-09', started: 5, converted: 4, conversion_percent: 80 },
        { date: '2026-08-10', started: 0, converted: 0, conversion_percent: null },
      ],
      details_to_organization: [
        { date: '2026-08-09', started: 4, converted: 3, conversion_percent: 75 },
      ],
      organization_to_setup: [
        { date: '2026-08-09', started: 3, converted: 2, conversion_percent: 2 / 3 * 100 },
      ],
    },
    funnels: {
      v1: [
        { key: 'intent', label: 'Intent', reached: 10, of_start_percent: 100, dropoff_percent: 0 },
        { key: 'details', label: 'App details', reached: 8, of_start_percent: 80, dropoff_percent: 20 },
        { key: 'organization', label: 'Organization', reached: 5, of_start_percent: 50, dropoff_percent: 37.5 },
        { key: 'setup', label: 'Setup reached', reached: 4, of_start_percent: 40, dropoff_percent: 20 },
      ],
      v2: [
        { key: 'intent', label: 'Intent', reached: 5, of_start_percent: 100, dropoff_percent: 0 },
        { key: 'details', label: 'App details', reached: 4, of_start_percent: 80, dropoff_percent: 20 },
        { key: 'organization', label: 'Organization', reached: 3, of_start_percent: 60, dropoff_percent: 25 },
        { key: 'setup', label: 'Setup reached', reached: 2, of_start_percent: 40, dropoff_percent: 33.3 },
      ],
      v3: [
        { key: 'intent', label: 'Intent', reached: 4, of_start_percent: 100, dropoff_percent: 0 },
        { key: 'details', label: 'App details', reached: 3, of_start_percent: 75, dropoff_percent: 25 },
        { key: 'organization', label: 'Organization', reached: 2, of_start_percent: 50, dropoff_percent: 1 / 3 * 100 },
        { key: 'setup', label: 'Setup reached', reached: 1, of_start_percent: 25, dropoff_percent: 50 },
      ],
      v4: [
        { key: 'intent', label: 'Intent', reached: 4, of_start_percent: 100, dropoff_percent: 0 },
        { key: 'details', label: 'App details', reached: 3, of_start_percent: 75, dropoff_percent: 25 },
        { key: 'organization', label: 'Organization', reached: 2, of_start_percent: 50, dropoff_percent: 1 / 3 * 100 },
        { key: 'setup', label: 'Setup reached', reached: 1, of_start_percent: 25, dropoff_percent: 50 },
      ],
    },
    deduplicated: {
      daily_attempts: [
        { date: '2026-08-10', v1_attempts: 5, v2_attempts: 2, v3_attempts: 1, v4_attempts: 3 },
      ],
      daily_welcome_outcomes: [
        { date: '2026-08-10', welcome_advanced_to_intent: 3, welcome_not_viewed: 1, welcome_did_not_advance: 1 },
      ],
      funnels: {
        v3: [
          { key: 'intent', label: 'Intent', reached: 3, of_start_percent: 100, dropoff_percent: 0 },
        ],
        v4: [
          { key: 'intent', label: 'Intent', reached: 3, of_start_percent: 100, dropoff_percent: 0 },
        ],
      },
    },
    v2_graph: {
      nodes: [
        { key: 'details', count: 4 },
        { key: 'store_opened', count: 3 },
        { key: 'import_clicked', count: 2 },
      ],
    },
    v3_graph: {
      nodes: [
        { key: 'details', count: 3 },
        { key: 'store_opened', count: 2 },
        { key: 'import_clicked', count: 1 },
      ],
    },
    v4_graph: {
      nodes: [
        { key: 'details', count: 4 },
        { key: 'store_opened', count: 3 },
        { key: 'import_clicked', count: 2 },
      ],
    },
    v2_v3_setup_cli_outcomes: {
      total_users: 2,
      cli_only: 1,
      cli_and_ai_instructions: 1,
      no_cli: 0,
    },
    daily_setup_cli_outcomes: [{
      date: '2026-08-10',
      first_time: {
        cli_copy_init: 2,
        ai_copy_init: 0,
        both_copy_init: 0,
        no_copy_init: 0,
        cli_copy_other_cli: 0,
        ai_copy_other_cli: 0,
        both_copy_other_cli: 0,
        no_copy_other_cli: 0,
        cli_copy_no_cli: 0,
        ai_copy_no_cli: 0,
        both_copy_no_cli: 0,
        no_action: 0,
      },
      returning: {
        cli_copy_init: 0,
        ai_copy_init: 0,
        both_copy_init: 0,
        no_copy_init: 0,
        cli_copy_other_cli: 0,
        ai_copy_other_cli: 0,
        both_copy_other_cli: 0,
        no_copy_other_cli: 0,
        cli_copy_no_cli: 0,
        ai_copy_no_cli: 1,
        both_copy_no_cli: 0,
        no_action: 0,
      },
    }],
    posthog_configured: true,
    posthog_connected: true,
  }

  it.concurrent('adapts split daily attempts into ordered version chart series', () => {
    expect(buildFrontendOnboardingDailySeries(analytics.daily_attempts, 'V1', 'V2', 'V3', 'V4')).toEqual([
      {
        label: 'V1',
        color: '#a78bfa',
        data: [
          { date: '2026-08-10', value: 6 },
          { date: '2026-08-09', value: 4 },
        ],
      },
      {
        label: 'V2',
        color: '#06b6d4',
        data: [
          { date: '2026-08-10', value: 3 },
          { date: '2026-08-09', value: 2 },
        ],
      },
      {
        label: 'V3',
        color: '#10b981',
        data: [
          { date: '2026-08-10', value: 2 },
          { date: '2026-08-09', value: 1 },
        ],
      },
      {
        label: 'V4',
        color: '#f59e0b',
        data: [
          { date: '2026-08-10', value: 4 },
          { date: '2026-08-09', value: 2 },
        ],
      },
    ])
    expect(buildFrontendOnboardingDailySeries([], 'V1', 'V2', 'V3', 'V4')).toEqual([
      { label: 'V1', color: '#a78bfa', data: [] },
      { label: 'V2', color: '#06b6d4', data: [] },
      { label: 'V3', color: '#10b981', data: [] },
      { label: 'V4', color: '#f59e0b', data: [] },
    ])
    expect(buildFrontendOnboardingDailySeries([
      { date: '2026-08-08', v1_attempts: 1, v2_attempts: 2, v3_attempts: 3 },
    ], 'V1', 'V2', 'V3', 'V4')[3]?.data).toEqual([
      { date: '2026-08-08', value: 0 },
    ])
  })

  it.concurrent('adapts daily Welcome outcomes into absolute stacked series', () => {
    expect(buildFrontendOnboardingDailyWelcomeOutcomeSeries(
      analytics.daily_welcome_outcomes ?? [],
      'Advanced',
      'Welcome not viewed',
      'Did not advance',
    )).toEqual([
      {
        label: 'Advanced',
        color: '#10b981',
        data: [
          { date: '2026-08-10', value: 4 },
          { date: '2026-08-09', value: 2 },
        ],
      },
      {
        label: 'Welcome not viewed',
        color: '#f59e0b',
        data: [
          { date: '2026-08-10', value: 2 },
          { date: '2026-08-09', value: 1 },
        ],
      },
      {
        label: 'Did not advance',
        color: '#f43f5e',
        data: [
          { date: '2026-08-10', value: 1 },
          { date: '2026-08-09', value: 3 },
        ],
      },
    ])
  })

  it.concurrent('builds paired stacks only for Setup CLI outcome categories present in the range', () => {
    const labels = {
      cli_copy_init: 'CLI copy + init',
      ai_copy_init: 'AI copy + init',
      both_copy_init: 'Both copied + init',
      no_copy_init: 'No copy + init',
      cli_copy_other_cli: 'CLI copy + other CLI',
      ai_copy_other_cli: 'AI copy + other CLI',
      both_copy_other_cli: 'Both copied + other CLI',
      no_copy_other_cli: 'No copy + other CLI',
      cli_copy_no_cli: 'CLI copied · no CLI run',
      ai_copy_no_cli: 'AI copied · no CLI run',
      both_copy_no_cli: 'Both copied · no CLI run',
      no_action: 'No action',
    }

    const series = buildFrontendOnboardingDailySetupCliSeries(
      analytics.daily_setup_cli_outcomes,
      labels,
      'First-time',
      'Returning',
    )

    expect(series).toEqual([
      {
        label: 'CLI copy + init',
        color: '#047857',
        stack: 'first_time',
        stackLabel: 'First-time',
        data: [{ date: '2026-08-10', value: 2 }],
      },
      {
        label: 'CLI copy + init',
        color: '#047857',
        stack: 'returning',
        stackLabel: 'Returning',
        data: [{ date: '2026-08-10', value: 0 }],
      },
      {
        label: 'AI copied · no CLI run',
        color: '#f97316',
        stack: 'first_time',
        stackLabel: 'First-time',
        data: [{ date: '2026-08-10', value: 0 }],
      },
      {
        label: 'AI copied · no CLI run',
        color: '#f97316',
        stack: 'returning',
        stackLabel: 'Returning',
        data: [{ date: '2026-08-10', value: 1 }],
      },
    ])
    expect(series.some(item => item.label === 'No action')).toBe(false)
  })

  it.concurrent('keeps every date and uses the stable outcome order and colors', () => {
    const outcomeKeys = [
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
    const colors = [
      '#047857',
      '#10b981',
      '#34d399',
      '#86efac',
      '#1d4ed8',
      '#3b82f6',
      '#7c3aed',
      '#a78bfa',
      '#c2410c',
      '#f97316',
      '#fbbf24',
      '#94a3b8',
    ]
    const zeroCounts = setupCliOutcomeCounts(0)
    const activeCounts = setupCliOutcomeCounts(1)
    const labels = {
      cli_copy_init: 'Label cli_copy_init',
      ai_copy_init: 'Label ai_copy_init',
      both_copy_init: 'Label both_copy_init',
      no_copy_init: 'Label no_copy_init',
      cli_copy_other_cli: 'Label cli_copy_other_cli',
      ai_copy_other_cli: 'Label ai_copy_other_cli',
      both_copy_other_cli: 'Label both_copy_other_cli',
      no_copy_other_cli: 'Label no_copy_other_cli',
      cli_copy_no_cli: 'Label cli_copy_no_cli',
      ai_copy_no_cli: 'Label ai_copy_no_cli',
      both_copy_no_cli: 'Label both_copy_no_cli',
      no_action: 'Label no_action',
    }

    const series = buildFrontendOnboardingDailySetupCliSeries([
      {
        date: '2026-08-09',
        first_time: activeCounts,
        returning: zeroCounts,
      },
      {
        date: '2026-08-10',
        first_time: zeroCounts,
        returning: activeCounts,
      },
    ], labels, 'First-time', 'Returning')

    expect(series).toHaveLength(outcomeKeys.length * 2)
    expect(series.map(item => item.label)).toEqual(outcomeKeys.flatMap(key => [`Label ${key}`, `Label ${key}`]))
    expect(series.map(item => item.color)).toEqual(colors.flatMap(color => [color, color]))
    expect(series.map(item => item.stack)).toEqual(outcomeKeys.flatMap(() => ['first_time', 'returning']))
    expect(series.map(item => item.stackLabel)).toEqual(outcomeKeys.flatMap(() => ['First-time', 'Returning']))
    expect(series[0].data).toEqual([
      { date: '2026-08-09', value: 1 },
      { date: '2026-08-10', value: 0 },
    ])
    expect(series[1].data).toEqual([
      { date: '2026-08-09', value: 0 },
      { date: '2026-08-10', value: 1 },
    ])
  })

  it.concurrent('adapts reordered funnel stages with stable key-based colors', () => {
    expect(buildFrontendOnboardingFunnelStages([
      analytics.funnels.v1[3],
      analytics.funnels.v1[0],
      analytics.funnels.v1[2],
    ])).toEqual([
      { label: 'Setup reached', value: 4, color: '#10b981' },
      { label: 'Intent', value: 10, color: '#119eff' },
      { label: 'Organization', value: 5, color: '#8b5cf6' },
    ])
    expect(buildFrontendOnboardingFunnelStages(analytics.funnels.v2)).toEqual([
      { label: 'Intent', value: 5, color: '#119eff' },
      { label: 'App details', value: 4, color: '#6366f1' },
      { label: 'Organization', value: 3, color: '#8b5cf6' },
      { label: 'Setup reached', value: 2, color: '#10b981' },
    ])
  })

  it.concurrent('adapts either selected funnel into ordered stage-to-stage conversions', () => {
    expect(buildFrontendOnboardingFunnelSummaries(analytics.funnels.v1)).toEqual([
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
    expect(buildFrontendOnboardingFunnelSummaries(analytics.funnels.v2).map(stage => stage.reached)).toEqual([5, 4, 3, 2])
  })

  it.concurrent('shows zero conversion for every stage when the selected cohort is empty', () => {
    const emptyFunnel = analytics.funnels.v1.map(stage => ({
      ...stage,
      reached: 0,
      of_start_percent: 0,
      dropoff_percent: 0,
    }))

    expect(buildFrontendOnboardingFunnelSummaries(emptyFunnel).map(stage => stage.conversion_percent)).toEqual([0, 0, 0, 0])
  })

  it.concurrent('shows zero conversion after a stage has dropped to zero', () => {
    const collapsedFunnel = analytics.funnels.v1.map((stage, index) => ({
      ...stage,
      reached: [10, 8, 0, 0][index],
      dropoff_percent: [0, 20, 100, 0][index],
    }))

    expect(buildFrontendOnboardingFunnelSummaries(collapsedFunnel).map(stage => stage.conversion_percent)).toEqual([100, 80, 0, 0])
  })

  it.concurrent('calculates graph metrics against app details and immediate parents', () => {
    expect(buildFrontendOnboardingGraphMetrics([
      { key: 'details' },
      { key: 'store_opened', parentKey: 'details' },
      { key: 'import_clicked', parentKey: 'store_opened' },
    ], analytics.v2_graph.nodes, 4)).toEqual({
      details: { count: 4, levelPercent: 100 },
      store_opened: { count: 3, levelPercent: 75, previousPercent: 75 },
      import_clicked: { count: 2, levelPercent: 50, previousPercent: 66.66666666666666 },
    })
  })

  it.concurrent('uses zero metrics for missing counts and missing or zero denominators', () => {
    expect(buildFrontendOnboardingGraphMetrics([
      { key: 'missing' },
      { key: 'missing-parent-child', parentKey: 'missing_parent' },
      { key: 'zero-parent-child', parentKey: 'zero_parent' },
    ], [
      { key: 'missing-parent-child', count: 3 },
      { key: 'zero-parent-child', count: 3 },
      { key: 'zero_parent', count: 0 },
    ], 0)).toEqual({
      'missing': { count: 0, levelPercent: 0 },
      'missing-parent-child': { count: 3, levelPercent: 0, previousPercent: 0 },
      'zero-parent-child': { count: 3, levelPercent: 0, previousPercent: 0 },
    })
    expect(buildFrontendOnboardingGraphMetrics([{ key: 'event' }], [{ key: 'event', count: 3 }], undefined)).toEqual({
      event: { count: 3, levelPercent: 0 },
    })
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
    expect(onLoadingCallback).toContain('if (value)')
    expect(onLoadingCallback).toContain('loadError.value = false')
    expect(onLoadingCallback).toContain('if (!value)')
    expect(onLoadingCallback).toContain('isLoading.value = false')
    expect(source).toContain('const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)')
    expect(source).toContain("rawLatestFunnel.value.version === 'v4'\n  ? visibleAnalytics.value?.v4_kpis ?? visibleAnalytics.value?.kpis")
    expect(source).toContain("rawLatestFunnel.value.version === 'v4'\n  ? visibleAnalytics.value?.v4_daily_conversions ?? visibleAnalytics.value?.daily_conversions")
  })

  it.concurrent('uses the existing admin dashboard components for v4 and the legacy funnel', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

    expect(source).toContain('<PageLoader')
    expect(source.match(/<AdminFilterBar(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStatsCard(?:\s|\/?>)/g)).toHaveLength(4)
    expect(source.match(/<ChartCard(?:\s|\/?>)/g)).toHaveLength(10)
    expect(source.match(/<AdminBarChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStackedBarChart(?:\s|\/?>)/g)).toHaveLength(3)
    expect(source.match(/<AdminDailyConversionChart(?:\s|\/?>)/g)).toHaveLength(3)
    expect(source.match(/<AdminFunnelChart(?:\s|\/?>)/g)).toHaveLength(2)
    expect(source.match(/<AdminOnboardingJourneyGraph(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source).toContain('<AdminOnboardingJourneyGraph :config="onboardingGraphV4" />')
    expect(source).toContain('<AdminFunnelChart :stages="v4FunnelStages" />')
    expect(source).toContain('<AdminFunnelChart :stages="v1FunnelStages" />')
    expect(source).not.toContain('<AdminFunnelChart :stages="v4FunnelStages" :is-loading="isLoadingStats" />')
    expect(source).not.toContain('<AdminFunnelChart :stages="v1FunnelStages" :is-loading="isLoadingStats" />')
    expect(source).toContain('orientation="vertical"')
    expect(source).toContain(':values="setupCliOutcomeValues"')
    expect(source).toContain('visibleAnalytics.value?.v2_v4_setup_cli_outcomes')
    expect(source).toContain('?? visibleAnalytics.value?.v2_v3_setup_cli_outcomes')
    expect(source).toContain('buildFrontendOnboardingDailySetupCliSeries')
    expect(source).toContain('visibleAnalytics.value?.daily_setup_cli_outcomes')
    expect(source).toContain(':series="dailySetupCliSeries"')
    expect(source).toContain('accessible-borders')
    expect(source).not.toContain('v-if="isLoadingStats" class="grid min-h-72 place-items-center"')
    expect(source).toContain(`t('frontend-onboarding-version-2')`)
    expect(source).toContain(`t('frontend-onboarding-version-3')`)
    expect(source).toContain(`t('frontend-onboarding-version-4')`)
    expect(source).toContain(`'frontend-onboarding-funnel-v4'`)
    expect(source).toContain(`t('frontend-onboarding-funnel-v1-legacy')`)
    expect(source).not.toContain(`t('frontend-onboarding-demo-data')`)
    expect(source).toContain('buildFrontendOnboardingGraphMetrics')
    expect(source).toContain('visibleAnalytics.value?.v4_graph?.nodes')
    expect(source).toContain('visibleAnalytics.value?.v3_graph?.nodes')
    expect(source).not.toContain('onboardingGraphV4Demo')
    expect(source).toContain('buildFrontendOnboardingFunnelSummaries')
    expect(template).toContain('summary.conversion_percent')
    expect(template).not.toContain('of_start_percent')

    const v4FunnelIndex = template.indexOf('chart-id="funnel-v4"')
    const intentDetailsChartIndex = template.indexOf(`t('frontend-onboarding-daily-intent-to-details')`)
    const detailsOrganizationChartIndex = template.indexOf(`t('frontend-onboarding-daily-details-to-organization')`)
    const organizationSetupChartIndex = template.indexOf(`t('frontend-onboarding-daily-organization-to-setup')`)
    const graphIndex = template.indexOf('chart-id="journey-graph-v4"')
    const cliOutcomeIndex = template.indexOf(`t('frontend-onboarding-setup-cli-outcomes-v2-v4')`)
    const dailyCliOutcomeIndex = template.indexOf(`t('frontend-onboarding-daily-setup-cli-outcomes-v2-v4')`)
    const legacyIndex = template.indexOf(`t('frontend-onboarding-funnel-v1-legacy')`)
    expect(v4FunnelIndex).toBeLessThan(graphIndex)
    expect(v4FunnelIndex).toBeLessThan(intentDetailsChartIndex)
    expect(intentDetailsChartIndex).toBeLessThan(detailsOrganizationChartIndex)
    expect(detailsOrganizationChartIndex).toBeLessThan(organizationSetupChartIndex)
    expect(organizationSetupChartIndex).toBeLessThan(graphIndex)
    expect(graphIndex).toBeLessThan(cliOutcomeIndex)
    expect(cliOutcomeIndex).toBeLessThan(dailyCliOutcomeIndex)
    expect(dailyCliOutcomeIndex).toBeLessThan(legacyIndex)

    const dailyCliOutcomeSection = template.slice(dailyCliOutcomeIndex, legacyIndex)
    expect(dailyCliOutcomeSection).toContain(':has-data="hasDailySetupCliOutcomeData"')
    expect(dailyCliOutcomeSection).toContain(`t('frontend-onboarding-daily-setup-cli-outcomes-description')`)
    expect(dailyCliOutcomeSection).toContain('<AdminStackedBarChart')
    expect(dailyCliOutcomeSection).toContain(':series="dailySetupCliSeries"')
    expect(dailyCliOutcomeSection).not.toContain(':total=')
    expect(dailyCliOutcomeSection).not.toContain(':unit=')
    expect(source).not.toContain('id: \'organization_name\'')
    expect(source).not.toContain('id: \'organization_size\'')
    expect(source).not.toContain('id: \'invite_opened\'')
    expect(source).not.toContain('id: \'notification_preference\'')
    expect(source).toContain(`from: 'import_succeeded', toPoint: { x: 2130, y: 455 }, style: 'dotted'`)
    expect(source).toContain(`fromPoint: { x: 2130, y: 90 }, toPoint: { x: 2130, y: 870 }, style: 'dotted', arrow: false`)
    expect(source).toContain(`fromPoint: { x: 2130, y: 540 }, to: 'organization', style: 'primary'`)
    for (const eventKey of [
      'onboarding_app_creation_started',
      'onboarding_app_creation_succeeded',
      'onboarding_app_creation_failed',
      'onboarding_organization_import_opened',
      'onboarding_organization_import_submitted',
      'onboarding_organization_import_succeeded',
      'onboarding_organization_import_failed',
      'onboarding_organization_invite_viewed',
      'onboarding_organization_invite_opened',
      'onboarding_organization_invite_succeeded',
      'onboarding_organization_invite_continued',
      'onboarding_technical_invite_opened',
      'onboarding_technical_invite_succeeded',
    ]) {
      expect(source).toContain(`eventKey: '${eventKey}'`)
    }
    expect(source).toContain(`from: 'organization', to: 'organization_import_opened', style: 'branch'`)
    expect(source).toContain(`from: 'organization', to: 'organization_invite_viewed', style: 'branch'`)
    expect(source).toContain(`from: 'organization', to: 'app_creation_started', style: 'branch'`)
    expect(source).toContain(`from: 'app_creation_started', to: 'app_creation_succeeded', style: 'branch'`)
    expect(source).toContain(`from: 'app_creation_started', to: 'app_creation_failed', style: 'branch'`)
    expect(source).toContain(`from: 'setup', to: 'technical_invite_opened', style: 'branch'`)

    const statsCard = await readFile(new URL('../src/components/admin/AdminStatsCard.vue', import.meta.url), 'utf8')
    const funnelChart = await readFile(new URL('../src/components/admin/AdminFunnelChart.vue', import.meta.url), 'utf8')
    expect(statsCard).toContain('class="d-loading d-loading-spinner d-loading-lg"')
    expect(funnelChart).toContain('class="d-loading d-loading-spinner d-loading-lg text-primary"')
  })

  it.concurrent('shows independent local de-duplicate controls on the expanded daily attempts and v4 funnel cards', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const control = await readFile(new URL('../src/components/admin/AdminChartDeduplicateControl.vue', import.meta.url), 'utf8')
    const dailyAttemptsIndex = source.indexOf(`t('frontend-onboarding-daily-attempts')`)
    const v4FunnelIndex = source.indexOf('chart-id="funnel-v4"')
    const nextChartIndex = source.indexOf(`t('frontend-onboarding-daily-intent-to-details')`)

    expect(source).toContain('const deduplicateDailyAttempts = ref(false)')
    expect(source).toContain('const deduplicateV4Funnel = ref(false)')
    expect(source).toContain('const displayedDailyAttempts = computed')
    expect(source).toContain('deduplicateDailyAttempts.value')
    expect(source).toContain('visibleAnalytics.value?.deduplicated.daily_attempts')
    expect(source).toContain('const displayedV4Funnel = computed')
    expect(source).toContain('deduplicateV4Funnel.value')
    expect(source).toContain('visibleAnalytics.value?.deduplicated.funnels')
    expect(source).toContain('stages: v4 ?? funnels?.v3 ?? []')
    expect(source).toContain('buildFrontendOnboardingDailySeries(\n  displayedDailyAttempts.value')
    expect(source).toContain('buildFrontendOnboardingFunnelStages(displayedV4Funnel.value)')
    expect(source).toContain('buildFrontendOnboardingFunnelSummaries(displayedV4Funnel.value)')
    expect(source.match(/deduplicateDailyAttempts/g)).toHaveLength(3)
    expect(source.match(/deduplicateV4Funnel/g)).toHaveLength(3)
    expect(source.slice(dailyAttemptsIndex, v4FunnelIndex)).toContain(`:chart-label="t('frontend-onboarding-daily-attempts')"`)
    expect(source.slice(v4FunnelIndex, nextChartIndex)).toContain(':chart-label="displayedFunnelTitle"')
    expect(source).toContain('const result = await adminStore.fetchStats(\'frontend_onboarding_analytics\')')
    expect(source).toContain('!Array.isArray(result.deduplicated?.daily_attempts)')
    expect(source).toContain('!Array.isArray(result.deduplicated?.funnels?.v4)')
    expect(source).toContain('!Array.isArray(result.deduplicated?.funnels?.v3)')
    expect(source).toContain('throw new Error(\'Frontend onboarding analytics response is missing deduplicated chart data\')')
    expect(control).toContain('data-test="deduplicate-by-user"')
    expect(control).toContain('chartLabel: string')
    expect(control).toContain('type="checkbox"')
    expect(control).toContain(`:aria-label="t('frontend-onboarding-deduplicate-by-user-chart', { chart: props.chartLabel })"`)
    expect(control).toContain('justify-end')
    expect(control).toContain(`t('frontend-onboarding-deduplicate-by-user')`)
  })

  it.concurrent('renders v4 Welcome outcomes directly below the v4 funnel with an independent de-duplicate control', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const service = await readFile(new URL('../src/services/adminFrontendOnboarding.ts', import.meta.url), 'utf8')
    const messages = await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))
    const funnelIndex = template.indexOf('chart-id="funnel-v4"')
    const welcomeOutcomesIndex = template.indexOf('chart-id="welcome-outcomes-v4"')
    const intentDetailsIndex = template.indexOf('chart-id="daily-intent-to-details"')

    expect(source).toContain('const deduplicateWelcomeOutcomes = ref(false)')
    expect(source).toContain('const displayedWelcomeOutcomes = computed')
    expect(source).toContain('deduplicateWelcomeOutcomes.value')
    expect(source).toContain('visibleAnalytics.value?.deduplicated.daily_welcome_outcomes')
    expect(source).toContain('visibleAnalytics.value?.daily_welcome_outcomes')
    expect(source).toContain('buildFrontendOnboardingDailyWelcomeOutcomeSeries')
    expect(source).toContain('const hasWelcomeOutcomeData = computed')
    expect(source).not.toContain('!Array.isArray(result.daily_welcome_outcomes)')
    expect(source).not.toContain('!Array.isArray(result.deduplicated?.daily_welcome_outcomes)')
    expect(service.match(/daily_welcome_outcomes\?: FrontendOnboardingDailyWelcomeOutcomePoint\[\]/g)).toHaveLength(2)
    expect(funnelIndex).toBeGreaterThanOrEqual(0)
    expect(welcomeOutcomesIndex).toBeGreaterThan(funnelIndex)
    expect(welcomeOutcomesIndex).toBeLessThan(intentDetailsIndex)

    const section = template.slice(welcomeOutcomesIndex, intentDetailsIndex)
    expect(section).toContain(`t('frontend-onboarding-welcome-outcomes-v4')`)
    expect(section).toContain(`t('frontend-onboarding-welcome-outcomes-v4-description')`)
    expect(section).toContain(':series="welcomeOutcomeSeries"')
    expect(section).toContain('accessible-borders')
    expect(section).toContain('v-model="deduplicateWelcomeOutcomes"')
    expect(section).toContain(`:chart-label="t('frontend-onboarding-welcome-outcomes-v4')"`)
    expect(source.match(/deduplicateWelcomeOutcomes/g)).toHaveLength(3)
    expect(messages).toContain('"frontend-onboarding-welcome-outcomes-v4"')
    expect(messages).toContain('"frontend-onboarding-welcome-advanced-to-intent"')
    expect(messages).toContain('"frontend-onboarding-welcome-not-viewed": "Did not view Welcome screen"')
    expect(messages).toContain('"frontend-onboarding-welcome-did-not-advance"')
  })

  it.concurrent('labels v3 fallback data and resolves drop-off labels from the same funnel source', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/frontend-onboarding.vue', import.meta.url), 'utf8')
    const template = source.slice(source.indexOf('<template>'))

    expect(source).toContain('const rawLatestFunnel = computed')
    expect(source).toContain("version: v4 === undefined ? 'v3' : 'v4'")
    expect(source).toContain('const displayedLatestFunnel = computed')
    expect(source).toContain('const displayedFunnelTitle = computed')
    expect(source).toContain(`t(displayedLatestFunnel.value.version === 'v4'`)
    expect(source).toContain('const onboardingGraphSource = computed')
    expect(source).toContain('const graphTitle = computed')
    expect(source).toContain(`t(onboardingGraphSource.value.version === 'v4'`)
    expect(source).toContain('const stages = rawLatestFunnel.value.stages')
    expect(source).not.toContain('const stages = visibleAnalytics.value?.funnels.v4 ?? []')
    expect(template).toContain(':title="displayedFunnelTitle"')
    expect(template).toContain('{{ displayedFunnelTitle }}')
    expect(template).toContain(':chart-label="displayedFunnelTitle"')
    expect(template).toContain(':title="graphTitle"')
    expect(template).toContain('{{ graphTitle }}')
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

    expect(messages['frontend-onboarding']).toBe('Onboarding')
    expect(messages['frontend-onboarding-version-1']).toBe('Onboarding v1')
    expect(messages['frontend-onboarding-version-2']).toBe('Onboarding v2')
    expect(messages['frontend-onboarding-version-3']).toBe('Onboarding v3')
    expect(messages['frontend-onboarding-version-4']).toBe('Onboarding v4')
    expect(messages['frontend-onboarding-attempts']).toBe('Onboarding attempts')
    expect(messages['frontend-onboarding-attempts-subtitle']).toBe('Unique onboarding attempts')
    expect(messages['frontend-onboarding-completed']).toBe('Onboarding completed')
    expect(messages['frontend-onboarding-completed-subtitle']).toBe('{count} attempts reached setup')
    expect(messages['frontend-onboarding-median-time']).toBe('Median completion time')
    expect(messages['frontend-onboarding-median-time-subtitle']).toBe('Completed attempts only')
    expect(messages['frontend-onboarding-largest-dropoff']).toBe('Largest drop-off')
    expect(messages['frontend-onboarding-daily-attempts']).toBe('Daily onboarding attempts')
    expect(messages['frontend-onboarding-deduplicate-by-user']).toBe('De-duplicate by user')
    expect(messages['frontend-onboarding-deduplicate-by-user-chart']).toBe('De-duplicate by user: {chart}')
    expect(messages['frontend-onboarding-daily-intent-to-details']).toBe('Daily Intent → App details conversion (v1–v4)')
    expect(messages['frontend-onboarding-daily-details-to-organization']).toBe('Daily App details → Organization conversion (v4)')
    expect(messages['frontend-onboarding-daily-organization-to-setup']).toBe('Daily Organization → Setup reached conversion (v4)')
    expect(messages['frontend-onboarding-daily-conversion']).toBe('Conversion')
    expect(messages['frontend-onboarding-daily-conversion-attempts']).toBe('attempts')
    expect(messages['frontend-onboarding-funnel-v2']).toBe('Onboarding funnel (v2)')
    expect(messages['frontend-onboarding-funnel-v4']).toBe('Frontend onboarding funnel (v4)')
    expect(messages['frontend-onboarding-funnel-v1-legacy']).toBe('Onboarding funnel (v1, legacy)')
    expect(messages['frontend-onboarding-graph-v2']).toBe('Onboarding graph (v2)')
    expect(messages['frontend-onboarding-graph-v4']).toBe('Frontend onboarding graph (v4)')
    expect(messages['frontend-onboarding-graph-v4-description']).toBe('Explore behavior inside each onboarding stage')
    expect(messages['frontend-onboarding-setup-cli-outcomes-v2-v3']).toBe('Setup → CLI outcomes (v2 and v3)')
    expect(messages['frontend-onboarding-setup-cli-outcomes-v2-v4']).toBe('Setup → CLI outcomes (v2–v4)')
    expect(messages['frontend-onboarding-setup-cli-outcomes-description']).toBe('Unique people who reached setup, grouped by their CLI and copied AI instruction activity within 24 hours')
    expect(messages['frontend-onboarding-setup-cli-only']).toBe('Started CLI')
    expect(messages['frontend-onboarding-setup-cli-and-ai']).toBe('Started CLI + AI instructions')
    expect(messages['frontend-onboarding-setup-no-cli']).toBe('Didn\'t start CLI')
    expect(messages['frontend-onboarding-people']).toBe('people')
    expect(messages['frontend-onboarding-daily-setup-cli-outcomes-v2-v3']).toBe('Daily Setup → CLI outcomes (v2 and v3)')
    expect(messages['frontend-onboarding-daily-setup-cli-outcomes-v2-v4']).toBe('Daily Setup → CLI outcomes (v2–v4)')
    expect(messages['frontend-onboarding-daily-setup-cli-outcomes-description']).toBe('Each person is counted once per UTC day. Left: first-time Setup views; right: returning views. Actions are attributed for up to 24 hours.')
    expect(messages['frontend-onboarding-daily-setup-cli-first-time']).toBe('First-time')
    expect(messages['frontend-onboarding-daily-setup-cli-returning']).toBe('Returning')
    expect(messages['frontend-onboarding-daily-setup-cli-cli-copy-init']).toBe('CLI copy + init')
    expect(messages['frontend-onboarding-daily-setup-cli-ai-copy-init']).toBe('AI copy + init')
    expect(messages['frontend-onboarding-daily-setup-cli-both-copy-init']).toBe('Both copied + init')
    expect(messages['frontend-onboarding-daily-setup-cli-no-copy-init']).toBe('No copy + init')
    expect(messages['frontend-onboarding-daily-setup-cli-cli-copy-other-cli']).toBe('CLI copy + other CLI')
    expect(messages['frontend-onboarding-daily-setup-cli-ai-copy-other-cli']).toBe('AI copy + other CLI')
    expect(messages['frontend-onboarding-daily-setup-cli-both-copy-other-cli']).toBe('Both copied + other CLI')
    expect(messages['frontend-onboarding-daily-setup-cli-no-copy-other-cli']).toBe('No copy + other CLI')
    expect(messages['frontend-onboarding-daily-setup-cli-cli-copy-no-cli']).toBe('CLI copied · no CLI run')
    expect(messages['frontend-onboarding-daily-setup-cli-ai-copy-no-cli']).toBe('AI copied · no CLI run')
    expect(messages['frontend-onboarding-daily-setup-cli-both-copy-no-cli']).toBe('Both copied · no CLI run')
    expect(messages['frontend-onboarding-daily-setup-cli-no-action']).toBe('No action')
    expect(messages['frontend-onboarding-demo-data']).toBeUndefined()
    expect(messages['frontend-onboarding-graph-stage-app-details']).toBe('App details')
    expect(messages['frontend-onboarding-graph-stage-organization-details']).toBe('Organization details')
    expect(messages['frontend-onboarding-graph-app-name-entered']).toBe('App name entered')
    expect(messages['frontend-onboarding-graph-closed-without-selection']).toBe('Closed without selection')
    expect(messages['frontend-onboarding-graph-organization-import-opened']).toBe('Organization import opened')
    expect(messages['frontend-onboarding-graph-organization-import-submitted']).toBe('Organization import submitted')
    expect(messages['frontend-onboarding-graph-organization-import-succeeded']).toBe('Organization import succeeded')
    expect(messages['frontend-onboarding-graph-organization-import-failed']).toBe('Organization import failed')
    expect(messages['frontend-onboarding-graph-organization-invite-viewed']).toBe('Invitation step viewed')
    expect(messages['frontend-onboarding-graph-organization-invite-opened']).toBe('Invitation opened')
    expect(messages['frontend-onboarding-graph-organization-invite-succeeded']).toBe('Invitation succeeded')
    expect(messages['frontend-onboarding-graph-organization-invite-continued']).toBe('Invitation step continued')
    expect(messages['frontend-onboarding-graph-app-creation-started']).toBe('App creation started')
    expect(messages['frontend-onboarding-graph-app-creation-succeeded']).toBe('App creation succeeded')
    expect(messages['frontend-onboarding-graph-app-creation-failed']).toBe('App creation failed')
    expect(messages['frontend-onboarding-graph-technical-invite-opened']).toBe('Technical invite opened')
    expect(messages['frontend-onboarding-graph-technical-invite-succeeded']).toBe('Technical invite succeeded')
    expect(messages['frontend-onboarding-graph-percent-of-level']).toBe('{percent}% of {level}')
    expect(messages['frontend-onboarding-graph-percent-of-total']).toBe('{percent}% of total')
    expect(messages['frontend-onboarding-graph-percent-of-previous']).toBe('{percent}% of previous')
    expect(messages['frontend-onboarding-graph-percent-of-parent-stage']).toBe('{percent}% of parent stage')
    expect(messages['frontend-onboarding-funnel-description']).toBe('Progress through the new-user app-creation wizard')
    expect(messages['frontend-onboarding-new-users']).toBeUndefined()
    expect(messages['frontend-onboarding-no-dropoff']).toBe('No drop-off')
    expect(messages['frontend-onboarding-transition']).toBe('{from} → {to}')
    expect(messages['frontend-onboarding-load-error']).toBe('Unable to load onboarding analytics. Please try again.')
  })
})
