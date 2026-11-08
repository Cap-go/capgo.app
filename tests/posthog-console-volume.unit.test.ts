import { describe, expect, it, vi } from 'vitest'

vi.mock('~/services/staleAssetErrors', () => ({
  shouldSuppressPostHogExceptionEvent: () => false,
}))

const { createPosthogClientOptions } = await import('../src/services/posthog.ts')

describe('console posthog volume guardrails', () => {
  it.concurrent('disables autocapture and web vitals on console init', () => {
    const options = createPosthogClientOptions()
    expect(options.autocapture).toBe(false)
    expect(options.capture_performance).toEqual({ web_vitals: false })
  })

  it.concurrent('keeps pageviews enabled through before_send', () => {
    const options = createPosthogClientOptions()
    const pageview = { event: '$pageview', properties: { $current_url: 'https://console.capgo.app/' } }
    expect(options.before_send(pageview)).not.toBe(false)
    expect((options.before_send(pageview) as { event?: string }).event).toBe('$pageview')
  })
})
