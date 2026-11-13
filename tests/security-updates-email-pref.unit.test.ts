import { describe, expect, it } from 'vitest'
import { defaultAccountEmailPref, resolveAccountEmailPref } from '../src/utils/accountEmailPreferenceDefaults'

describe('security_updates email preference defaults', () => {
  it.concurrent('defaults security_updates to off', () => {
    expect(resolveAccountEmailPref({}, 'security_updates')).toBe(false)
    expect(resolveAccountEmailPref({ weekly_stats: true }, 'security_updates')).toBe(false)
    expect(defaultAccountEmailPref('security_updates')).toBe(false)
  })

  it.concurrent('keeps other preferences on by default', () => {
    expect(resolveAccountEmailPref({}, 'weekly_stats')).toBe(true)
  })

  it.concurrent('respects explicit opt-in', () => {
    expect(resolveAccountEmailPref({ security_updates: true }, 'security_updates')).toBe(true)
    expect(resolveAccountEmailPref({ security_updates: false }, 'security_updates')).toBe(false)
  })
})
