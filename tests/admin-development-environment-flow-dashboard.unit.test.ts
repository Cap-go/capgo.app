// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import QuestionFlow from '../src/components/admin/AdminDevelopmentEnvironmentFlow.vue'
import { parseAdminDevelopmentEnvironmentFlow } from '../src/services/adminDevelopmentEnvironmentFlow'

vi.mock('~/services/formatLocale', () => ({ formatNumberValue: (number: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-GB', options).format(number) }))
const payload = {
  generated_at: '2026-09-16T00:00:00.000Z',
  period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-16T00:00:00.000Z' },
  data_quality: { configured: true, connected: true, failure_reason: null, excluded_question_views: 0 },
  reached: 12,
  groups: [
    { answer: 'answered', people: 8, continued: 6, did_not_continue: 2 },
    { answer: 'skipped', people: 2, continued: 2, did_not_continue: 0 },
    { answer: 'no_answer', people: 2, continued: 0, did_not_continue: 2 },
  ],
}
const apps: App[] = []
function mount(analytics: unknown = payload, loading = false, onRetry = vi.fn()) {
  const app = createApp(QuestionFlow, { analytics: parseAdminDevelopmentEnvironmentFlow(analytics), loading, onRetry })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  const container = document.createElement('div')
  app.mount(container)
  apps.push(app)
  return container
}
afterEach(() => apps.splice(0).forEach(app => app.unmount()))

describe('app-building question flow', () => {
  it('renders the journey graph with each branch count, accessible node names and group percentages', () => {
    const container = mount()
    const nodes = [...container.querySelectorAll('[role="group"]')]
    expect(nodes).toHaveLength(9)
    expect(nodes.map(node => node.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Reached “What do you use to build your app?”: 12'),
      expect.stringContaining('Answered: 8'),
      expect.stringContaining('Continued: 6'),
      expect.stringContaining('No recorded continuation: 2'),
      expect.stringContaining('Skipped: 2'),
      expect.stringContaining('Continued: 2'),
      expect.stringContaining('No answer recorded: 2'),
      expect.stringContaining('Continued: 0'),
      expect.stringContaining('No recorded continuation: 2'),
    ])
    expect(nodes[2].getAttribute('aria-label')).toContain('75% of this group')
    expect(container.querySelectorAll('.journey-canvas > svg > path')).toHaveLength(8)
    expect(container.textContent).toContain('2026-09-01 – 2026-09-16 (UTC)')
    expect(container.textContent).toContain('not experiment assignments')
    expect(container.textContent).toContain('return later')
    const onRetry = vi.fn()
    mount(payload, false, onRetry).querySelector('button')?.click()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows the graph and discloses legacy question views excluded from its counts', () => {
    const container = mount({ ...payload, data_quality: { ...payload.data_quality, excluded_question_views: 2 } })
    expect(container.querySelectorAll('[role="group"]')).toHaveLength(9)
    expect(container.textContent).toContain('2 recorded question views were excluded')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(mount().textContent).not.toContain('recorded question views were excluded')
    const onlyExcluded = mount({ ...payload, reached: 0, groups: payload.groups.map(group => ({ ...group, people: 0, continued: 0, did_not_continue: 0 })), data_quality: { ...payload.data_quality, excluded_question_views: 2 } })
    expect(onlyExcluded.textContent).toContain('No question views with complete tracking')
    expect(onlyExcluded.textContent).toContain('2 recorded question views were excluded')
  })

  it('distinguishes unavailable tracking, genuine empty data and loading', () => {
    const unavailable = mount({ ...payload, reached: null, groups: null, data_quality: { configured: false, connected: false, failure_reason: 'unconfigured', excluded_question_views: 0 } })
    expect(unavailable.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
    expect(unavailable.querySelector('[role="group"]')).toBeNull()
    const empty = mount({ ...payload, reached: 0, groups: payload.groups.map(group => ({ ...group, people: 0, continued: 0, did_not_continue: 0 })) })
    expect(empty.textContent).toContain('No question views with complete tracking')
    expect(empty.querySelector('[role="alert"]')).toBeNull()
    expect(mount(null, true).querySelector('button')?.disabled).toBe(true)
  })

  it.concurrent.each([
    { reached: 13 },
    { data_quality: { ...payload.data_quality, excluded_question_views: -1 } },
    { reached: '12' },
    { groups: payload.groups.slice(1) },
    { groups: [payload.groups[0], payload.groups[0], payload.groups[2]] },
    { groups: [{ ...payload.groups[0], continued: 7 }, ...payload.groups.slice(1)] },
    { groups: [payload.groups[0], { ...payload.groups[1], continued: 1, did_not_continue: 1 }, payload.groups[2]] },
    { groups: [{ ...payload.groups[0], people: -1 }, ...payload.groups.slice(1)] },
    { data_quality: { configured: true, connected: false, failure_reason: null, excluded_question_views: 0 } },
    { data_quality: { configured: true, connected: true, failure_reason: 'unavailable', excluded_question_views: 0 } },
  ])('rejects inconsistent or malformed response %j', changes => expect(parseAdminDevelopmentEnvironmentFlow({ ...payload, ...changes })).toBeNull())
})
