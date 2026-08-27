import { describe, expect, it } from 'vitest'

import { shouldHonorPersistedChannelOverride } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_compatibility.ts'

describe('shouldHonorPersistedChannelOverride', () => {
  it.concurrent('honors forced dashboard overrides regardless of plugin version', () => {
    expect(shouldHonorPersistedChannelOverride('7.34.0', false)).toBe(true)
    expect(shouldHonorPersistedChannelOverride(null, false)).toBe(true)
  })

  it.concurrent('honors self-set overrides only for legacy plugin devices', () => {
    expect(shouldHonorPersistedChannelOverride('7.33.9', true)).toBe(true)
    expect(shouldHonorPersistedChannelOverride('7.34.0', true)).toBe(false)
    expect(shouldHonorPersistedChannelOverride(null, true)).toBe(false)
  })
})
