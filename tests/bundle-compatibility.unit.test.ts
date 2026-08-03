import type { NativePackage } from '../src/services/bundleCompatibility'
import { describe, expect, it } from 'vitest'
import { comparePackages, hasPlatformChecksumMetadataDrift, summarizeCompatibility } from '../src/services/bundleCompatibility'

function pkg(name: string, version: string, extra: Partial<NativePackage> = {}): NativePackage {
  return { name, version, ...extra }
}

function byName(name: string, comparisons: ReturnType<typeof comparePackages>) {
  const found = comparisons.find(entry => entry.name === name)
  if (!found)
    throw new Error(`missing comparison for ${name}`)
  return found
}

describe('comparePackages', () => {
  it.concurrent('marks a package present in both with the same version as unchanged + compatible', () => {
    const result = comparePackages([pkg('a', '1.0.0')], [pkg('a', '1.0.0')])
    const a = byName('a', result)
    expect(a.status).toBe('unchanged')
    expect(a.compatible).toBe(true)
    expect(a.reasons).toEqual([])
    expect(a.candidateVersion).toBe('1.0.0')
    expect(a.baselineVersion).toBe('1.0.0')
  })

  it.concurrent('stays unchanged when version and both checksums match', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
      [pkg('a', '1.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
    )
    const a = byName('a', result)
    expect(a.status).toBe('unchanged')
    expect(a.compatible).toBe(true)
  })

  it.concurrent('marks a newly added package as added + incompatible (new_plugin)', () => {
    const result = comparePackages([pkg('a', '1.0.0')], [])
    const a = byName('a', result)
    expect(a.status).toBe('added')
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['new_plugin'])
    expect(a.baselineVersion).toBeUndefined()
  })

  it.concurrent('marks a removed package as removed + compatible (OTA-safe)', () => {
    const result = comparePackages([], [pkg('a', '1.0.0')])
    const a = byName('a', result)
    expect(a.status).toBe('removed')
    expect(a.compatible).toBe(true)
    expect(a.reasons).toEqual([])
    expect(a.candidateVersion).toBeUndefined()
  })

  it.concurrent('flags a non-intersecting version change as changed + version_mismatch', () => {
    const result = comparePackages([pkg('a', '2.0.0')], [pkg('a', '1.0.0')])
    const a = byName('a', result)
    expect(a.status).toBe('changed')
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['version_mismatch'])
  })

  it.concurrent('treats an intersecting version range as compatible (no version_mismatch)', () => {
    // Caret range on baseline intersects the concrete candidate version.
    const result = comparePackages([pkg('a', '1.2.0')], [pkg('a', '^1.0.0')])
    const a = byName('a', result)
    expect(a.reasons).not.toContain('version_mismatch')
    expect(a.compatible).toBe(true)
  })

  it.concurrent('flags a same-version package whose iOS native checksum changed', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'new' })],
      [pkg('a', '1.0.0', { ios_checksum: 'old' })],
    )
    const a = byName('a', result)
    // Same version string but native code differs => status must be 'changed'
    // (not 'unchanged') so it stays consistent with the incompatible verdict.
    expect(a.status).toBe('changed')
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['ios_code_changed'])
  })

  it.concurrent('flags a same-version package whose Android native checksum changed', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { android_checksum: 'new' })],
      [pkg('a', '1.0.0', { android_checksum: 'old' })],
    )
    const a = byName('a', result)
    expect(a.status).toBe('changed')
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['android_code_changed'])
  })

  it.concurrent('flags both platforms when both checksums changed', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'i2', android_checksum: 'a2' })],
      [pkg('a', '1.0.0', { ios_checksum: 'i1', android_checksum: 'a1' })],
    )
    expect(byName('a', result).reasons).toEqual(['both_platforms_changed'])
  })

  it.concurrent('emits multiple reasons when version and native code both change', () => {
    const result = comparePackages(
      [pkg('a', '2.0.0', { ios_checksum: 'i2' })],
      [pkg('a', '1.0.0', { ios_checksum: 'i1' })],
    )
    const a = byName('a', result)
    expect(a.status).toBe('changed')
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['version_mismatch', 'ios_code_changed'])
  })

  it.concurrent('flags one-sided checksum as incompatible metadata change (possible CLI false alarm)', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'i2' })],
      [pkg('a', '1.0.0')],
    )
    const a = byName('a', result)
    expect(a.status).toBe('changed')
    expect(a.compatible).toBe(false)
    expect(a.platformChecksumMetadataChanged).toBe(true)
    expect(a.reasons).toEqual(['platform_checksum_metadata_changed'])
  })

  it.concurrent('treats empty checksum strings as absent and still flags metadata change', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'real', android_checksum: 'd' })],
      [pkg('a', '1.0.0', { ios_checksum: '', android_checksum: '   ' })],
    )
    const a = byName('a', result)
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['platform_checksum_metadata_changed'])
    expect(a.platformChecksumMetadataChanged).toBe(true)
  })

  it.concurrent('flags when both iOS and Android checksums newly appear', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
      [pkg('a', '1.0.0')],
    )
    const a = byName('a', result)
    expect(a.compatible).toBe(false)
    expect(a.platformChecksumMetadataChanged).toBe(true)
    expect(a.reasons).toEqual(['platform_checksum_metadata_changed'])
    expect(hasPlatformChecksumMetadataDrift(result)).toBe(true)
  })

  it.concurrent('keeps version mismatch when CLI checksum metadata also appears', () => {
    const result = comparePackages(
      [pkg('a', '2.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
      [pkg('a', '1.0.0')],
    )
    const a = byName('a', result)
    expect(a.compatible).toBe(false)
    expect(a.reasons).toEqual(['version_mismatch', 'platform_checksum_metadata_changed'])
  })

  it.concurrent('does not flag metadata drift when checksums match on both sides', () => {
    const result = comparePackages(
      [pkg('a', '1.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
      [pkg('a', '1.0.0', { ios_checksum: 'i', android_checksum: 'd' })],
    )
    expect(byName('a', result).platformChecksumMetadataChanged).toBe(false)
    expect(hasPlatformChecksumMetadataDrift(result)).toBe(false)
  })

  it.concurrent('orders changes first, then added, removed, unchanged, then by name', () => {
    const result = comparePackages(
      [pkg('keep', '1.0.0'), pkg('added', '1.0.0'), pkg('changed', '2.0.0')],
      [pkg('keep', '1.0.0'), pkg('removed', '1.0.0'), pkg('changed', '1.0.0')],
    )
    expect(result.map(entry => entry.status)).toEqual(['changed', 'added', 'removed', 'unchanged'])
  })
})

describe('summarizeCompatibility', () => {
  it.concurrent('is compatible when every package is compatible', () => {
    const result = comparePackages([pkg('a', '1.0.0')], [pkg('a', '1.0.0')])
    expect(summarizeCompatibility(result)).toEqual({ compatible: true, incompatibleCount: 0, offenders: [] })
  })

  it.concurrent('reports offenders and count when any package is incompatible', () => {
    const result = comparePackages(
      [pkg('newplug', '1.0.0'), pkg('bump', '2.0.0'), pkg('same', '1.0.0')],
      [pkg('bump', '1.0.0'), pkg('same', '1.0.0')],
    )
    const summary = summarizeCompatibility(result)
    expect(summary.compatible).toBe(false)
    expect(summary.incompatibleCount).toBe(2)
    expect(summary.offenders.sort()).toEqual(['bump', 'newplug'])
  })

  it.concurrent('stays compatible when the only difference is a removed package', () => {
    const result = comparePackages([], [pkg('gone', '1.0.0')])
    expect(summarizeCompatibility(result).compatible).toBe(true)
  })
})
