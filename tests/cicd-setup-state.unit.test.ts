import { describe, expect, it } from 'vitest'
import { ciCdDetectedAt, isAppShipping, isCiCdSetupDone, parseCiCdSetupState, shouldShowCiCdNav, withCiCdMarkedDone } from '../src/utils/cicdSetupState'

const shipping = { features: { ota: { succeeded_at: '2026-10-01T00:00:00.000Z' } } }

describe('CI/CD setup state', () => {
  it('parses the onboarding.cicd ledger and ignores malformed values', () => {
    expect(parseCiCdSetupState({ cicd: {
      ota_detected_at: '2026-11-01T00:00:00.000Z',
      builder_detected_at: '',
      detected_via: 'ci',
      ci_provider: 'GitHub Actions',
      key_created_at: 42,
      marked_done_at: null,
    } })).toEqual({
      otaDetectedAt: '2026-11-01T00:00:00.000Z',
      builderDetectedAt: null,
      detectedVia: 'ci',
      ciProvider: 'GitHub Actions',
      keyCreatedAt: null,
      markedDoneAt: null,
    })
    expect(parseCiCdSetupState(null).detectedVia).toBeNull()
    expect(parseCiCdSetupState({ cicd: [] }).otaDetectedAt).toBeNull()
    expect(parseCiCdSetupState({ cicd: { detected_via: 'api' } }).detectedVia).toBeNull()
  })

  it('treats CI evidence or a self-report as done', () => {
    expect(isCiCdSetupDone({})).toBe(false)
    expect(isCiCdSetupDone({ cicd: { key_created_at: '2026-11-01T00:00:00.000Z' } })).toBe(false)
    expect(isCiCdSetupDone({ cicd: { builder_detected_at: '2026-11-01T00:00:00.000Z' } })).toBe(true)
    expect(isCiCdSetupDone({ cicd: { marked_done_at: '2026-11-01T00:00:00.000Z' } })).toBe(true)
    expect(ciCdDetectedAt(parseCiCdSetupState({ cicd: { ota_detected_at: '2026-11-03T00:00:00.000Z', builder_detected_at: '2026-11-02T00:00:00.000Z' } }))).toBe('2026-11-02T00:00:00.000Z')
  })

  it('only nudges shipping apps once Getting started is gone', () => {
    expect(isAppShipping({})).toBe(false)
    expect(isAppShipping(shipping)).toBe(true)
    expect(isAppShipping({ features: { builder: { succeeded_at: '2026-10-01T00:00:00.000Z' } } })).toBe(true)
    expect(isAppShipping({ setup: { outcome: 'completed' } })).toBe(true)
    expect(isAppShipping({ setup: { outcome: 'skipped' } })).toBe(false)

    expect(shouldShowCiCdNav(shipping, false)).toBe(true)
    expect(shouldShowCiCdNav(shipping, true)).toBe(false)
    expect(shouldShowCiCdNav({}, false)).toBe(false)
    expect(shouldShowCiCdNav({ ...shipping, cicd: { ota_detected_at: '2026-11-01T00:00:00.000Z' } }, false)).toBe(false)
    expect(shouldShowCiCdNav({ ...shipping, cicd: { marked_done_at: '2026-11-01T00:00:00.000Z' } }, false)).toBe(false)
    // Creating a key is progress, not proof: the nudge stays until CI ships once.
    expect(shouldShowCiCdNav({ ...shipping, cicd: { key_created_at: '2026-11-01T00:00:00.000Z', keys: ['k'] } }, false)).toBe(true)
  })

  it('marks done locally without losing other onboarding fields', () => {
    const next = withCiCdMarkedDone({ ...shipping, cicd: { keys: ['k'] } }, '2026-11-06T00:00:00.000Z') as Record<string, any>
    expect(next.features).toEqual(shipping.features)
    expect(next.cicd).toEqual({ keys: ['k'], marked_done_at: '2026-11-06T00:00:00.000Z' })
    expect((withCiCdMarkedDone(next, '2026-12-01T00:00:00.000Z') as Record<string, any>).cicd.marked_done_at).toBe('2026-11-06T00:00:00.000Z')
  })
})
