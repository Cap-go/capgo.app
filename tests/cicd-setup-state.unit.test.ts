import { describe, expect, it } from 'vitest'
import { ciCdDetectedAt, isAppShipping, isCiCdSetupDone, parseCiCdSetupState, resolveCiGuideContext, shouldShowCiCdNav, withCiCdMarkedDone } from '../src/utils/cicdSetupState'

const shipping = { features: { ota: { succeeded_at: '2026-10-01T00:00:00.000Z' } } }

describe('CI/CD setup state', () => {
  it.concurrent.each([
    { product: 'ota', selectedPath: 'builder', expected: 'ota' },
    { product: 'builder', selectedPath: 'ota', expected: 'builder' },
    { product: undefined, selectedPath: 'builder', expected: 'builder' },
    { product: 'invalid', selectedPath: 'ota', expected: 'ota' },
    { product: ['builder'], selectedPath: 'ota', expected: 'ota' },
  ])('resolves the product from entry context before onboarding ($product, $selectedPath)', ({ product, selectedPath, expected }) => {
    expect(resolveCiGuideContext({
      product,
      onboarding: { setup: { selected_path: selectedPath } },
    }).product).toBe(expected)
  })

  it.concurrent('uses product history for context-free visits with no selected path', () => {
    const onboarding = { features: {
      ota: { succeeded_at: '2026-10-01T00:00:00.000Z' },
      builder: { last_used_at: '2026-11-01T00:00:00.000Z' },
    } }
    expect(resolveCiGuideContext({ onboarding }).product).toBe('builder')
    expect(resolveCiGuideContext({ onboarding: {
      ...onboarding,
      features: { ...onboarding.features, ota: { started_at: '2026-11-02T00:00:00.000Z' } },
    } }).product).toBe('ota')
    expect(resolveCiGuideContext({ onboarding: {
      ...onboarding,
      setup: { selected_path: 'ota' },
    } }).product).toBe('ota')
  })

  it.concurrent.each([null, {}, { features: [] }, { setup: { selected_path: 'other' } }, {
    features: { builder: { started_at: 'invalid' }, ota: { succeeded_at: 'invalid' } },
  }])('falls back to live updates without valid context or history (%j)', (onboarding) => {
    expect(resolveCiGuideContext({ onboarding })).toEqual({ product: 'ota', platform: undefined })
  })

  it.concurrent.each(['ota', 'builder'] as const)('resumes a single %s onboarding path without a selected_path', (product) => {
    expect(resolveCiGuideContext({ onboarding: { setup: { paths: [product] } } }).product).toBe(product)
  })

  it.concurrent('carries the selected Builder platform and accepts an explicit platform override', () => {
    const onboarding = { setup: { selected_path: 'builder', selected_builder_platform: 'ios' } }
    expect(resolveCiGuideContext({ onboarding })).toEqual({ product: 'builder', platform: 'ios' })
    expect(resolveCiGuideContext({ onboarding, platform: 'android' })).toEqual({ product: 'builder', platform: 'android' })
    expect(resolveCiGuideContext({ onboarding, platform: ['android'] })).toEqual({ product: 'builder', platform: 'ios' })
    expect(resolveCiGuideContext({ onboarding: {}, product: 'builder', platform: 'invalid' })).toEqual({ product: 'builder', platform: undefined })
    expect(resolveCiGuideContext({ onboarding, product: 'ota', platform: 'android' })).toEqual({ product: 'ota', platform: undefined })
  })

  it('parses the onboarding.cicd ledger and ignores malformed values', () => {
    expect(parseCiCdSetupState({ cicd: {
      ota_detected_at: '2026-11-01T00:00:00.000Z',
      builder_detected_at: '',
      detected_via: 'ci',
      ci_provider: 'GitHub Actions',
      ota_detected_via: 'ci',
      ota_ci_provider: 'GitHub Actions',
      builder_detected_via: 'key',
      key_created_at: 42,
      marked_done_at: null,
    } })).toEqual({
      otaDetectedAt: '2026-11-01T00:00:00.000Z',
      builderDetectedAt: null,
      detectedVia: 'ci',
      ciProvider: 'GitHub Actions',
      otaDetectedVia: 'ci',
      otaCiProvider: 'GitHub Actions',
      builderDetectedVia: 'key',
      builderCiProvider: null,
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
