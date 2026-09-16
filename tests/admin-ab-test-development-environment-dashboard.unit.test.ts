// @vitest-environment happy-dom

import type { App, Component } from 'vue'
import { readFile } from 'node:fs/promises'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import DevelopmentEnvironmentCard from '../src/components/admin/AdminABTestDevelopmentEnvironment.vue'
import ABTestsPage from '../src/pages/admin/dashboard/ab-tests.vue'
import {
  developmentEnvironmentPercentage,
  parseAdminABTestDevelopmentEnvironment,
} from '../src/services/adminABTestDevelopmentEnvironment'

const mocks = vi.hoisted(() => ({
  fetchStats: vi.fn(),
  routerPush: vi.fn(async () => undefined),
  mainStore: { isAdmin: true },
  displayStore: { NavTitle: '', defaultBack: '' },
}))

vi.mock('~/stores/adminDashboard', () => ({ useAdminDashboardStore: () => ({ fetchStats: mocks.fetchStats }) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => mocks.mainStore }))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => mocks.displayStore }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.routerPush }) }))
// Existing analytics are outside this card's scope; preserve real distribution/publish parsing.
vi.mock('~/services/adminABTestChannelCreation', () => ({ parseAdminABTestChannelCreation: () => ({}) }))
vi.mock('~/components/admin/AdminABTestChannelCreation.vue', () => ({ default: { template: '<section />' } }))
vi.mock('~/services/formatLocale', () => ({
  formatNumberValue: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-GB', options).format(value),
}))

const names = ['ai_assistant', 'hosted_builder', 'other', 'hand_coded', 'no_selection_yet'] as const
const payload = { total: 12, outcomes: names.map((outcome, index) => ({ outcome, count: [4, 3, 2, 1, 2][index] })) }
const emptyPayload = { total: 0, outcomes: names.map(outcome => ({ outcome, count: 0 })) }
const intentNames = ['publish', 'builder', 'ota', 'both', 'exploring', 'no_selection_yet'] as const
const hostedPayload = { total: 3, outcomes: intentNames.map((outcome, index) => ({ outcome, count: [1, 1, 0, 0, 0, 1][index] })) }
const emptyHostedPayload = { total: 0, outcomes: intentNames.map(outcome => ({ outcome, count: 0 })) }
const publishPayload = { total: 0, outcomes: ['selected_publish', 'selected_another_intent', 'no_selection_yet'].map(outcome => ({ outcome, count: 0 })) }
const mountedApps: App[] = []

function mount(component: Component, props = {}) {
  const app = createApp(component, props)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  const container = document.createElement('div')
  app.mount(container)
  mountedApps.push(app)
  return container
}

function stats(category: string) {
  if (category === 'ab_test_distribution')
    return []
  if (category === 'ab_test_publish_intent_outcome')
    return publishPayload
  if (category === 'ab_test_development_environment')
    return { ...payload, hosted_builder_intents: hostedPayload }
  return {}
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mainStore.isAdmin = true
  mocks.fetchStats.mockImplementation(async category => stats(category))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  vi.restoreAllMocks()
})

describe('development environment response contract', () => {
  it.concurrent('accepts and reorders all five buckets, including valid empty data', () => {
    expect(parseAdminABTestDevelopmentEnvironment({ ...payload, outcomes: [...payload.outcomes].reverse() })).toEqual(payload)
    expect(parseAdminABTestDevelopmentEnvironment(emptyPayload)).toEqual(emptyPayload)
  })

  it.concurrent('rejects malformed, duplicate, missing, unknown and inconsistent data', () => {
    const invalid = [null, [], {}, { ...payload, outcomes: [] }, { ...payload, outcomes: payload.outcomes.slice(1) }, { ...payload, outcomes: [payload.outcomes[0], ...payload.outcomes.slice(0, 4)] }, { ...payload, total: 11 }, { ...payload, outcomes: [{ outcome: 'legacy', count: 4 }, ...payload.outcomes.slice(1)] }]
    for (const count of [-1, 0.5, '4', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ ...payload, total: count })
      invalid.push({ ...payload, outcomes: [{ outcome: 'ai_assistant', count }, ...payload.outcomes.slice(1)] })
    }
    for (const value of invalid)
      expect(parseAdminABTestDevelopmentEnvironment(value)).toBeNull()
  })

  it.concurrent('calculates percentages to one decimal without dividing by zero', () => {
    expect(developmentEnvironmentPercentage(1, 3)).toBe(33.3)
    expect(developmentEnvironmentPercentage(2, 3)).toBe(66.7)
    expect(developmentEnvironmentPercentage(0, 0)).toBe(0)
  })
})

