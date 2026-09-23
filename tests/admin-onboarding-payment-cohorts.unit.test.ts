// @vitest-environment happy-dom

import type { App } from 'vue'
import type { OnboardingPaymentCohortReport } from '../src/services/adminOnboardingPaymentCohorts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import AdminOnboardingPaymentCohorts from '../src/components/admin/AdminOnboardingPaymentCohorts.vue'
import * as paymentService from '../src/services/adminOnboardingPaymentCohorts'

const mocks = vi.hoisted(() => ({ fetchStats: vi.fn(), locale: 'en-GB' }))
let admin: { refreshTrigger: number, activeDateRange: string, selectedAppId: string | null, selectedOrgId: string | null }
let main: { isAdmin: boolean, authGeneration: number, user: { id: string } | undefined }
vi.mock('~/stores/adminDashboard', () => ({
  useAdminDashboardStore: () => ({
    ...admin,
    get refreshTrigger() {
      return admin.refreshTrigger
    },
    fetchStats: mocks.fetchStats,
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => main }))
vi.mock('~/services/formatLocale', () => ({
  getFormatLocale: () => mocks.locale,
  formatNumberValue: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(mocks.locale, options).format(value),
}))

const apps: App[] = []

function fixture(): OnboardingPaymentCohortReport {
  const cell = { paid: 1, eligible: 3, conversion_percent: 100 / 3 }
  return {
    start: '2026-06-01T00:00:00.000Z',
    cutoff: '2026-09-16T00:00:00.000Z',
    rows: ['2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01'].map((month, index) => ({
      month,
      signups: index === 0 ? 1234 : 3,
      excluded_no_public_row: 2,
      excluded_invite: 4,
      days_3: { ...cell },
      days_7: { ...cell },
      days_14: { ...cell },
      ever: { paid: 1, eligible: index === 0 ? 1234 : 3, conversion_percent: 100 / (index === 0 ? 1234 : 3) },
    })),
    credit_timestamp_fallbacks: 2,
    invoice_last_synced_at: '2026-09-15T23:10:00.000Z',
    invoice_sync_type: 'append',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function service() {
  return paymentService
}

async function mount() {
  const app = createApp(AdminOnboardingPaymentCohorts)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  const container = document.createElement('div')
  app.mount(container)
  apps.push(app)
  return { app, container }
}

function alteredFixture(change: (value: OnboardingPaymentCohortReport) => void) {
  const value = fixture()
  change(value)
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T12:00:00Z'))
  mocks.locale = 'en-GB'
  mocks.fetchStats.mockReset().mockImplementation(async () => fixture())
  admin = reactive({ refreshTrigger: 0, activeDateRange: 'fake-chart-range', selectedAppId: null, selectedOrgId: null })
  main = reactive({ isAdmin: true, authGeneration: 1, user: { id: 'fake-admin' } })
})

afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('payment cohort response contract', () => {
  it('derives the rolling period across a UTC year boundary', async () => {
    const { getOnboardingPaymentCohortPeriod } = await service()
    expect(getOnboardingPaymentCohortPeriod(new Date('2027-01-01T23:59:59Z'))).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      cutoff: '2027-01-01T00:00:00.000Z',
    })
  })

  it('validates a complete newest-first rolling four-month report', async () => {
    const { validateOnboardingPaymentCohortReport } = await service()
    expect(validateOnboardingPaymentCohortReport(fixture())).toEqual(fixture())
  })

  it.each([
    ['missing report', () => null],
    ['missing count', () => alteredFixture(value => delete (value.rows[0] as Partial<typeof value.rows[0]>).signups)],
    ['negative count', () => alteredFixture(value => value.rows[0].excluded_invite = -1)],
    ['fractional count', () => alteredFixture(value => value.rows[0].days_3.paid = 0.5)],
    ['unsafe count', () => alteredFixture(value => value.credit_timestamp_fallbacks = Number.MAX_SAFE_INTEGER + 1)],
    ['paid exceeds eligible', () => alteredFixture(value => value.rows[0].days_3.paid = 4)],
    ['eligible exceeds signups', () => alteredFixture(value => value.rows[1].days_7.eligible = 4)],
    ['wrong percentage', () => alteredFixture(value => value.rows[0].days_7.conversion_percent = 0)],
    ['null percentage for eligible users', () => alteredFixture(value => value.rows[0].days_7.conversion_percent = null)],
    ['zero percentage for unavailable cell', () => alteredFixture(value => value.rows[0].days_7 = { paid: 0, eligible: 0, conversion_percent: 0 })],
    ['nonconsecutive rows', () => alteredFixture(value => value.rows[2].month = '2026-05-01')],
    ['missing empty month', () => alteredFixture(value => value.rows.pop())],
    ['malformed month', () => alteredFixture(value => value.rows[0].month = '2026-09-31')],
    ['invalid invoice timestamp', () => alteredFixture(value => value.invoice_last_synced_at = '2026-02-31T12:00:00Z')],
    ['invalid start', () => alteredFixture(value => value.start = '2026-06-02T00:00:00Z')],
    ['non-midnight cutoff', () => alteredFixture(value => value.cutoff = '2026-09-16T12:00:00Z')],
    ['submillisecond non-midnight cutoff', () => alteredFixture(value => value.cutoff = '2026-09-16T00:00:00.0001Z')],
    ['submillisecond non-midnight start', () => alteredFixture(value => value.start = '2026-06-01T00:00:00.0001Z')],
    ['stale UTC cutoff', () => alteredFixture(value => value.cutoff = '2026-09-15T00:00:00Z')],
  ])('rejects %s without inventing zeros', async (_name, create) => {
    const { validateOnboardingPaymentCohortReport } = await service()
    expect(() => validateOnboardingPaymentCohortReport(create())).toThrow()
  })

  it('preserves valid empty rows and unavailable freshness metadata', async () => {
    const { validateOnboardingPaymentCohortReport } = await service()
    const value = fixture()
    value.invoice_last_synced_at = null
    value.invoice_sync_type = null
    value.rows[0] = {
      ...value.rows[0],
      signups: 0,
      days_3: { paid: 0, eligible: 0, conversion_percent: null },
      days_7: { paid: 0, eligible: 0, conversion_percent: null },
      days_14: { paid: 0, eligible: 0, conversion_percent: null },
      ever: { paid: 0, eligible: 0, conversion_percent: null },
    }
    expect(validateOnboardingPaymentCohortReport(value)).toEqual(value)
  })

  it.each([-1e-9, 100 + 1e-9])('rejects percentage %s outside the valid range even within arithmetic tolerance', async (percentage) => {
    const { validateOnboardingPaymentCohortReport } = await service()
    const value = fixture()
    value.rows[0].days_3 = { paid: percentage < 0 ? 0 : 3, eligible: 3, conversion_percent: percentage }
    expect(() => validateOnboardingPaymentCohortReport(value)).toThrow()
  })

  it('only returns documented aggregate fields', async () => {
    const { validateOnboardingPaymentCohortReport } = await service()
    const value = { ...fixture(), unexpected_field: 'fake-sensitive-field' }
    expect(validateOnboardingPaymentCohortReport(value)).not.toHaveProperty('unexpected_field')
  })
})

describe('mounted independent payment cohort table', () => {
  it('renders the semantic full-width table and newest-first month rows from the actual mounted component', async () => {
    const { container } = await mount()
    await flush()
    expect(container.textContent).toContain('Self-Serve Signup → First Payment Conversion')
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(8)
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(4)
    expect(container.querySelector('tbody th')?.textContent).toContain('September 2026')
    expect(container.querySelector('table')?.classList.contains('w-full')).toBe(true)
    expect(container.querySelector('table')?.classList.contains('d-table')).toBe(true)
    expect(container.querySelector('[data-test="payment-cohorts-overflow"]')?.classList.contains('overflow-x-auto')).toBe(true)
    expect(container.textContent).toContain('1 / 3')
    expect(container.textContent).toContain('33.3%')
    expect(mocks.fetchStats).toHaveBeenCalledWith('onboarding_payment_cohorts', false)
  })

  it('shows its own initial loading state while the request is delayed', async () => {
    const pending = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValue(pending.promise)
    const { container } = await mount()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading payment cohorts')
    expect(container.querySelector('table')).toBeNull()
    pending.resolve(fixture())
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
  })

  it('renders unavailable rather than 0% for a zero-eligible window', async () => {
    const value = fixture()
    value.rows[0].days_3 = { paid: 0, eligible: 0, conversion_percent: null }
    mocks.fetchStats.mockResolvedValue(value)
    const { container } = await mount()
    await flush()
    expect(container.querySelector('tbody tr')?.children[4].textContent).toContain('0 / 0')
    expect(container.querySelector('tbody tr')?.children[4].textContent).toContain('Unavailable')
    expect(container.querySelector('tbody tr')?.children[4].textContent).not.toContain('0.0%')
  })

  it('uses the account format locale for UTC dates, months, counts and decimals independently of language', async () => {
    mocks.locale = 'de-DE'
    const { container } = await mount()
    await flush()
    expect(container.textContent).toContain('Self-Serve Signup → First Payment Conversion')
    expect(container.querySelector('tbody th')?.textContent).toContain('September 2026')
    expect(container.textContent).toContain('1.234')
    expect(container.textContent).toContain('33,3%')
    expect(container.textContent).toContain(new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(fixture().cutoff)))
  })

  it('shows methodology, fallback counts, freshness and explicit append caveats', async () => {
    const { container } = await mount()
    await flush()
    for (const text of ['auth.users.created_at', 'public.users', 'created_via_invite', 'orgs.created_by', '24-hour', 'numerator and denominator', 'strictly before', 'stripe_top_up', 'paid_at', 'stripe_info', '2 confirmed credit grants', 'append', 'may miss later updates', 'unequal follow-up', 'refunds or cancellations', 'UTC'])
      expect(container.textContent).toContain(text)
  })

  it('keeps a valid table when freshness metadata is unavailable', async () => {
    const value = fixture()
    value.invoice_last_synced_at = null
    value.invoice_sync_type = null
    mocks.fetchStats.mockResolvedValue(value)
    const { container } = await mount()
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).toContain('Last invoice sync: Unavailable')
    expect(container.textContent).not.toContain('Sync mode:')
    expect(container.textContent).toContain('synced snapshot')
  })

  it.each(['incremental', 'full_refresh'])('renders sync-mode %s limitations appropriately', async (mode) => {
    mocks.fetchStats.mockResolvedValue(alteredFixture(value => value.invoice_sync_type = mode))
    const { container } = await mount()
    await flush()
    expect(container.textContent).toContain(`Sync mode: ${mode}`)
    expect(container.textContent?.includes('may miss later updates')).toBe(mode === 'incremental')
    expect(container.textContent).toContain('synced snapshot')
  })

  it('makes failed or malformed source data unavailable and retries independently with a forced request', async () => {
    mocks.fetchStats.mockRejectedValueOnce(new Error('fake invoice source failure')).mockResolvedValue(fixture())
    const { container } = await mount()
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Payment cohorts are unavailable')
    expect(container.querySelector('table')).toBeNull()
    container.querySelector<HTMLButtonElement>('[data-test="payment-cohorts-retry"]')?.click()
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
    expect(mocks.fetchStats).toHaveBeenLastCalledWith('onboarding_payment_cohorts', true)
  })

  it('rejects malformed response data in the actual mounted loader', async () => {
    mocks.fetchStats.mockResolvedValue({ rows: [] })
    const { container } = await mount()
    await flush()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('table')).toBeNull()
  })

  it('does not reload for chart filters but does reload on the global refresh trigger', async () => {
    const { container } = await mount()
    await flush()
    admin.activeDateRange = 'another-chart-range'
    admin.selectedOrgId = 'fake-org'
    admin.selectedAppId = 'com.example.fake'
    await flush()
    expect(mocks.fetchStats).toHaveBeenCalledTimes(1)
    expect(container.querySelector('table')).not.toBeNull()
    admin.refreshTrigger++
    await flush()
    expect(mocks.fetchStats).toHaveBeenCalledTimes(2)
  })

  it('hides stale data on a local refresh and ignores an obsolete delayed response', async () => {
    const old = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValueOnce(old.promise).mockResolvedValue(fixture())
    const { container } = await mount()
    admin.refreshTrigger++
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
    const obsolete = fixture()
    obsolete.credit_timestamp_fallbacks = 999
    old.resolve(obsolete)
    await flush()
    expect(container.textContent).not.toContain('999 confirmed credit grants')
    const refresh = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValueOnce(refresh.promise)
    container.querySelector<HTMLButtonElement>('[data-test="payment-cohorts-refresh"]')?.click()
    await flush()
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(mocks.fetchStats).toHaveBeenLastCalledWith('onboarding_payment_cohorts', true)
    refresh.resolve(fixture())
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
  })

  it('does not request as a non-admin or display late data after an auth change', async () => {
    main.isAdmin = false
    const { container } = await mount()
    await flush()
    expect(mocks.fetchStats).not.toHaveBeenCalled()
    expect(container.querySelector('table')).toBeNull()
    const pending = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValueOnce(pending.promise)
    main.isAdmin = true
    await flush()
    expect(mocks.fetchStats).toHaveBeenCalledTimes(1)
    main.isAdmin = false
    main.authGeneration++
    await flush()
    pending.resolve(fixture())
    await flush()
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).not.toContain('confirmed credit grants')
  })

  it('reloads for a changed platform-admin identity and ignores the old identity response', async () => {
    const pending = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValueOnce(pending.promise).mockResolvedValue(fixture())
    const { container } = await mount()
    main.user = { id: 'another-fake-admin' }
    await flush()
    expect(mocks.fetchStats).toHaveBeenCalledTimes(2)
    expect(container.querySelector('table')).not.toBeNull()
    pending.resolve(alteredFixture(value => value.credit_timestamp_fallbacks = 999))
    await flush()
    expect(container.textContent).not.toContain('999 confirmed credit grants')
  })

  it('disposes an in-flight request without writing into an unmounted component', async () => {
    const pending = deferred<ReturnType<typeof fixture>>()
    mocks.fetchStats.mockReturnValueOnce(pending.promise)
    const { app, container } = await mount()
    app.unmount()
    apps.splice(apps.indexOf(app), 1)
    pending.resolve(fixture())
    await flush()
    expect(container.textContent).toBe('')
    expect(mocks.fetchStats).toHaveBeenCalledTimes(1)
  })
})
