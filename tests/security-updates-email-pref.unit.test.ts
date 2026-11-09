import { describe, expect, it } from 'vitest'

function defaultEmailPref(key: string): boolean {
  return key !== 'security_updates'
}

function getEmailPref(prefs: Record<string, boolean | undefined>, key: string): boolean {
  return prefs[key] ?? defaultEmailPref(key)
}

describe('security_updates email preference defaults', () => {
  it.concurrent('defaults security_updates to off', () => {
    expect(getEmailPref({}, 'security_updates')).toBe(false)
    expect(getEmailPref({ weekly_stats: true }, 'security_updates')).toBe(false)
  })

  it.concurrent('keeps other preferences on by default', () => {
    expect(getEmailPref({}, 'weekly_stats')).toBe(true)
  })

  it.concurrent('respects explicit opt-in', () => {
    expect(getEmailPref({ security_updates: true }, 'security_updates')).toBe(true)
    expect(getEmailPref({ security_updates: false }, 'security_updates')).toBe(false)
  })
})