describe('real development environment card', () => {
  it('renders five accessible horizontal bars, counts, percentages and truthful cohort notes', () => {
    const container = mount(DevelopmentEnvironmentCard, { outcome: payload })
    expect(container.querySelector('h2')?.textContent).toBe('What do you use to build your app?')
    const bars = [...container.querySelectorAll('progress')]
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['AI assistant', 'Hosted AI builder', 'Other', 'I write code by hand', 'Did not select yet'])
    expect(bars.map(bar => bar.value)).toEqual([4, 3, 2, 1, 2])
    expect(bars.every(bar => bar.max === 12 && bar.classList.contains('w-full'))).toBe(true)
    expect(container.textContent).toContain('33.3%')
    expect(container.textContent).toContain('8.3%')
    expect(container.textContent).toContain('unique people assigned')
    expect(container.textContent).toContain('Development environment treatment C / 5.C')
    expect(container.textContent).toContain('not necessarily reached')
    expect(container.textContent).toContain('Claude, Cursor, Codex')
    expect(container.textContent).toContain('unavailable or skipped')
  })

  it('shows five zero rows with a clear empty-data message', () => {
    const container = mount(DevelopmentEnvironmentCard, { outcome: emptyPayload })
    expect(container.textContent).toContain('No people have been assigned to this cohort yet.')
    expect(container.querySelectorAll('progress')).toHaveLength(5)
    expect([...container.querySelectorAll('progress')].every(bar => bar.value === 0 && bar.max === 1)).toBe(true)
    expect(container.textContent?.match(/0\.0%/g)).toHaveLength(5)
  })
})

