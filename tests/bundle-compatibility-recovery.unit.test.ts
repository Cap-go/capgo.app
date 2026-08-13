import { describe, expect, it } from 'vitest'
import { BUNDLE_INCOMPATIBLE_EVENT, buildBundleCompatibilityBentoEvent, isBreakingChangeGatedByChannelStrategy } from '../supabase/functions/_backend/utils/bundle_compatibility_recovery.ts'

const base = {
  event: BUNDLE_INCOMPATIBLE_EVENT,
  orgId: 'org-1',
  appId: 'com.demo.app',
  channelOverwritten: true,
  channel: 'production',
  source: 'upload',
  versionNewId: '101',
  versionNewName: '1.0.1',
  versionOldId: '100',
  versionOldName: '1.0.0',
  orgName: 'Demo Org',
  appName: 'Demo',
  // 'none' never gates, so the base case is the crash-warning event.
  disableAutoUpdate: 'none',
}

describe('buildBundleCompatibilityBentoEvent', () => {
  it.concurrent('exposes the trigger event name', () => {
    expect(BUNDLE_INCOMPATIBLE_EVENT).toBe('Bundle Incompatible')
  })

  it.concurrent('builds a full payload for an incompatible upload that went live', () => {
    const r = buildBundleCompatibilityBentoEvent(base)
    expect(r).toBeDefined()
    expect(r!.event).toBe('bundle_incompatible')
    expect(r!.preferenceKey).toBe('bundle_incompatible')
    // Permanent per-version dedupe (no reopening cron window), so retries of the
    // same incompatible version don't re-email org admins.
    expect(r!.once).toBe(true)
    expect(r!.cron).toBeUndefined()
    expect(r!.uniqId).toBe('bundle_incompatible:com.demo.app:production:1.0.1')
    expect(r!.data).toMatchObject({
      disable_auto_update: 'none',
      gated: false,
      org_id: 'org-1',
      org_name: 'Demo Org',
      app_id: 'com.demo.app',
      app_name: 'Demo',
      channel: 'production',
      source: 'upload',
      version_new_id: '101',
      version_new_name: '1.0.1',
      version_old_id: '100',
      version_old_name: '1.0.0',
    })
  })

  // Email gate: only an incompatible upload that overwrote the channel's live
  // version produces a payload. PostHog still records every incompatible upload
  // upstream — this only controls the org-member email.
  it.concurrent('returns undefined when the channel was not overwritten', () => {
    expect(buildBundleCompatibilityBentoEvent({ ...base, channelOverwritten: false })).toBeUndefined()
  })

  it.concurrent('returns undefined when channel_overwritten is missing', () => {
    expect(buildBundleCompatibilityBentoEvent({ ...base, channelOverwritten: undefined })).toBeUndefined()
  })

  it.concurrent('falls back to the old version in uniqId when the new version is absent', () => {
    const r = buildBundleCompatibilityBentoEvent({ ...base, versionNewId: undefined, versionNewName: undefined })
    expect(r).toBeDefined()
    expect(r!.uniqId).toBe('bundle_incompatible:com.demo.app:production:1.0.0')
    expect(r!.data.version_new_id).toBe('')
    expect(r!.data.version_new_name).toBe('')
    expect(r!.data.version_old_name).toBe('1.0.0')
  })

  it.concurrent('returns undefined for other event names', () => {
    expect(buildBundleCompatibilityBentoEvent({ ...base, event: 'Bundle Upload Compatibility Checked' })).toBeUndefined()
  })

  it.concurrent('returns undefined when org or app id is missing', () => {
    expect(buildBundleCompatibilityBentoEvent({ ...base, orgId: undefined })).toBeUndefined()
    expect(buildBundleCompatibilityBentoEvent({ ...base, appId: undefined })).toBeUndefined()
  })

  it.concurrent('defaults missing fields to safe empties', () => {
    const r = buildBundleCompatibilityBentoEvent({
      ...base,
      source: undefined,
      channel: undefined,
      orgName: undefined,
      appName: undefined,
      versionNewId: undefined,
      versionNewName: undefined,
      versionOldId: undefined,
      versionOldName: undefined,
    })
    expect(r).toBeDefined()
    expect(r!.data.source).toBe('unknown')
    expect(r!.data.channel).toBe('')
    expect(r!.data.org_name).toBe('')
    expect(r!.data.app_name).toBe('')
    expect(r!.data.version_new_id).toBe('')
    expect(r!.data.version_old_id).toBe('')
    // No version names left to key off; uniqId trails with empty segments.
    expect(r!.uniqId).toBe('bundle_incompatible:com.demo.app::')
  })
})

