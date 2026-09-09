import type { PlansAnalyticsResponse as FrontendPlansAnalyticsResponse } from '../src/services/adminPlansAnalytics.ts'
import type { PlansAnalyticsResponse as BackendPlansAnalyticsResponse } from '../supabase/functions/_backend/utils/plans_analytics.ts'
import { readFile } from 'node:fs/promises'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { buildPlansAnalyticsPresentationState, buildPlansAnalyticsSeries, createLatestRequestCoordinator, parsePlansAnalyticsResponse } from '../src/services/adminPlansAnalytics.ts'

const validResponse: BackendPlansAnalyticsResponse = {
  traffic: { dates: ['2026-08-01'], uniqueVisitorOrganizations: [2], totalOpens: [4] },
  visitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 1, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 2 }],
  checkoutIntent: [{ date: '2026-08-01', startedCheckout: 1, didNotStart: 1 }],
  checkoutCompletion: [{ date: '2026-08-01', completed: 1, notCompleted: 0, pending: 0 }],
  checkoutVisitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 0, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 1 }],
  dataQuality: {
    exactTrackingStartedAt: '2026-08-01T00:00:00Z',
    exactLogicalOpens: 1,
    excludedMissingOrganization: 0,
    unmatchedCheckoutStarts: 0,
    unknownBillingOrganizations: 0,
    posthogConfigured: true,
    posthogConnected: true,
    posthogFailureReason: null,
  },
}

const requiredMessages = {
  'plans-analytics-title': 'Plans analytics',
  'plans-analytics-timezone': 'Reporting timezone: UTC',
  'plans-analytics-traffic': 'Plans page traffic',
  'plans-analytics-traffic-description': 'Unique organizations on their first Plans opening in the selected range, alongside total logical openings per UTC day',
  'plans-analytics-unique-visitor-orgs': 'Unique visitor orgs',
  'plans-analytics-total-opens': 'Total opens',
  'plans-analytics-who-opened': 'Who opened Plans?',
  'plans-analytics-who-opened-description': 'Daily unique organizations by billing state at their first Plans opening',
  'plans-analytics-checkout-intent': 'Checkout intent',
  'plans-analytics-checkout-intent-description': 'Daily Plans visitors who started checkout within the attribution window',
  'plans-analytics-started-checkout': 'Started checkout',
  'plans-analytics-did-not-start': 'Did not start',
  'plans-analytics-who-opened-checkout': 'Who opened checkout?',
  'plans-analytics-who-opened-checkout-description': 'Daily checkout starters by billing state at the attributed Plans opening',
  'plans-analytics-checkout-completion': 'Checkout completion',
  'plans-analytics-checkout-completion-description': 'Daily checkout starters attributed to each Plans-opening UTC day, counted once as completed (paid or upgraded), not completed, or still pending within the 24-hour observation window',
  'plans-analytics-completed-checkout': 'Completed checkout',
  'plans-analytics-not-completed': 'Not completed',
  'plans-analytics-pending-completion': 'Pending',
  'plans-category-paying': 'Paying',
  'plans-category-active-trial': 'Active trial',
  'plans-category-expired-trial': 'Expired trial — never subscribed',
  'plans-category-canceled': 'Canceled',
  'plans-category-payment-problem': 'Payment problem',
  'plans-category-credits-only': 'Credits only',
  'plans-category-unknown': 'Unknown',
  'plans-analytics-partial-warning': 'Some organizations could not be classified from historical billing records and appear as Unknown.',
  'plans-analytics-posthog-unconfigured': 'PostHog analytics is not configured.',
  'plans-analytics-posthog-timeout': 'Plans analytics timed out. Try again, or select a shorter period.',
  'plans-analytics-range-too-large': 'This range returned too much data to process. Select a shorter period and try again.',
  'plans-analytics-unavailable': 'Plans analytics is temporarily unavailable.',
  'plans-analytics-empty': 'No Plans visits were recorded in this period.',
} as const