describe('actual A/B dashboard page wiring', () => {
  it('loads the new category and places its card after Publish intent outcome', async () => {
    const container = mount(ABTestsPage)
    await vi.waitFor(() => expect(container.querySelectorAll('h2')).toHaveLength(3))
    expect(mocks.fetchStats).toHaveBeenCalledWith('ab_test_development_environment', false)
    const titles = [...container.querySelectorAll('h2')].map(title => title.textContent?.trim())
    expect(titles.slice(-3)).toEqual(['New Publish intent outcome', 'What do you use to build your app?', 'Hosted AI builder: selected intent'])
  })

  it('renders six intent rows in stable order with counts, percentages and saved-answer notes', async () => {
    mocks.fetchStats.mockImplementation(async category => category === 'ab_test_development_environment'
      ? { ...payload, hosted_builder_intents: { ...hostedPayload, outcomes: [...hostedPayload.outcomes].reverse() } }
      : stats(category))
    const container = mount(ABTestsPage)
    await vi.waitFor(() => expect(container.querySelectorAll('h2')).toHaveLength(3))
    const card = [...container.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent?.trim() === 'Hosted AI builder: selected intent')!
    const bars = [...card.querySelectorAll('progress')]
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['Convert my webapp to a mobile app', 'Build native apps (Capgo Builder)', 'Ship live updates (OTA)', 'Both', 'Just exploring', 'Did not select yet'])
    expect(bars.map(bar => bar.value)).toEqual([1, 1, 0, 0, 0, 1])
    expect(bars.every(bar => bar.max === 3)).toBe(true)
    expect(card.textContent).toContain('33.3%')
    expect(card.textContent).toContain('unique people who selected Hosted AI builder')
    expect(card.textContent).toContain('treatment C / 5.C')
    expect(card.textContent).toContain('not inferred from organizations')
    expect(mocks.fetchStats).toHaveBeenCalledTimes(4)
  })

  it('renders an empty intent chart when no hosted-builder people exist, even if other tools were selected', async () => {
    mocks.fetchStats.mockImplementation(async category => category === 'ab_test_development_environment'
      ? { total: 9, outcomes: payload.outcomes.map(item => item.outcome === 'hosted_builder' ? { ...item, count: 0 } : item), hosted_builder_intents: emptyHostedPayload }
      : stats(category))
    const container = mount(ABTestsPage)
    await vi.waitFor(() => expect(container.querySelectorAll('h2')).toHaveLength(3))
    const card = [...container.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent?.trim() === 'Hosted AI builder: selected intent')!
    expect(card.textContent).toContain('No people in this cohort have selected Hosted AI builder yet.')
    expect([...card.querySelectorAll('progress')].every(bar => bar.value === 0 && bar.max === 1)).toBe(true)
    expect(card.textContent?.match(/0\.0%/g)).toHaveLength(6)
  })

  it.each([
    undefined,
    { ...hostedPayload, total: 4 },
    { total: 0, outcomes: [] },
    { ...hostedPayload, outcomes: [hostedPayload.outcomes[0], ...hostedPayload.outcomes.slice(0, 5)] },
    { ...hostedPayload, outcomes: [{ outcome: 'unsupported', count: 1 }, ...hostedPayload.outcomes.slice(1)] },
    ...[-1, 0.5, '1', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(count => ({ ...hostedPayload, outcomes: [{ outcome: 'publish', count }, ...hostedPayload.outcomes.slice(1)] })),
    { total: 4, outcomes: hostedPayload.outcomes.map(item => item.outcome === 'publish' ? { ...item, count: 2 } : item) },
  ])('rejects malformed or mismatched hosted-builder intent data and retries with fresh data: %j', async (hosted_builder_intents) => {
    mocks.fetchStats.mockImplementation(async category => category === 'ab_test_development_environment'
      ? { ...payload, hosted_builder_intents }
      : stats(category))
    const container = mount(ABTestsPage)
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(container.querySelector('progress')).toBeNull()
    mocks.fetchStats.mockImplementation(async category => stats(category))
    container.querySelector<HTMLButtonElement>('button')?.click()
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull())
    expect(mocks.fetchStats).toHaveBeenCalledWith('ab_test_development_environment', true)
  })

  it.each(['invalid', 'failed'])('uses the existing error state and force-refresh retry for %s new data', async (failure) => {
    mocks.fetchStats.mockImplementation(async (category) => {
      if (category === 'ab_test_development_environment') {
        if (failure === 'failed')
          throw new Error('unavailable')
        return { ...payload, total: 999 }
      }
      return stats(category)
    })
    const container = mount(ABTestsPage)
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(container.querySelector('progress')).toBeNull()
    mocks.fetchStats.mockImplementation(async category => stats(category))
    container.querySelector<HTMLButtonElement>('button')?.click()
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull())
    await nextTick()
    expect(mocks.fetchStats).toHaveBeenCalledWith('ab_test_development_environment', true)
    expect(container.textContent).toContain('What do you use to build your app?')
    expect(mocks.fetchStats.mock.calls.slice(-4).every(([, forceRefresh]) => forceRefresh === true)).toBe(true)
  })

  it('does not fetch statistics for a non-admin', async () => {
    mocks.mainStore.isAdmin = false
    mount(ABTestsPage)
    await vi.waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith('/dashboard'))
    expect(mocks.fetchStats).not.toHaveBeenCalled()
  })

  it('adds dispatch behind existing admin authentication and the store category', async () => {
    const backend = await readFile(new NodeURL('../supabase/functions/_backend/private/admin_stats.ts', import.meta.url), 'utf8')
    const store = await readFile(new NodeURL('../src/stores/adminDashboard.ts', import.meta.url), 'utf8')
    expect(store).toContain(`'ab_test_development_environment'`)
    expect(backend).toContain(`case 'ab_test_development_environment':`)
    expect(backend).toContain('result = await getAdminABTestDevelopmentEnvironment(c)')
    expect(backend.indexOf('if (!isAdmin)')).toBeLessThan(backend.indexOf(`case 'ab_test_development_environment':`))
  })
})
