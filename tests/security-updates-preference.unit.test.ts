import { describe, expect, it } from 'vitest'
import { isUserEmailPreferenceEnabled as isUserEmailPreferenceEnabledBackend } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
import { isUserEmailPreferenceEnabled as isUserEmailPreferenceEnabledPlugin } from '../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts'

const helpers = [
  { name: 'backend', fn: isUserEmailPreferenceEnabledBackend },
  { name: 'plugin_runtime', fn: isUserEmailPreferenceEnabledPlugin },
] as const

describe('security_updates email preference', () => {
  it.each(helpers)('defaults security_updates to disabled in $name', ({ fn }) => {
    expect(fn({}, 'security_updates')).toBe(false)
    expect(fn({ weekly_stats: true }, 'security_updates')).toBe(false)
  })

  it.each(helpers)('enables security_updates only when explicitly true in $name', ({ fn }) => {
    expect(fn({ security_updates: true }, 'security_updates')).toBe(true)
    expect(fn({ security_updates: false }, 'security_updates')).toBe(false)
  })

  it.each(helpers)('keeps default-on semantics for other preferences in $name', ({ fn }) => {
    expect(fn({}, 'weekly_stats')).toBe(true)
    expect(fn({ weekly_stats: false }, 'weekly_stats')).toBe(false)
  })

  it.each(helpers)('drops org admin recipients without explicit opt-in for security_updates in $name', ({ fn }) => {
    const admins = [
      { email: 'opted-in@example.com', prefs: { security_updates: true } },
      { email: 'default-off@example.com', prefs: {} },
      { email: 'opted-out@example.com', prefs: { security_updates: false } },
    ]
    const recipients = admins
      .filter(admin => fn(admin.prefs, 'security_updates'))
      .map(admin => admin.email)
    expect(recipients).toEqual(['opted-in@example.com'])
  })
})
