import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAdminOnboardingPaymentCohorts } from '../supabase/functions/_backend/utils/onboarding_payment_cohorts.ts'
import { aggregateOnboardingPaymentCohorts, onboardingPaymentCohortPeriod } from '../supabase/functions/_backend/utils/onboarding_payment_cohorts_model.ts'

const { dataMock, posthogMock } = vi.hoisted(() => ({ dataMock: vi.fn(), posthogMock: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/onboarding_payment_cohorts_data.ts', () => ({ loadOnboardingPaymentCohortData: dataMock }))
vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({ queryPosthogHogql: posthogMock }))

const cutoff = new Date('2026-09-16T00:00:00Z')
const period = { cutoff: cutoff.toISOString(), start: '2026-06-01T00:00:00.000Z' }
const user = (id = 'user-a', signup_at = '2026-09-01T00:00:00.000Z') => ({ id, signup_at, has_public_row: true, created_via_invite: false })
const org = (id = 'org-a', created_by = 'user-a', customer_id: string | null = 'cus_fake') => ({ id, created_by, customer_id })
const grant = (id = 'grant-a', granted_at = '2026-09-02T00:00:00.000Z') => ({ id, org_id: 'org-a', granted_at, credits_total: 10, source: 'stripe_top_up', payment_intent_id: 'pi_fake' })
const invoice = (paid_at = '2026-09-02T00:00:00.000Z') => ({ customer_id: 'cus_fake', paid_at })
const run = (data: Record<string, unknown> = {}) => aggregateOnboardingPaymentCohorts({ ...period, users: [user()], orgs: [org()], grants: [], subscription_payments: [], credit_payments: [], ...data })
const source = (rows: Record<string, unknown>[] = []) => ({ configured: true, connected: true, failureReason: null, rows })
const invoiceRow = (paid_at = '2026-09-02T00:00:00Z', extra = {}) => ({ customer_id: 'cus_fake', paid_at_seconds: Date.parse(paid_at) / 1000, total_rows: 1, ...extra })

beforeEach(() => {
  dataMock.mockReset().mockResolvedValue({ users: [user()], orgs: [org()], grants: [] })
  posthogMock.mockReset().mockResolvedValue(source())
})

describe('uTC payment cohort model', () => {
  it.each([
    ['2027-01-01T23:59:59Z', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['2024-03-01T00:00:01Z', '2023-12-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
    ['2024-02-29T19:30:00-04:00', '2023-11-01T00:00:00.000Z', '2024-02-29T00:00:00.000Z'],
  ])('uses UTC year/leap rollover for %s', (now, start, end) => {
    expect(onboardingPaymentCohortPeriod(new Date(now))).toEqual({ start, cutoff: end })
  })

  it('returns exactly four newest-first empty months and null zero-eligible percentages', () => {
    const report = run({ users: [], orgs: [] })
    expect(report.rows.map(row => row.month)).toEqual(['2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01'])
    expect(report.rows.every(row => row.signups === 0 && row.ever.conversion_percent === null)).toBe(true)
  })

  it('uses auth signup clocks and nonoverlapping missing-profile-before-invite exclusions', () => {
    const report = run({ users: [user(), user(), { ...user('missing'), has_public_row: false, created_via_invite: true }, { ...user('invited'), created_via_invite: true }, { ...user('auth-june', '2026-06-30T23:59:59.000Z'), profile_created_at: '2026-09-01T00:00:00Z' }] })
    expect(report.rows[0]).toMatchObject({ signups: 1, excluded_no_public_row: 1, excluded_invite: 1 })
    expect(report.rows[3].signups).toBe(1)
  })

  it.each([3, 7, 14] as const)('excludes payments exactly on the %s-day endpoint', (days) => {
    const signup = '2026-08-01T00:00:00.000Z'
    const paidAt = new Date(Date.parse(signup) + days * 86400000).toISOString()
    expect(run({ users: [user('user-a', signup)], subscription_payments: [invoice(paidAt)] }).rows[1][`days_${days}`]).toEqual({ paid: 0, eligible: 1, conversion_percent: 0 })
    const earlier = new Date(Date.parse(paidAt) - 1).toISOString()
    expect(run({ users: [user('user-a', signup)], subscription_payments: [invoice(earlier)] }).rows[1][`days_${days}`].paid).toBe(1)
  })

  it('excludes immature payers from both fixed-window counts but includes ever', () => {
    const row = run({ users: [user('user-a', '2026-09-12T00:00:00.000Z')], subscription_payments: [invoice('2026-09-13T00:00:00.000Z')] }).rows[0]
    expect(row.days_3).toEqual({ paid: 1, eligible: 1, conversion_percent: 100 })
    expect(row.days_7).toEqual({ paid: 0, eligible: 0, conversion_percent: null })
    expect(row.days_14).toEqual({ paid: 0, eligible: 0, conversion_percent: null })
    expect(row.ever.paid).toBe(1)
  })

  it('includes signup maturity exactly at cutoff and payment exactly at signup', () => {
    const row = run({ users: [user('user-a', '2026-09-13T00:00:00.000Z')], subscription_payments: [invoice('2026-09-13T00:00:00.000Z')] }).rows[0]
    expect(row.days_3).toEqual({ paid: 1, eligible: 1, conversion_percent: 100 })
  })

  it('attributes only org creators and deduplicates both sources across multiple owned orgs', () => {
    const row = run({ users: [user(), user('member-only')], orgs: [org(), org('org-b', 'user-a', 'cus_other')], grants: [grant()], subscription_payments: [invoice(), { customer_id: 'cus_other', paid_at: '2026-09-03T00:00:00.000Z' }] }).rows[0]
    expect(row.ever).toEqual({ paid: 1, eligible: 2, conversion_percent: 50 })
  })

  it('does not let a pre-signup payment mask a later qualifying invoice', () => {
    expect(run({ subscription_payments: [invoice('2026-08-31T23:59:59.000Z'), invoice()] }).rows[0].ever.paid).toBe(1)
  })

  it('applies the signup threshold before selecting among exact credit invoice candidates', () => {
    const report = run({ grants: [grant()], credit_payments: [{ payment_intent_id: 'pi_fake', paid_at: '2026-08-31T00:00:00.000Z' }, { payment_intent_id: 'pi_fake', paid_at: '2026-09-02T00:00:00.000Z' }] })
    expect(report.rows[0].ever.paid).toBe(1)
    expect(report.credit_timestamp_fallbacks).toBe(0)
  })

  it('ignores pre-signup, cutoff and future payments plus out-of-period signups', () => {
    expect(run({ users: [user(), user('old', '2026-05-31T23:59:59.000Z'), user('today', cutoff.toISOString())], subscription_payments: [invoice('2026-08-31T23:59:59.000Z'), invoice(cutoff.toISOString()), invoice('2026-10-01T00:00:00.000Z')] }).rows[0].ever.paid).toBe(0)
  })

  it('excludes manual and free credit grants', () => {
    expect(run({ grants: [{ ...grant(), source: 'manual' }, { ...grant('free'), credits_total: 0 }] }).rows[0].ever.paid).toBe(0)
  })

  it('prefers matching paid invoice timestamp and counts only individual confirmed fallbacks', () => {
    const exact = run({ grants: [grant('exact', '2026-09-10T00:00:00.000Z')], credit_payments: [{ payment_intent_id: 'pi_fake', paid_at: '2026-09-02T00:00:00.000Z' }] })
    expect(exact.rows[0].days_3.paid).toBe(1)
    expect(exact.credit_timestamp_fallbacks).toBe(0)
    const fallback = run({ grants: [grant(), { ...grant('no-intent'), payment_intent_id: null }] })
    expect(fallback.rows[0].ever.paid).toBe(1)
    expect(fallback.credit_timestamp_fallbacks).toBe(2)
  })

  it('uses pre-cutoff invoice payment even if grant confirmation arrives on cutoff day', () => {
    const report = run({ grants: [grant('delayed', '2026-09-16T00:00:01.000Z')], credit_payments: [{ payment_intent_id: 'pi_fake', paid_at: '2026-09-15T23:59:59.000Z' }] })
    expect(report.rows[0].ever.paid).toBe(1)
    expect(report.credit_timestamp_fallbacks).toBe(0)
    expect(run({ grants: [grant('today', '2026-09-16T00:00:01.000Z')] }).rows[0].ever.paid).toBe(0)
  })

  it.each(['not-a-date', '2026-02-30T00:00:00.000Z', '2026-09-01', '2026-09-01T00:00:00'])('rejects malformed essential timestamps %s', (signup_at) => {
    expect(() => run({ users: [user('user-a', signup_at)] })).toThrow(/timestamp/i)
  })
})

describe('bounded PostHog payment report', () => {
  it('runs real aggregation with actual invoice candidates and no raw identities in DTO', async () => {
    posthogMock.mockResolvedValueOnce(source([invoiceRow('2026-08-31T00:00:00Z', { total_rows: 2 }), invoiceRow('2026-09-02T00:00:00Z', { total_rows: 2 })]))
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(report.rows[0].days_3.paid).toBe(1)
    expect(JSON.stringify(report)).not.toContain('cus_fake')
    const query = posthogMock.mock.calls[0][1]
    expect(query).toContain('JSONExtractInt(status_transitions, \'paid_at\')')
    expect(query).toContain('subscription_id')
    expect(query).toContain('amount_paid > 0')
    expect(query).toContain('livemode')
    expect(query).toContain('GROUP BY customer_id, paid_at_seconds')
    expect(query).toContain('count() OVER () AS total_rows')
    expect(query).toContain('LIMIT 50000')
    expect(query).not.toContain('stripe_info')
    expect(query).not.toContain('min(')
  })

  it('uses exact payment_intent schema column for credits', async () => {
    dataMock.mockResolvedValue({ users: [user()], orgs: [org()], grants: [grant()] })
    posthogMock.mockImplementation(async (_c, query: string) => query.includes('GROUP BY payment_intent') ? source([{ payment_intent_id: 'pi_fake', paid_at_seconds: Date.parse('2026-09-02T00:00:00Z') / 1000, total_rows: 1 }]) : source())
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(report.rows[0].ever.paid).toBe(1)
    expect(report.credit_timestamp_fallbacks).toBe(0)
    expect(posthogMock.mock.calls.find(call => call[1].includes('GROUP BY payment_intent'))?.[1]).toContain('payment_intent AS payment_intent_id')
  })

  it.each(['2026-09-17T00:00:00Z', '2026-05-31T23:59:59Z'])('never substitutes an in-window credit grant for an available out-of-window exact invoice %s', async (paidAt) => {
    dataMock.mockResolvedValue({ users: [user()], orgs: [org()], grants: [grant()] })
    posthogMock.mockImplementation(async (_c, query: string) => {
      if (!query.includes('GROUP BY payment_intent'))
        return source()
      // The warehouse returns the known exact invoice only if date filters do not hide it.
      if (query.includes('parseDateTimeBestEffort'))
        return source()
      return source([{ payment_intent_id: 'pi_fake', paid_at_seconds: Date.parse(paidAt) / 1000, total_rows: 1 }])
    })
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(report.rows[0].ever.paid).toBe(0)
    expect(report.credit_timestamp_fallbacks).toBe(0)
    const creditQuery = posthogMock.mock.calls.find(call => call[1].includes('GROUP BY payment_intent'))?.[1]
    expect(creditQuery).toContain('payment_intent IN (\'pi_fake\')')
    expect(creditQuery).toContain('LIMIT 50000')
    expect(creditQuery).not.toContain('parseDateTimeBestEffort')
    expect(posthogMock.mock.calls[0][1]).toContain('parseDateTimeBestEffort')
  })

  it.each(['unconfigured', 'unavailable', 'timeout', 'too_large'])('rejects global invoice source failure %s', async (failureReason) => {
    posthogMock.mockResolvedValue(source()).mockResolvedValueOnce({ configured: true, connected: false, failureReason, rows: [] })
    await expect(getAdminOnboardingPaymentCohorts({} as Context, cutoff)).rejects.toThrow(/invoice source/i)
  })

  it('rejects global credit lookup failures instead of using fallbacks for everyone', async () => {
    dataMock.mockResolvedValue({ users: [user()], orgs: [org()], grants: [grant()] })
    posthogMock.mockResolvedValueOnce(source()).mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'unavailable', rows: [] })
    await expect(getAdminOnboardingPaymentCohorts({} as Context, cutoff)).rejects.toThrow(/invoice source/i)
  })

  it.each([{ total_rows: 2 }, { total_rows: undefined }, { total_rows: 'bad' }, { paid_at_seconds: 0 }, { customer_id: null }])('rejects incomplete or malformed invoice source rows %j', async (extra) => {
    posthogMock.mockResolvedValueOnce(source([invoiceRow(undefined, extra)]))
    await expect(getAdminOnboardingPaymentCohorts({} as Context, cutoff)).rejects.toThrow()
  })

  it('escapes warehouse scopes and batches large customer sets without dropping candidates', async () => {
    const orgs = Array.from({ length: 501 }, (_, index) => org(`org-${index}`, 'user-a', index === 0 ? 'cus_\'\\fake' : `cus_${index}`))
    dataMock.mockResolvedValue({ users: [user()], orgs, grants: [] })
    await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    const subscriptionQueries = posthogMock.mock.calls.map(call => call[1]).filter(query => query.includes('GROUP BY customer_id'))
    expect(subscriptionQueries).toHaveLength(2)
    expect(subscriptionQueries[0]).toContain('cus_\\\'\\\\fake')
    expect(subscriptionQueries[1]).toContain('cus_500')
  })

  it('bounds warehouse batch concurrency and passes a shared abort deadline with strict columns', async () => {
    const orgs = Array.from({ length: 2501 }, (_, index) => org(`org-${index}`, 'user-a', `cus_${index}`))
    dataMock.mockResolvedValue({ users: [user()], orgs, grants: [] })
    let active = 0
    let peak = 0
    posthogMock.mockImplementation(async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return source()
    })
    await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(peak).toBe(4)
    const queries = posthogMock.mock.calls.filter(call => call[1].includes('GROUP BY customer_id'))
    expect(queries).toHaveLength(6)
    expect(queries[0][2]).toMatchObject({ requiredColumns: ['customer_id', 'paid_at_seconds', 'total_rows'], signal: expect.any(AbortSignal) })
    expect(queries.every(call => call[2].signal === queries[0][2].signal)).toBe(true)
  })

  it.each(['subscription', 'credit'] as const)('queries every %s scope exactly once despite out-of-order batch completions', async (kind) => {
    const size = 2501
    const orgs = Array.from({ length: size }, (_, index) => org(`org-${index}`, 'user-a', `cus_fake_${index}`))
    const grants = kind === 'credit'
      ? orgs.map((ownedOrg, index) => ({ ...grant(`grant-${index}`), org_id: ownedOrg.id, payment_intent_id: `pi_fake_${index}` }))
      : []
    dataMock.mockResolvedValue({ users: [user()], orgs, grants })
    const column = kind === 'subscription' ? 'customer_id' : 'payment_intent'
    const resultColumn = kind === 'subscription' ? 'customer_id' : 'payment_intent_id'
    const requested: string[] = []
    let active = 0
    let peak = 0
    posthogMock.mockImplementation(async (_c, query: string) => {
      if (!query.includes(`GROUP BY ${column},`))
        return source()
      const scopeText = query.match(new RegExp(`${column} IN \\(([^)]+)\\)`))?.[1] ?? ''
      const scope = Array.from(scopeText.matchAll(/'([^']+)'/g), match => match[1])
      requested.push(...scope)
      peak = Math.max(peak, ++active)
      // Later batches can finish before the first worker resumes.
      await new Promise(resolve => setTimeout(resolve, scope[0].endsWith('_0') ? 10 : 1))
      active--
      return source(scope.map(id => ({
        [resultColumn]: id,
        paid_at_seconds: Date.parse('2026-09-02T00:00:00Z') / 1000,
        total_rows: scope.length,
      })))
    })
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    const expected = Array.from({ length: size }, (_, index) => `${kind === 'subscription' ? 'cus' : 'pi'}_fake_${index}`)
    expect(requested).toHaveLength(size)
    expect(new Set(requested).size).toBe(size)
    expect([...requested].sort()).toEqual(expected.sort())
    expect(peak).toBe(4)
    expect(report.rows[0].ever.paid).toBe(1)
    expect(report.credit_timestamp_fallbacks).toBe(0)
  })

  it('cancels sibling warehouse requests when any authoritative batch fails', async () => {
    dataMock.mockResolvedValue({ users: [user()], orgs: Array.from({ length: 2501 }, (_, index) => org(`org-${index}`, 'user-a', `cus_${index}`)), grants: [] })
    let calls = 0
    posthogMock.mockImplementation(async (_c, _query, options) => {
      if (calls++ === 0)
        return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ configured: true, connected: false, failureReason: 'timeout', rows: [] }), { once: true }))
    })
    await expect(getAdminOnboardingPaymentCohorts({} as Context, cutoff)).rejects.toThrow(/invoice source/i)
    expect(calls).toBe(4)
    expect(posthogMock.mock.calls.every(call => call[2].signal.aborted)).toBe(true)
  })

  it('treats optional freshness failure as unavailable, not as payment failure', async () => {
    posthogMock.mockResolvedValueOnce(source([invoiceRow()])).mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'unavailable', rows: [] })
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(report.rows[0].ever.paid).toBe(1)
    expect(report.invoice_last_synced_at).toBeNull()
  })

  it('exposes verified source sync timestamp and append sync mode without claiming complete freshness', async () => {
    posthogMock.mockResolvedValueOnce(source()).mockResolvedValueOnce(source([{ status: 'Completed', last_synced_at: '2026-09-16T08:51:05.349442Z', sync_type: 'append' }]))
    const report = await getAdminOnboardingPaymentCohorts({} as Context, cutoff)
    expect(report.invoice_last_synced_at).toBe('2026-09-16T08:51:05.349Z')
    expect(report.invoice_sync_type).toBe('append')
  })
})
