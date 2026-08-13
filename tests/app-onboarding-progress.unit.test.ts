import { describe, expect, it } from 'vitest'
import {
  getAppOnboardingFeature,
  highestAppOnboardingStage,
  isFeatureRetained30d,
  isFeatureUsedSince,
  nextOnboardingAction,
  parseAppOnboardingLedger,
  parseAppOnboardingStage,
  rankAppOnboardingStage,
  shouldShowOnboardingNextStep,
} from '../src/utils/appOnboardingProgress.ts'

describe('app onboarding progress ledger', () => {
  it.concurrent('parses feature timestamps and ignores unknown stages', () => {
    const ledger = parseAppOnboardingLedger({
      refreshed_at: '2026-08-13T00:00:00.000Z',
      features: {
        ota: {
          started_at: '2026-08-01T00:00:00.000Z',
          stage: 'testflight',
        },
        cli_install: {
          succeeded_at: '2026-08-02T00:00:00.000Z',
          stage: 'not-a-stage',
        },
      },
    })

    expect(ledger.features?.ota?.stage).toBe('testflight')
    expect(ledger.features?.cli_install?.succeeded_at).toBe('2026-08-02T00:00:00.000Z')
    expect(ledger.features?.cli_install?.stage).toBeNull()
    expect(parseAppOnboardingStage('store_live')).toBe('store_live')
    expect(parseAppOnboardingStage('production')).toBeNull()
  })

  it.concurrent('ranks store_live above testflight and empty', () => {
    expect(rankAppOnboardingStage('store_live')).toBeGreaterThan(rankAppOnboardingStage('testflight'))
    expect(highestAppOnboardingStage(['testflight', 'no_device', 'store_live'])).toBe('store_live')
    expect(highestAppOnboardingStage([null, 'testflight'])).toBe('testflight')
    expect(highestAppOnboardingStage([])).toBeNull()
  })

  it.concurrent('does not treat is_prod-only apps as store live', () => {
    const feature = getAppOnboardingFeature({
      features: { ota: { stage: 'native_unknown' } },
    }, 'ota')
    expect(feature.stage).toBe('native_unknown')
    expect(feature.stage).not.toBe('store_live')
  })

  it.concurrent('sets retained_30d from stored timestamp, not from last_used alone', () => {
    expect(isFeatureRetained30d({
      succeeded_at: '2026-07-01T00:00:00.000Z',
      last_used_at: '2026-08-10T00:00:00.000Z',
    })).toBe(false)
    expect(isFeatureRetained30d({
      retained_30d_at: '2026-08-01T00:00:00.000Z',
    })).toBe(true)
  })

  it.concurrent('detects current quarter usage from last_used_at', () => {
    const now = Date.parse('2026-08-13T00:00:00.000Z')
    expect(isFeatureUsedSince({ last_used_at: '2026-07-01T00:00:00.000Z' }, 90 * 24 * 60 * 60 * 1000, now)).toBe(true)
    expect(isFeatureUsedSince({ last_used_at: '2026-04-01T00:00:00.000Z' }, 90 * 24 * 60 * 60 * 1000, now)).toBe(false)
  })

  it.concurrent('routes next action by distribution stage after CLI install', () => {
    expect(nextOnboardingAction({}).feature).toBe('cli_install')
    expect(nextOnboardingAction({
      features: {
        cli_install: { started_at: '2026-08-01T00:00:00.000Z' },
        ota: { stage: 'no_device' },
      },
    })).toEqual({ feature: 'cli_install', stage: 'no_device' })
    expect(nextOnboardingAction({
      features: {
        cli_install: { started_at: '2026-08-01T00:00:00.000Z', succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { started_at: '2026-08-03T00:00:00.000Z', stage: 'testflight' },
      },
    })).toEqual({ feature: 'ota', stage: 'testflight' })
    expect(nextOnboardingAction({
      features: {
        cli_install: { started_at: '2026-08-01T00:00:00.000Z', succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: {
          started_at: '2026-08-03T00:00:00.000Z',
          succeeded_at: '2026-08-04T00:00:00.000Z',
          stage: 'store_live',
        },
      },
    })).toEqual({ feature: 'ota', stage: 'store_live' })
  })

  it.concurrent('hides next-step card once store live is reached', () => {
    expect(shouldShowOnboardingNextStep({})).toBe(true)
    expect(shouldShowOnboardingNextStep({
      features: {
        cli_install: { started_at: '2026-08-01T00:00:00.000Z', succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { started_at: '2026-08-03T00:00:00.000Z', succeeded_at: '2026-08-04T00:00:00.000Z', stage: 'store_live' },
      },
    })).toBe(false)
  })
})
