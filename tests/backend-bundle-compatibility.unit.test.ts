import type { NativePackage } from '../supabase/functions/_backend/utils/bundle_compatibility.ts'
import { describe, expect, it } from 'vitest'
import {
  compareNativePackages,
  selectCurrentDeploymentPair,
  summarizeBundleCompatibility,
} from '../supabase/functions/_backend/utils/bundle_compatibility.ts'

function pkg(name: string, version: string, extra: Partial<NativePackage> = {}): NativePackage {
  return { name, version, ...extra }
}

describe('backend bundle compatibility helpers', () => {
  it.concurrent('flags newly added native packages as incompatible', () => {
    const comparisons = compareNativePackages(
      [pkg('@capacitor/camera', '8.0.0')],
      [],
    )

    expect(comparisons).toHaveLength(1)
    expect(comparisons[0]).toMatchObject({
      name: '@capacitor/camera',
      status: 'added',
      compatible: false,
      reasons: ['new_plugin'],
    })
    expect(summarizeBundleCompatibility(comparisons)).toEqual({
      compatible: false,
      incompatibleCount: 1,
      offenders: ['@capacitor/camera'],
    })
  })

  it.concurrent('treats removed native packages as OTA-compatible', () => {
    const comparisons = compareNativePackages(
      [],
      [pkg('@capacitor/camera', '8.0.0')],
    )

    expect(comparisons[0]).toMatchObject({
      status: 'removed',
      compatible: true,
      reasons: [],
    })
    expect(summarizeBundleCompatibility(comparisons).compatible).toBe(true)
  })

  it.concurrent('flags native checksum changes even when versions match', () => {
    const comparisons = compareNativePackages(
      [pkg('@capgo/native', '1.0.0', { ios_checksum: 'new-ios', android_checksum: 'new-android' })],
      [pkg('@capgo/native', '1.0.0', { ios_checksum: 'old-ios', android_checksum: 'old-android' })],
    )

    expect(comparisons[0]).toMatchObject({
      status: 'changed',
      compatible: false,
      reasons: ['both_platforms_changed'],
      platformChecksumMetadataChanged: false,
    })
  })

  it.concurrent('keeps OTA-compatible when iOS/Android checksums only appear after a CLI upgrade', () => {
    const comparisons = compareNativePackages(
      [pkg('@capgo/native', '1.0.0', { ios_checksum: 'new-ios', android_checksum: 'new-android' })],
      [pkg('@capgo/native', '1.0.0')],
    )

    expect(comparisons[0]).toMatchObject({
      status: 'unchanged',
      compatible: true,
      reasons: [],
      platformChecksumMetadataChanged: true,
    })
    expect(summarizeBundleCompatibility(comparisons).compatible).toBe(true)
  })

  it.concurrent('flags requested version constraint changes as metadata when resolved versions match', () => {
    const comparisons = compareNativePackages(
      [pkg('@capgo/native', '1.2.0', { requested_version: '^1.2.0' })],
      [pkg('@capgo/native', '1.2.0', { requested_version: '1.2.x' })],
    )

    expect(comparisons[0]).toMatchObject({
      status: 'changed',
      compatible: true,
      reasons: ['requested_version_changed'],
      candidateRequestedVersion: '^1.2.0',
      baselineRequestedVersion: '1.2.x',
    })
  })

  it.concurrent('selects the current default-channel deployment and previous baseline', () => {
    const pair = selectCurrentDeploymentPair([
      { id: 30, version_id: 300, deployed_at: '2026-06-03T10:00:00.000Z' },
      { id: 20, version_id: 200, deployed_at: '2026-06-02T10:00:00.000Z' },
      { id: 10, version_id: 100, deployed_at: '2026-06-01T10:00:00.000Z' },
    ], 300)

    expect(pair?.current.version_id).toBe(300)
    expect(pair?.previous.version_id).toBe(200)
  })

  it.concurrent('returns undefined when deployment history cannot provide a baseline', () => {
    expect(selectCurrentDeploymentPair([
      { id: 30, version_id: 300, deployed_at: '2026-06-03T10:00:00.000Z' },
    ], 300)).toBeUndefined()

    expect(selectCurrentDeploymentPair([
      { id: 30, version_id: 300, deployed_at: '2026-06-03T10:00:00.000Z' },
      { id: 20, version_id: 200, deployed_at: '2026-06-02T10:00:00.000Z' },
    ], 400)).toBeUndefined()
  })
})
