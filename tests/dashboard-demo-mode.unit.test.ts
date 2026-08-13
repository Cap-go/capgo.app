import { describe, expect, it } from 'vitest'
import { shouldShowDashboardDemoData } from '../src/utils/dashboardDemoMode.ts'

describe('shouldShowDashboardDemoData', () => {
  it('shows sample-data overlay only for a loaded org dashboard with no apps', () => {
    expect(shouldShowDashboardDemoData({ forceDemo: false, appId: '', appsCount: 0, appsLoaded: true })).toBe(true)
    expect(shouldShowDashboardDemoData({ forceDemo: false, appsCount: 0, appsLoaded: true })).toBe(true)
  })

  it('hides the overlay while the apps store is still loading', () => {
    expect(shouldShowDashboardDemoData({ forceDemo: false, appsCount: 0, appsLoaded: false })).toBe(false)
  })

  it('hides the overlay when the org already has apps', () => {
    expect(shouldShowDashboardDemoData({ forceDemo: false, appsCount: 1, appsLoaded: true })).toBe(false)
  })

  it('hides the overlay on a real app page even if the org apps store is still empty', () => {
    expect(shouldShowDashboardDemoData({
      forceDemo: false,
      appId: 'com.example.app',
      appsCount: 0,
      appsLoaded: true,
    })).toBe(false)
  })

  it('keeps forced demo mode for payment-failed and app-not-found states', () => {
    expect(shouldShowDashboardDemoData({
      forceDemo: true,
      appId: 'com.example.app',
      appsCount: 1,
      appsLoaded: true,
    })).toBe(true)
  })
})
