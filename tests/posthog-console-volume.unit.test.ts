import { describe, expect, it } from 'vitest'

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

  it.concurrent('drops suppressible exceptions through before_send', () => {
    const options = createPosthogClientOptions()
    const exception = {
      event: '$exception',
      properties: { $host: 'localhost:5173', $current_url: 'http://localhost:5173/' },
    }
    expect(options.before_send(exception)).toBe(false)
  })
})
