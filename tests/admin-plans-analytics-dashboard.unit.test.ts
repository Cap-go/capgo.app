import type { PlansAnalyticsResponse as FrontendPlansAnalyticsResponse } from '../src/services/adminPlansAnalytics.ts'
import type { PlansAnalyticsResponse as BackendPlansAnalyticsResponse } from '../supabase/functions/_backend/utils/plans_analytics.ts'
import { readFile } from 'node:fs/promises'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { buildPlansAnalyticsSeries, createLatestRequestCoordinator, parsePlansAnalyticsResponse } from '../src/services/adminPlansAnalytics.ts'

const validResponse: BackendPlansAnalyticsResponse = {
  traffic: { dates: ['2026-08-01'], uniqueVisitorOrganizations: [2], totalOpens: [4] },
  visitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 1, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 2 }],
  checkoutIntent: [{ date: '2026-08-01', startedCheckout: 1, didNotStart: 1 }],
  checkoutVisitorBreakdown: [{ date: '2026-08-01', paying: 1, activeTrial: 0, expiredTrial: 0, canceled: 0, paymentProblem: 0, creditsOnly: 0, unknown: 0, total: 1 }],
  dataQuality: {
    exactTrackingStartedAt: '2026-08-01T00:00:00Z',
    legacyLogicalOpens: 3,
    exactLogicalOpens: 1,
    legacyReconstructionAvailable: true,
    legacyUnavailableReason: null,
    excludedMissingOrganization: 0,
    unmatchedCheckoutStarts: 0,
    unknownBillingOrganizations: 0,
    posthogConfigured: true,
    posthogConnected: true,
    posthogFailureReason: null,
    legacyDeduplicationSeconds: 30,
  },
}

const requiredMessages = {
  'plans-analytics-title': 'Plans analytics',
  'plans-analytics-timezone': 'Reporting timezone: UTC',
  'plans-analytics-traffic': 'Plans page traffic',
  'plans-analytics-traffic-description': 'Organizations and logical openings of the Plans page',
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
  'plans-analytics-checkout-completion-description': 'TODO — this graph will be implemented after reliable checkout-completion tracking is available.',
  'plans-analytics-checkout-completion-link': 'Read the implementation requirements',
  'plans-category-paying': 'Paying',
  'plans-category-active-trial': 'Active trial',
  'plans-category-expired-trial': 'Expired trial — never subscribed',
  'plans-category-canceled': 'Canceled',
  'plans-category-payment-problem': 'Payment problem',
  'plans-category-credits-only': 'Credits only',
  'plans-category-unknown': 'Unknown',
  'plans-analytics-partial-warning': 'Some organizations could not be classified from historical billing records and appear as Unknown.',
  'plans-analytics-legacy-unavailable': 'Legacy Plans visits are unavailable because no event-time pathname could be verified.',
  'plans-analytics-posthog-unconfigured': 'PostHog analytics is not configured.',
  'plans-analytics-posthog-timeout': 'This range took too long to process. Select a shorter period and try again.',
  'plans-analytics-range-too-large': 'This range returned too much data to process. Select a shorter period and try again.',
  'plans-analytics-unavailable': 'Plans analytics is temporarily unavailable.',
  'plans-analytics-empty': 'No Plans visits were recorded in this period.',
} as const

