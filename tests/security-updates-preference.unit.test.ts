import { describe, expect, it } from 'vitest'
import { isUserEmailPreferenceEnabled } from '../supabase/functions/_backend/utils/org_email_notifications.ts'

describe('security_updates email preference', () => {
  it('defaults to disabled when the key is missing', () => {
    expect(isUserEmailPreferenceEnabled({}, 'security_updates')).toBe(false)
    expect(isUserEmailPreferenceEnabled({ weekly_stats: true }, 'security_updates')).toBe(false)
  })

  it('enables only when explicitly true', () => {
    expect(isUserEmailPreferenceEnabled({ security_updates: true }, 'security_updates')).toBe(true)
    expect(isUserEmailPreferenceEnabled({ security_updates: false }, 'security_updates')).toBe(false)
  })
})
