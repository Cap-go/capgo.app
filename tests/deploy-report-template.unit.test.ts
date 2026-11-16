import { readFileSync } from 'node:fs'
import { Liquid } from 'liquidjs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../supabase/templates/bento/deploy_report_24h.html', import.meta.url), 'utf8')
const engine = new Liquid()
const details = {
  app_id: 'com.example.app', app_name: 'Example App', version_name: '1.2.3',
  version_id: '123', channel_id: '456', channel_name: 'production', platform: 'ios',
  window_start: '2026-11-10T12:00:00Z', window_end: '2026-11-11T12:00:00Z',
  install_count_24h: '12', install_count_is_estimate: 'true',
}
function render(overrides: Record<string, unknown>) {
  return engine.parseAndRender(html, {
    visitor: { first_name: 'Example', unsubscribe_url: 'https://example.com/unsubscribe' },
    event: { details: { ...details, ...overrides } },
  })
}

describe('24h report email', () => {
  it.concurrent('shows failures with a bundle-filtered diagnostics link', async () => {
    const result = await render({ failure_count_24h: '2' })
    expect(result).toContain('Failure events were recorded.')
    expect(result).toContain('/app/com.example.app/observe/errors?version=1.2.3')
    expect(result).toContain('not unique-device counts')
    expect(result).not.toContain('{{')
    expect(result).toContain('https://example.com/unsubscribe')
  })

  it.concurrent.each([0, '0'])('renders measured zero %s without claiming a healthy release', async (failure_count_24h) => {
    const result = await render({ failure_count_24h, install_count_is_estimate: 'false' })
    expect(result).toContain('No failure events were recorded')
    expect(result).toContain('does not guarantee an error-free release')
    expect(result).toContain('Recorded events')
    expect(result).not.toContain('Unavailable')
  })

  it.concurrent('renders legacy events as unavailable rather than zero', async () => {
    const result = await render({})
    expect(result).toContain('Failure data was not included')
    expect(result).toContain('Unavailable')
    expect(result).not.toContain('No failure events were recorded')
  })

  it.concurrent('escapes user-controlled text and encodes link parameters', async () => {
    const result = await render({ app_name: '<img src=x onerror=alert(1)>', version_name: 'release & "test"' })
    expect(result).not.toContain('<img')
    expect(result).toContain('&lt;img')
    const link = result.match(/href="([^"]+\/observe\/errors[^\"]+)"/)?.[1]
    expect(new URL(link!).searchParams.get('version')).toBe('release & "test"')
  })
})
