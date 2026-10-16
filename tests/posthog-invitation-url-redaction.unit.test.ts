import { describe, expect, it, vi } from 'vitest'

vi.mock('~/services/staleAssetErrors', () => ({
  shouldSuppressPostHogExceptionEvent: () => false,
}))

vi.mock('~/services/supabase', () => ({
  isLocal: () => false,
}))

const { sanitizePostHogInvitationEvent } = await import('../src/services/posthog.ts')

describe('postHog invitation URL redaction', () => {
  it.concurrent('removes Apple callback credentials from page URLs and initial person properties', () => {
    const callback = 'https://console.capgo.app/login#apple_code=private-exchange-code&state=private-state'
    const sanitized = sanitizePostHogInvitationEvent({
      event: '$pageview',
      properties: {
        $current_url: callback,
        $set: { $current_url: callback },
        $set_once: { $initial_current_url: callback },
        $referrer: 'https://console.capgo.app/login#apple_error=cancelled&state=private-state',
      },
    }) as any
    expect(sanitized.properties.$current_url).toBe('https://console.capgo.app/login')
    expect(sanitized.properties.$set.$current_url).toBe('https://console.capgo.app/login')
    expect(sanitized.properties.$set_once.$initial_current_url).toBe('https://console.capgo.app/login')
    expect(sanitized.properties.$referrer).toBe('https://console.capgo.app/login')
    expect(JSON.stringify(sanitized)).not.toMatch(/private-exchange-code|private-state|apple_code|apple_error/)
  })

  it.concurrent('removes magic-link bearer tokens from automatic URL properties', () => {
    const secret = 'secret-invitation-token'
    const sanitized = sanitizePostHogInvitationEvent({
      event: '$pageview',
      properties: {
        $current_url: `https://console.capgo.app/invitation?invite_magic_string=${secret}&source=email`,
        $initial_referrer: `https://console.capgo.app/invitation?invite_magic_string=${secret}`,
        $set_once: {
          $initial_current_url: `https://console.capgo.app/invitation?invite_magic_string=${secret}`,
        },
        entry_path: '/invitation',
      },
    }) as any

    expect(sanitized.properties.$current_url).toBe('https://console.capgo.app/invitation?source=email')
    expect(sanitized.properties.$initial_referrer).toBe('https://console.capgo.app/invitation')
    expect(sanitized.properties.$set_once.$initial_current_url).toBe('https://console.capgo.app/invitation')
    expect(sanitized.properties.entry_path).toBe('/invitation')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })

  it.concurrent('removes tokens when the invitation query key is percent encoded', () => {
    const secret = 'encoded-secret-invitation-token'
    const sanitized = sanitizePostHogInvitationEvent({
      event: '$pageview',
      properties: {
        $current_url: `https://console.capgo.app/invitation?invite_magic%5Fstring=${secret}&source=email`,
      },
    }) as any

    expect(sanitized.properties.$current_url).toBe('https://console.capgo.app/invitation?source=email')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })
})
