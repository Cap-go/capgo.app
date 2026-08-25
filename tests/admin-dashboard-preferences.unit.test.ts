import type { Json } from '../src/types/supabase.types'
import { describe, expect, it } from 'vitest'
import {
  createAdminDashboardChartPreferenceKey,
  preserveAdminDashboardMinimize,
  readAdminDashboardMinimize,
  withAdminDashboardMinimize,
} from '../src/services/adminDashboardPreferences'

describe('admin dashboard graph preferences', () => {
  it.concurrent('reads only boolean minimize preferences from user onboarding', () => {
    const onboarding = {
      status: 'in_progress',
      admin_dashboard_minimize: {
        users_daily_attempts: true,
        users_funnel: false,
        invalid_string: 'yes',
        invalid_number: 1,
      },
    } as Json

    expect(readAdminDashboardMinimize(onboarding)).toEqual({
      users_daily_attempts: true,
      users_funnel: false,
    })
    expect(readAdminDashboardMinimize([])).toEqual({})
    expect(readAdminDashboardMinimize({ admin_dashboard_minimize: true })).toEqual({})
  })

  it.concurrent('merges preferences without replacing unrelated onboarding progress', () => {
    expect(withAdminDashboardMinimize({
      status: 'in_progress',
      step: 'details',
    }, {
      users_daily_attempts: true,
      users_funnel: false,
    })).toEqual({
      status: 'in_progress',
      step: 'details',
      admin_dashboard_minimize: {
        users_daily_attempts: true,
        users_funnel: false,
      },
    })
  })

  it.concurrent('preserves the preference object only for administrators', () => {
    const current = {
      status: 'in_progress',
      admin_dashboard_minimize: {
        users_daily_attempts: true,
      },
    } as Json
    const next = {
      status: 'completed',
      step: 'setup',
    } as Json

    expect(preserveAdminDashboardMinimize(next, current, true)).toEqual({
      status: 'completed',
      step: 'setup',
      admin_dashboard_minimize: {
        users_daily_attempts: true,
      },
    })
    expect(preserveAdminDashboardMinimize(next, current, false)).toEqual(next)
  })

  it.concurrent('creates compact deterministic keys from stable IDs and separates routes', () => {
    const key = createAdminDashboardChartPreferenceKey(
      '/admin/dashboard/onboarding/frontend',
      'funnel-v3',
    )

    expect(key).toMatch(/^frontend\.funnel-v3\.[a-f0-9]{8}$/)
    expect(key.length).toBeLessThanOrEqual(72)
    expect(createAdminDashboardChartPreferenceKey(
      '/admin/dashboard/onboarding/frontend',
      'funnel-v3',
    )).toBe(key)
    expect(createAdminDashboardChartPreferenceKey(
      '/admin/dashboard/users',
      'funnel-v3',
    )).not.toBe(key)
    expect(createAdminDashboardChartPreferenceKey(
      '/admin/dashboard/onboarding/frontend',
      'daily-attempts',
    )).not.toBe(key)
  })
})
