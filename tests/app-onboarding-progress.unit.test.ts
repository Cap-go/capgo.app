import { describe, expect, it } from 'vitest'
import {
  buildGettingStartedSteps,
  getAppOnboardingFeature,
  gettingStartedProgress,
  highestAppOnboardingStage,
  isFeatureRetained30d,
  isFeatureUsedSince,
  nextOnboardingAction,
  onboardingNextStepMessageKeys,
  parseAppOnboardingLedger,
  parseAppOnboardingStage,
  rankAppOnboardingStage,
  shouldShowGettingStartedNav,
  shouldShowOnboardingNextStep,
} from '../src/utils/appOnboardingProgress.ts'
import {
  parseDismissedGettingStartedAppIds,
  serializeDismissedGettingStartedAppIds,
} from '../src/utils/gettingStartedDismiss.ts'

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
    expect(nextOnboardingAction({
      features: {
        builder: { started_at: '2026-08-01T00:00:00.000Z' },
      },
    })).toEqual({ feature: 'builder', stage: 'no_device' })
    expect(nextOnboardingAction({
      features: {
        cli_install: { started_at: '2026-08-01T00:00:00.000Z', succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { stage: 'play_unknown' },
        builder: { started_at: '2026-08-03T00:00:00.000Z' },
      },
    }).feature).toBe('builder')
    expect(onboardingNextStepMessageKeys({
      features: { builder: { started_at: '2026-08-01T00:00:00.000Z' } },
    })).toEqual({
      titleKey: 'onboarding-next-builder',
      descKey: 'onboarding-next-builder-desc',
    })
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

  it.concurrent('builds getting started checklist from ledger stages', () => {
    const empty = buildGettingStartedSteps({})
    expect(empty.every(step => !step.done)).toBe(true)
    expect(shouldShowGettingStartedNav({})).toBe(true)
    expect(gettingStartedProgress(empty)).toEqual({ done: 0, total: 4, percent: 0 })

    const live = buildGettingStartedSteps({
      features: {
        cli_install: { succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { started_at: '2026-08-03T00:00:00.000Z', succeeded_at: '2026-08-04T00:00:00.000Z', stage: 'store_live' },
        builder: { succeeded_at: '2026-08-05T00:00:00.000Z' },
      },
    })
    expect(live.every(step => step.done)).toBe(true)
    expect(shouldShowGettingStartedNav({
      features: {
        ota: { stage: 'store_live' },
      },
    })).toBe(false)
    expect(gettingStartedProgress(live).percent).toBe(100)
  })

  it.concurrent('marks builder done from extras without keeping the sidebar entry', () => {
    const steps = buildGettingStartedSteps({
      features: {
        cli_install: { succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { stage: 'store_live' },
      },
    }, { builderDone: true })
    expect(steps.find(step => step.id === 'builder')?.done).toBe(true)
    expect(shouldShowGettingStartedNav({
      features: {
        cli_install: { succeeded_at: '2026-08-02T00:00:00.000Z' },
        ota: { stage: 'store_live' },
      },
    })).toBe(false)
  })
})

describe('getting started dismiss storage', () => {
  it.concurrent('parses and serializes dismissed app ids', () => {
    expect(parseDismissedGettingStartedAppIds(null).size).toBe(0)
    expect(parseDismissedGettingStartedAppIds('not-json').size).toBe(0)
    expect([...parseDismissedGettingStartedAppIds('["com.demo.app",""]')]).toEqual(['com.demo.app'])
    expect(serializeDismissedGettingStartedAppIds(['com.a.app', 'com.a.app'])).toBe('["com.a.app"]')
  })
})
