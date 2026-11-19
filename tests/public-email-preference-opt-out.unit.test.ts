import { describe, expect, it } from 'vitest'
import { buildPublicEmailOptOutPreferences, defaultPublicEmailFormPreferences } from '../src/utils/publicEmailPreferenceOptOut'

const PUBLIC_KEYS = [
  'usage_limit',
  'security_updates',
] as const

describe('public email preference opt-out payload', () => {
  it('defaults every toggle on, including security_updates', () => {
    expect(defaultPublicEmailFormPreferences(PUBLIC_KEYS)).toEqual({
      usage_limit: true,
      security_updates: true,
    })
  })

  it('does not send security_updates:false from a fresh form save', () => {
    const prefs = defaultPublicEmailFormPreferences(PUBLIC_KEYS)
    expect(buildPublicEmailOptOutPreferences(prefs, false, PUBLIC_KEYS)).toEqual({})
  })

  it('still allows explicit security_updates opt-out', () => {
    const prefs = { ...defaultPublicEmailFormPreferences(PUBLIC_KEYS), security_updates: false }
    expect(buildPublicEmailOptOutPreferences(prefs, false, PUBLIC_KEYS)).toEqual({ security_updates: false })
  })
})