describe('admin Plans analytics dashboard', () => {
  it('keeps the frontend response DTO identical to the backend wire contract', () => {
    expectTypeOf<FrontendPlansAnalyticsResponse>().toEqualTypeOf<BackendPlansAnalyticsResponse>()
  })

  it.each([
    ['complete response', validResponse],
    ['nullable quality fields', {
      ...validResponse,
      dataQuality: {
        ...validResponse.dataQuality,
        exactTrackingStartedAt: null,
        posthogConnected: false,
        posthogFailureReason: 'timeout',
      },
    }],
    ['empty daily datasets', {
      ...validResponse,
      traffic: { dates: [], uniqueVisitorOrganizations: [], totalOpens: [] },
      visitorBreakdown: [],
      checkoutIntent: [],
      checkoutCompletion: [],
      checkoutVisitorBreakdown: [],
    }],
  ])('parses a valid %s', (_name, value) => {
    expect(parsePlansAnalyticsResponse(value)).toEqual(value)
  })

  it('ignores obsolete legacy data-quality fields from an older backend response', () => {
    const compatibilityResponse = {
      ...validResponse,
      dataQuality: {
        ...validResponse.dataQuality,
        legacyLogicalOpens: 3,
        legacyReconstructionAvailable: false,
        legacyUnavailableReason: 'missing_event_time_path',
        legacyDeduplicationSeconds: 30,
      },
    }

    expect(parsePlansAnalyticsResponse(compatibilityResponse).dataQuality).toEqual(validResponse.dataQuality)
  })

  it.each([
    ['non-object response', null],
    ['missing required fields', { traffic: validResponse.traffic }],
    ['invalid failure reason', {
      ...validResponse,
      dataQuality: { ...validResponse.dataQuality, posthogFailureReason: 'rate_limited' },
    }],
    ['non-finite count', {
      ...validResponse,
      traffic: { ...validResponse.traffic, totalOpens: [Number.POSITIVE_INFINITY] },
    }],
    ['mismatched traffic arrays', {
      ...validResponse,
      traffic: { ...validResponse.traffic, dates: ['2026-08-01', '2026-08-02'] },
    }],
    ['invalid daily date', {
      ...validResponse,
      checkoutIntent: [{ date: '2026-02-30', startedCheckout: 1, didNotStart: 1 }],
    }],
    ['invalid daily count', {
      ...validResponse,
      visitorBreakdown: [{ ...validResponse.visitorBreakdown[0], paying: '1' }],
    }],
    ['invalid quality boolean', {
      ...validResponse,
      dataQuality: { ...validResponse.dataQuality, posthogConfigured: 1 },
    }],
    ['invalid tracking timestamp', {
      ...validResponse,
      dataQuality: { ...validResponse.dataQuality, exactTrackingStartedAt: 'not-a-timestamp' },
    }],
  ])('rejects a malformed response with %s', (_name, value) => {
    expect(() => parsePlansAnalyticsResponse(value)).toThrowError('Invalid Plans analytics response')
  })

  it.each([
    ['unconfigured', 'plans-analytics-posthog-unconfigured'],
    ['timeout', 'plans-analytics-posthog-timeout'],
    ['too_large', 'plans-analytics-range-too-large'],
    ['unavailable', 'plans-analytics-unavailable'],
  ] as const)('maps the %s backend failure to its visible message', (failureReason, expected) => {
    const state = buildPlansAnalyticsPresentationState({
      ...validResponse,
      dataQuality: { ...validResponse.dataQuality, posthogFailureReason: failureReason },
    }, null, key => key)

    expect(state.unavailableMessage).toBe(expected)
  })

  it('distinguishes valid empty data with partial billing', () => {
    const state = buildPlansAnalyticsPresentationState({
      ...validResponse,
      traffic: { dates: [], uniqueVisitorOrganizations: [], totalOpens: [] },
      visitorBreakdown: [],
      checkoutIntent: [],
      checkoutCompletion: [],
      checkoutVisitorBreakdown: [],
      dataQuality: {
        ...validResponse.dataQuality,
        unknownBillingOrganizations: 2,
      },
    }, null, key => key)

    expect(state).toMatchObject({
      unavailableMessage: null,
      hasTraffic: false,
      hasVisitors: false,
      hasCheckoutIntent: false,
      hasCheckoutCompletion: false,
      hasCheckoutVisitors: false,
      showPartialBillingWarning: true,
    })
    expect(state).not.toHaveProperty('showLegacyUnavailableWarning')
  })

  it('gives a request failure precedence over backend presentation state', () => {
    const state = buildPlansAnalyticsPresentationState(validResponse, 'request failed', key => key)

    expect(state.unavailableMessage).toBe('request failed')
  })

  it.concurrent('maps all API datasets into stable chart series', () => {
    const series = buildPlansAnalyticsSeries({
      ...validResponse,
      traffic: {
        dates: ['2026-08-01', '2026-08-02'],
        uniqueVisitorOrganizations: [2],
        totalOpens: [4, 3, 99],
      },
    }, key => key)

    expect(series.traffic).toEqual([
      {
        label: 'plans-analytics-unique-visitor-orgs',
        color: '#2563eb',
        data: [{ date: '2026-08-01', value: 2 }, { date: '2026-08-02', value: 0 }],
      },
      {
        label: 'plans-analytics-total-opens',
        color: '#8b5cf6',
        data: [{ date: '2026-08-01', value: 4 }, { date: '2026-08-02', value: 3 }],
      },
    ])
    expect(series.visitors.map(({ label, color }) => ({ label, color }))).toEqual([
      { label: 'plans-category-paying', color: '#2563eb' },
      { label: 'plans-category-active-trial', color: '#10b981' },
      { label: 'plans-category-expired-trial', color: '#f59e0b' },
      { label: 'plans-category-canceled', color: '#64748b' },
      { label: 'plans-category-payment-problem', color: '#ef4444' },
      { label: 'plans-category-credits-only', color: '#8b5cf6' },
      { label: 'plans-category-unknown', color: '#94a3b8' },
    ])
    expect(series.visitors.every(item => item.data[0]?.date === '2026-08-01')).toBe(true)
    expect(series.checkoutIntent.map(({ label, color, data }) => ({ label, color, data }))).toEqual([
      { label: 'plans-analytics-started-checkout', color: '#10b981', data: [{ date: '2026-08-01', value: 1 }] },
      { label: 'plans-analytics-did-not-start', color: '#94a3b8', data: [{ date: '2026-08-01', value: 1 }] },
    ])
    expect(series.checkoutCompletion.map(({ label, color, data }) => ({ label, color, data }))).toEqual([
      { label: 'plans-analytics-completed-checkout', color: '#2563eb', data: [{ date: '2026-08-01', value: 1 }] },
      { label: 'plans-analytics-not-completed', color: '#94a3b8', data: [{ date: '2026-08-01', value: 0 }] },
      { label: 'plans-analytics-pending-completion', color: '#f59e0b', data: [{ date: '2026-08-01', value: 0 }] },
    ])
    expect(series.checkoutVisitors).toHaveLength(7)
    expect(series.checkoutVisitors.reduce((sum, item) => sum + item.data[0].value, 0)).toBe(1)
  })

  it.concurrent('coordinates overlapping requests with latest-wins and pending-count semantics', () => {
    const coordinator = createLatestRequestCoordinator()
    const olderRequest = coordinator.begin()
    const latestRequest = coordinator.begin()

    expect(coordinator.pendingCount).toBe(2)
    expect(coordinator.isLatest(olderRequest)).toBe(false)
    expect(coordinator.isLatest(latestRequest)).toBe(true)

    coordinator.finish(latestRequest)
    expect(coordinator.pendingCount).toBe(1)
    expect(coordinator.isLatest(olderRequest)).toBe(false)

    coordinator.finish(olderRequest)
    expect(coordinator.pendingCount).toBe(0)
  })

  it.concurrent('wires a full-width Plans page and deferred documentation', async () => {
    const [tabs, completionDoc, messagesText, messageContextsText, historicalDesign, historicalPlan] = await Promise.all([
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../docs/admin/plans-checkout-completion.md', import.meta.url), 'utf8'),
      readFile(new URL('../messages/en.json', import.meta.url), 'utf8'),
      readFile(new URL('../messages/en.context.json', import.meta.url), 'utf8'),
      readFile(new URL('../docs/superpowers/specs/2026-08-10-plans-analytics-dashboard-design.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/superpowers/plans/2026-08-10-plans-analytics-dashboard.md', import.meta.url), 'utf8'),
    ])
    expect(tabs).toContain(`label: 'plans-analytics-title'`)
    expect(tabs).toContain(`key: '/plans'`)
    expect(completionDoc).toContain('server-side billing evidence')
    expect(completionDoc).toContain('attributed Plans-opening UTC day')
    expect(completionDoc).toContain('observation window')
    expect(completionDoc).toContain('paid transition')
    const messages = JSON.parse(messagesText) as Record<string, unknown>
    for (const [key, expected] of Object.entries(requiredMessages)) {
      expect(messages).toHaveProperty(key)
      expect(messages[key]).toEqual(expect.any(String))
      expect(messages[key]).toBe(expected)
    }
    const messageContexts = JSON.parse(messageContextsText) as Record<string, unknown>
    expect(messages).not.toHaveProperty('plans-analytics-legacy-unavailable')
    expect(messageContexts).not.toHaveProperty('plans-analytics-legacy-unavailable')
    expect(historicalDesign).toContain('Exact event tracking is the sole source of Plans openings.')
    expect(historicalPlan).toContain('Superseded: legacy pathname reconstruction is not part of the shipped analytics model.')
    expect(historicalPlan).not.toContain('legacyReconstructionAvailable = true')
    expect(historicalPlan).not.toContain('legacyUnavailableReason = \'missing_event_time_path\'')
    expect(historicalPlan).not.toContain('Validate the 30-second legacy burst threshold')
    expect(messages['plans-analytics-posthog-timeout']).not.toBe(messages['plans-analytics-range-too-large'])

    const page = await readFile(new URL('../src/pages/admin/dashboard/plans.vue', import.meta.url), 'utf8')
    expect(page).toContain('layout: admin')
    expect(page).toContain('if (!mainStore.isAdmin)')
    expect(page).toContain('router.push(\'/dashboard\')')
    expect(page).toContain('<AdminFilterBar />')
    expect(page).toContain(`fetchStats('plans_analytics')`)
    expect(page).toContain('parsePlansAnalyticsResponse(response)')
    expect(page).not.toContain('as PlansAnalyticsResponse')
    expect(page).toContain('const data = ref<PlansAnalyticsResponse | null>(null)')
    expect(page).toContain('const isInitialLoading = ref(true)')
    expect(page).toContain('const isLoadingStats = ref(false)')
    expect(page).toContain('const requestError = ref<string | null>(null)')

    expect(page).toContain('buildPlansAnalyticsPresentationState(data.value, requestError.value, t)')
    expect(page).toContain('t(\'plans-analytics-partial-warning\')')
    expect(page).not.toContain('plans-analytics-legacy-unavailable')
    expect(page).not.toContain('showLegacyUnavailableWarning')
    expect(page).toContain('t(\'plans-analytics-empty\')')

    expect(page.match(/<ChartCard/g)).toHaveLength(5)
    expect(page.match(/<AdminMultiLineChart/g)).toHaveLength(1)
    expect(page.match(/<AdminStackedBarChart/g)).toHaveLength(4)
    expect(page.match(/accessible-borders/g)).toHaveLength(4)
    expect(page.match(/<table/g)).toHaveLength(5)
    expect(page.match(/class="sr-only"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(page).toContain('<caption')
    expect(page).toContain('scope="col"')
    expect(page).toContain('scope="row"')
    expect(page).toContain('t(\'plans-analytics-traffic-description\')')
    expect(page).toContain('t(\'plans-analytics-who-opened-description\')')
    expect(page).toContain('t(\'plans-analytics-checkout-intent-description\')')
    expect(page).toContain('t(\'plans-analytics-who-opened-checkout-description\')')
    expect(page).toContain('t(\'plans-analytics-checkout-completion-description\')')
    expect(page).toContain('hasCheckoutCompletion')
    expect(page).toContain(':series="series.checkoutCompletion"')

    const cardTitles = [
      'plans-analytics-traffic',
      'plans-analytics-who-opened',
      'plans-analytics-checkout-intent',
      'plans-analytics-who-opened-checkout',
      'plans-analytics-checkout-completion',
    ]
    const titlePositions = cardTitles.map(key => page.indexOf(`t('${key}')`))
    expect(titlePositions.every(position => position >= 0)).toBe(true)
    expect(titlePositions).toEqual([...titlePositions].sort((a, b) => a - b))
    expect(page).toContain('t(\'plans-analytics-timezone\')')
    expect(page.match(/watch\(/g)).toHaveLength(1)
    expect(page).toContain('watch([')
    expect(page).toContain('() => adminStore.activeDateRange')
    expect(page).toContain('() => adminStore.refreshTrigger')
    expect(page).toContain('{ deep: true }')
    expect(page).toContain('const authorized = ref(false)')
    expect(page).toContain('if (!authorized.value)')
    expect(page).toContain('authorized.value = true')
    expect(page.indexOf('authorized.value = true')).toBeGreaterThan(page.indexOf('if (!mainStore.isAdmin)'))
    expect(page).toContain('createLatestRequestCoordinator()')
    expect(page).toContain('requestCoordinator.begin()')
    expect(page.match(/if \(requestCoordinator\.isLatest\(requestId\)\)/g)).toHaveLength(2)
    expect(page).toContain('requestCoordinator.finish(requestId)')
    expect(page).toContain('requestCoordinator.pendingCount > 0')
    expect(page).not.toContain('setInterval')
    expect(page).not.toContain('setTimeout')

    expect(page).not.toContain('https://github.com/Cap-go/capgo.app/blob/main/docs/admin/plans-checkout-completion.md')
    expect(page).not.toContain('plans-analytics-checkout-completion-link')
    expect(page).toContain('role="alert"')
    expect(page).toContain('role="status"')
  })
})