// The channel's update strategy decides which of the two Bento signals fires:
// when the version bump keeps the bundle off devices still running the previous
// (incompatible) native build, the breaking change was done correctly.
describe('isBreakingChangeGatedByChannelStrategy', () => {
  it.concurrent.each([
    // strategy, old, new, gated
    ['major', '1.10.35', '2.0.0', true],
    ['major', '1.10.35', '1.11.0', false],
    ['major', '1.10.35', '1.10.36', false],
    ['minor', '1.10.35', '1.11.0', true],
    ['minor', '1.10.35', '2.0.0', true],
    ['minor', '1.10.35', '1.10.36', false],
    ['patch', '1.10.35', '1.10.36', true],
    ['patch', '1.10.35', '1.11.0', true],
    ['patch', '1.10.35', '1.10.35', false],
    ['version_number', '1.10.35', '1.10.36', true],
    ['none', '1.10.35', '2.0.0', false],
    ['unknown_strategy', '1.10.35', '2.0.0', false],
  ])('%s: %s -> %s gated=%s', (strategy, versionOldName, versionNewName, expected) => {
    expect(isBreakingChangeGatedByChannelStrategy({ strategy, versionOldName, versionNewName })).toBe(expected)
  })

  // Fail closed: without two parseable versions we cannot prove the strategy
  // gates delivery, so the crash warning wins.
  it.concurrent('is not gated when a version name is unparseable or missing', () => {
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: 'minor', versionOldName: 'builtin', versionNewName: '1.11.0' })).toBe(false)
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: 'minor', versionOldName: '1.10.35', versionNewName: 'nightly' })).toBe(false)
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: 'minor', versionOldName: undefined, versionNewName: '1.11.0' })).toBe(false)
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: 'minor', versionOldName: '1.10.35', versionNewName: undefined })).toBe(false)
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: null, versionOldName: '1.10.35', versionNewName: '2.0.0' })).toBe(false)
  })

  // version_number gates on min_update_version vs the device native version, so
  // it stays gated even when the bundle names don't parse.
  it.concurrent('treats version_number as gated regardless of version names', () => {
    expect(isBreakingChangeGatedByChannelStrategy({ strategy: 'version_number', versionOldName: 'builtin', versionNewName: undefined })).toBe(true)
  })
})

describe('buildBundleCompatibilityBentoEvent event split', () => {
  const incident = { ...base, versionOldName: '1.10.35', versionNewName: '1.11.0', channel: 'staging' }

  it.concurrent.each([
    ['minor', 'gated'],
    ['patch', 'gated'],
    ['version_number', 'gated'],
    ['major', 'warning'],
    ['none', 'warning'],
  ])('%s strategy on a minor bump emits the %s event', (strategy, expectation) => {
    const r = buildBundleCompatibilityBentoEvent({ ...incident, disableAutoUpdate: strategy })
    expect(r).toBeDefined()
    if (expectation === 'gated') {
      expect(r!.event).toBe('bundle_incompatible_expected')
      expect(r!.preferenceKey).toBe('bundle_incompatible_expected')
      expect(r!.uniqId).toBe('bundle_incompatible_expected:com.demo.app:staging:1.11.0')
      expect(r!.data).toMatchObject({ disable_auto_update: strategy, gated: true })
    }
    else {
      expect(r!.event).toBe('bundle_incompatible')
      expect(r!.preferenceKey).toBe('bundle_incompatible')
      expect(r!.uniqId).toBe('bundle_incompatible:com.demo.app:staging:1.11.0')
      expect(r!.data).toMatchObject({ disable_auto_update: strategy, gated: false })
    }
  })

  it.concurrent('emits the expected event for a patch bump on the patch strategy', () => {
    const r = buildBundleCompatibilityBentoEvent({ ...base, versionOldName: '1.10.35', versionNewName: '1.10.36', disableAutoUpdate: 'patch' })
    expect(r!.event).toBe('bundle_incompatible_expected')
  })

  it.concurrent('emits the warning event for a patch bump on the minor strategy', () => {
    const r = buildBundleCompatibilityBentoEvent({ ...base, versionOldName: '1.10.35', versionNewName: '1.10.36', disableAutoUpdate: 'minor' })
    expect(r!.event).toBe('bundle_incompatible')
  })

  it.concurrent('emits the expected event for a major bump on the major strategy', () => {
    const r = buildBundleCompatibilityBentoEvent({ ...base, versionOldName: '1.10.35', versionNewName: '2.0.0', disableAutoUpdate: 'major' })
    expect(r!.event).toBe('bundle_incompatible_expected')
  })

  it.concurrent('emits the warning event when versions are unparseable even on a gating strategy', () => {
    const r = buildBundleCompatibilityBentoEvent({ ...base, versionOldName: 'builtin', versionNewName: 'nightly', disableAutoUpdate: 'minor' })
    expect(r!.event).toBe('bundle_incompatible')
  })

  it.concurrent('returns undefined for a gating strategy when the channel was not overwritten', () => {
    expect(buildBundleCompatibilityBentoEvent({ ...incident, disableAutoUpdate: 'minor', channelOverwritten: false })).toBeUndefined()
  })
})
