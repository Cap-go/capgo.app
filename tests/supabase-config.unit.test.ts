import type { CapgoConfig } from '~/services/supabase'
import { describe, expect, it } from 'vitest'
import { mergeRemoteConfig, resolveSupabaseHost } from '~/services/supabase'

describe('supabase config merging', () => {
  const localConfig: CapgoConfig = {
    supaHost: 'https://sb.capgo.app',
    supaKey: 'local-anon-key',
    supbaseId: 'sb',
    host: 'https://capgo.app',
    hostWeb: 'https://capgo.app',
    stripeEnabled: true,
  }

  it.concurrent('keeps Supabase connection parameters from the local build config', () => {
    const merged = mergeRemoteConfig(localConfig, {
      supaHost: 'https://evil.example.com',
      supaKey: 'evil-key',
      supbaseId: 'evil',
      host: 'https://console.capgo.app',
      hostWeb: 'https://www.capgo.app',
      stripeEnabled: false,
    })

    expect(merged.supaHost).toBe(localConfig.supaHost)
    expect(merged.supaKey).toBe(localConfig.supaKey)
    expect(merged.supbaseId).toBe(localConfig.supbaseId)
    expect(merged.host).toBe('https://console.capgo.app')
    expect(merged.hostWeb).toBe('https://www.capgo.app')
    expect(merged.stripeEnabled).toBe(false)
  })

  it.concurrent('falls back to local values when remote config omits optional fields', () => {
    const merged = mergeRemoteConfig(localConfig, {})

    expect(merged).toEqual(localConfig)
  })
})

describe('supabase host resolution', () => {
  it.concurrent('keeps the configured Supabase host when the proxy option is disabled', () => {
    expect(resolveSupabaseHost('https://sb.capgo.app/', '')).toBe('https://sb.capgo.app')
    expect(resolveSupabaseHost('https://sb.capgo.app/', undefined)).toBe('https://sb.capgo.app')
  })
})
