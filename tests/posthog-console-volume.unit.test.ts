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

  it.concurrent('passes custom capture events through before_send', () => {
    const options = createPosthogClientOptions()
    const custom = { event: 'console_feature_used', properties: { feature: 'bundles' } }
    expect(options.before_send(custom)).toMatchObject(custom)
  })

  it.concurrent('drops suppressible exceptions through before_send', () => {
    const options = createPosthogClientOptions()
    const exception = {
      event: '$exception',
      properties: { $host: 'localhost:5173', $current_url: 'http://localhost:5173/' },
    }
    expect(options.before_send(exception)).toBe(false)
  })

  it.concurrent('drops stale-asset exceptions on production hosts through before_send', () => {
    const options = createPosthogClientOptions()
    const exception = {
      event: '$exception',
      properties: {
        $current_url: 'https://console.capgo.app/apps',
        $exception_list: [{ value: 'Failed to fetch dynamically imported module: https://console.capgo.app/assets/chunk.js' }],
      },
    }
    expect(options.before_send(exception)).toBe(false)
  })

  it.concurrent('drops injected-document exceptions through before_send', () => {
    const options = createPosthogClientOptions()
    const exception = {
      event: '$exception',
      properties: {
        $current_url: 'https://console.capgo.app/apps',
        $exception_list: [{
          stacktrace: {
            frames: [{ filename: 'https://console.capgo.app/apps', function: 'global code', lineno: 1, in_app: true }],
          },
        }],
      },
    }
    expect(options.before_send(exception)).toBe(false)
  })

  it.concurrent('passes ordinary production exceptions through before_send', () => {
    const options = createPosthogClientOptions()
    const exception = {
      event: '$exception',
      properties: {
        $current_url: 'https://console.capgo.app/apps',
        $exception_list: [{ value: 'TypeError: Cannot read properties of undefined (reading "id")' }],
      },
    }
    const sent = options.before_send(exception) as { event?: string }
    expect(sent).not.toBe(false)
    expect(sent.event).toBe('$exception')
  })
})