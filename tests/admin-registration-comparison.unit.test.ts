// @vitest-environment happy-dom
import type { App } from 'vue'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import AdminRegistrationComparison from '../src/components/admin/AdminRegistrationComparison.vue'
import { formatRegistrationComparisonMonth } from '../src/services/adminRegistrationComparison'

const { fetchStatsMock } = vi.hoisted(() => ({ fetchStatsMock: vi.fn() }))
vi.mock('../src/stores/adminDashboard', () => ({ useAdminDashboardStore: () => ({ fetchStats: fetchStatsMock }) }))
vi.mock('../src/services/formatLocale', () => ({ formatNumberValue: (value: number) => String(value) }))
vi.mock('../src/components/dashboard/ChartCard.vue', () => ({
  default: defineComponent({
    props: ['isLoading'],
    setup: (props, { slots }) => () => h('section', [slots.header?.(), props.isLoading ? h('p', 'Loading') : slots.default?.()]),
  }),
}))

const payload = {
  generated_at: '2026-09-16T12:35:00.000Z',
  time_zone: 'Europe/Warsaw',
  cutoff_day: 16,
  cutoff_time: '14:35',
  months: ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'].map(month => ({
    month,
    full_month: false,
    self_signup: 4,
    organization_invite: 2,
    unknown_other: null,
    total: 6,
  })),
  totals: { self_signup: 20, organization_invite: 10, unknown_other: null, total: 30 },
}
let app: App | undefined

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountComparison() {
  const messages = JSON.parse(await readFile(resolve('messages/en.json'), 'utf8'))
  const container = document.createElement('div')
  app = createApp(AdminRegistrationComparison)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount(container)
  await flush()
  return container
}

beforeEach(() => {
  fetchStatsMock.mockReset()
  fetchStatsMock.mockResolvedValue(payload)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
})

describe('admin monthly registration comparison', () => {
  it('renders five months, separate signup methods, and tracked totals', async () => {
    const container = await mountComparison()
    expect(fetchStatsMock).toHaveBeenCalledWith('registration_monthly_comparison', true)
    expect(container.textContent).toContain('14:35 Warsaw time')
    expect(container.textContent).toContain('independent of the page date filter')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(container.querySelector('tbody tr')?.textContent).toContain('September 2026')
    expect(Array.from(container.querySelectorAll('tbody tr:first-child td')).map(cell => cell.textContent?.trim())).toEqual(['4', '2', '—', '6'])
    expect(Array.from(container.querySelectorAll('tfoot td')).map(cell => cell.textContent?.trim())).toEqual(['20', '10', '—', '30'])
    expect(container.querySelectorAll('[aria-label="Not separately tracked"]')).toHaveLength(6)
    expect(container.textContent).toContain('unavailable, not zero')
  })

  it('keeps zeros visible when there are no recorded registrations', async () => {
    fetchStatsMock.mockResolvedValue({ ...payload, months: payload.months.map(month => ({ ...month, self_signup: 0, organization_invite: 0, total: 0 })), totals: { self_signup: 0, organization_invite: 0, unknown_other: null, total: 0 } })
    const container = await mountComparison()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(container.querySelector('tfoot')?.textContent).toContain('0')
  })

  it('shows a recoverable error instead of fake registration totals', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchStatsMock.mockRejectedValueOnce(new Error('Temporary failure'))
    const container = await mountComparison()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporarily unavailable')
    expect(container.querySelector('table')).toBeNull()
    container.querySelector('button')?.click()
    await flush()
    expect(container.querySelector('table')).not.toBeNull()
    expect(fetchStatsMock).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  it('reloads the comparison on explicit refresh without a page-filter dependency', async () => {
    const container = await mountComparison()
    container.querySelector('button')?.click()
    await flush()
    expect(fetchStatsMock).toHaveBeenCalledTimes(2)
    expect(fetchStatsMock).toHaveBeenLastCalledWith('registration_monthly_comparison', true)
  })

  it.concurrent('formats month names without shifting into the previous month', () => {
    expect(formatRegistrationComparisonMonth('2026-09', 'en')).toBe('September 2026')
    expect(formatRegistrationComparisonMonth('2026-01', 'en')).toBe('January 2026')
  })

  it.concurrent('replaces the legacy funnel and keeps the table outside other analytics errors', async () => {
    const source = await readFile(resolve('src/pages/admin/dashboard/frontend-onboarding.vue'), 'utf8')
    expect(source).toContain('import AdminRegistrationComparison')
    expect(source).toContain('</template>\n        <AdminRegistrationComparison />')
    expect(source).not.toContain('funnel-v1-legacy')
    expect(source).not.toContain('v1FunnelStages')
    expect(source).not.toContain('v1FunnelSummaries')
    const backend = await readFile(resolve('supabase/functions/_backend/private/admin_stats.ts'), 'utf8')
    expect(backend).toContain('case \'registration_monthly_comparison\':')
    expect(backend).toContain('await getAdminRegistrationMonthlyComparison(c)')
  })
})
