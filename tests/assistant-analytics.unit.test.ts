import { describe, expect, it, vi } from 'vitest'
import { createAssistantAnalytics } from '../src/services/assistantAnalytics'

vi.mock('~/services/console', () => ({ getConsoleApiHost: () => 'https://api.capgo.app' }))
vi.mock('~/services/posthog', () => ({ pushEvent: vi.fn() }))

describe('assistant analytics privacy and lifecycle', () => {
  it('records one terminal outcome and elapsed time without arbitrary error text', () => {
    const capture = vi.fn()
    let time = 10
    const analytics = createAssistantAnalytics(capture, 'ios', () => time)
    const finish = analytics.start('Turn', 'message')
    time = 160
    finish('error', 'private prompt and token')
    finish('success')
    expect(capture.mock.calls).toEqual([
      ['Assistant Turn Started', { trigger: 'message', platform: 'ios', schema_version: 1, deployment: 'production' }],
      ['Assistant Turn Finished', { trigger: 'message', outcome: 'error', duration_ms: 150, error_code: 'unknown', platform: 'ios', schema_version: 1, deployment: 'production' }],
    ])
  })
  it('tracks cancellations, safe failure codes, opens and tool results with scalar metadata', () => {
    const capture = vi.fn()
    const analytics = createAssistantAnalytics(capture, 'android', () => 0)
    analytics.opened(false)
    analytics.start('Connection', 'connect')('cancelled')
    analytics.start('Turn', 'confirmation')('error', 'chatgpt_usage_limit')
    analytics.toolFinished('capgo_list_apps', false)
    analytics.disconnected()
    expect(capture.mock.calls.find(([event]) => event === 'Assistant Turn Finished')?.[1].error_code).toBe('chatgpt_usage_limit')
    expect(capture.mock.calls.find(([event]) => event === 'Assistant Connection Finished')?.[1].outcome).toBe('cancelled')
    expect(capture.mock.calls.find(([event]) => event === 'Assistant Tool Finished')?.[1]).toMatchObject({ tool_name: 'capgo_list_apps', outcome: 'error' })
    expect(capture.mock.calls.every(([, props]) => Object.values(props).every(value => ['string', 'number', 'boolean'].includes(typeof value)))).toBe(true)
  })
  it('cannot break the assistant when PostHog is blocked or unavailable', () => {
    const analytics = createAssistantAnalytics(() => { throw new Error('blocked') }, 'web')
    expect(() => {
      analytics.opened(true)
      analytics.start('Turn', 'message')('success')
      analytics.toolFinished('capgo_list_apps', true)
    }).not.toThrow()
  })
})