describe('admin Plans analytics dashboard', () => {
  it('keeps the frontend response DTO identical to the backend wire contract', () => {
    expectTypeOf<FrontendPlansAnalyticsResponse>().toMatchTypeOf<BackendPlansAnalyticsResponse>()
    expectTypeOf<BackendPlansAnalyticsResponse>().toMatchTypeOf<FrontendPlansAnalyticsResponse>()
    expectTypeOf<FrontendPlansAnalyticsResponse>().toEqualTypeOf<BackendPlansAnalyticsResponse>()
  })

  it.each([
    ['complete response', validResponse],
    ['nullable quality fields', {
      ...validResponse,
      dataQuality: {
        ...validResponse.dataQuality,
        exactTrackingStartedAt: null,
        legacyReconstructionAvailable: false,
        legacyUnavailableReason: 'missing_event_time_path',
        posthogConnected: false,
        posthogFailureReason: 'timeout',
      },
    }],
    ['empty daily datasets', {
      ...validResponse,
      traffic: { dates: [], uniqueVisitorOrganizations: [], totalOpens: [] },
      visitorBreakdown: [],
      checkoutIntent: [],
      checkoutVisitorBreakdown: [],
    }],
  ])('parses a valid %s', (_name, value) => {
    expect(parsePlansAnalyticsResponse(value)).toEqual(value)
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
    const [tabs, completionDoc, messagesText] = await Promise.all([
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../docs/admin/plans-checkout-completion.md', import.meta.url), 'utf8'),
      readFile(new URL('../messages/en.json', import.meta.url), 'utf8'),
    ])
    expect(tabs).toContain(`label: 'plans-analytics-title'`)
    expect(tabs).toContain(`key: '/plans'`)
    expect(completionDoc).toContain('server-side `Checkout Completed` event')
    expect(completionDoc).toContain('stable `checkout_attempt_id`')
    expect(completionDoc).toContain('Stripe metadata')
    expect(completionDoc).toContain('Stripe checkout session ID, product ID, recurrence, and completion timestamp')
    expect(completionDoc).toContain('attributed Plans-opening UTC day')
    expect(completionDoc).toContain('Completed or Not completed')
    expect(completionDoc).toContain('pending until the agreed observation window')
    expect(completionDoc).toContain('separate approved design')
    expect(JSON.parse(messagesText)).toMatchObject(requiredMessages)

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

    expect(page).toContain('case \'unconfigured\':')
    expect(page).toContain('case \'timeout\':')
    expect(page).toContain('case \'too_large\':')
    expect(page).toContain('case \'unavailable\':')
    expect(page).toContain('t(\'plans-analytics-posthog-unconfigured\')')
    expect(page).toContain('t(\'plans-analytics-posthog-timeout\')')
    expect(page).toContain('t(\'plans-analytics-range-too-large\')')
    expect(page).toContain('t(\'plans-analytics-unavailable\')')
    expect(page).toContain('unknownBillingOrganizations > 0')
    expect(page).toContain('!data.dataQuality.legacyReconstructionAvailable')
    expect(page).toContain('t(\'plans-analytics-partial-warning\')')
    expect(page).toContain('t(\'plans-analytics-legacy-unavailable\')')
    expect(page).toContain('t(\'plans-analytics-empty\')')

    expect(page.match(/<ChartCard/g)).toHaveLength(5)
    expect(page.match(/<AdminMultiLineChart/g)).toHaveLength(1)
    expect(page.match(/<AdminStackedBarChart/g)).toHaveLength(3)
    expect(page.match(/accessible-borders/g)).toHaveLength(3)
    expect(page.match(/<table/g)).toHaveLength(4)
    expect(page.match(/class="sr-only"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(page).toContain('<caption')
    expect(page).toContain('scope="col"')
    expect(page).toContain('scope="row"')
    expect(page).toContain('t(\'plans-analytics-traffic-description\')')
    expect(page).toContain('t(\'plans-analytics-who-opened-description\')')
    expect(page).toContain('t(\'plans-analytics-checkout-intent-description\')')
    expect(page).toContain('t(\'plans-analytics-who-opened-checkout-description\')')

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
    expect(page).toContain('class="space-y-6"')
    expect(page).not.toContain('lg:grid-cols-2')

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

    expect(page).toContain('t(\'plans-analytics-checkout-completion-description\')')
    expect(page).toContain('https://github.com/Cap-go/capgo.app/blob/main/docs/admin/plans-checkout-completion.md')
    expect(page).toContain('target="_blank"')
    expect(page).toContain('rel="noopener noreferrer"')
    expect(page).toContain('role="alert"')
    expect(page).toContain('role="status"')
  })
})
