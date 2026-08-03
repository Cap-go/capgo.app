import type { Compatibility } from '../cli/src/schemas/common.ts'
import { describe, expect, it } from 'vitest'
import { summarizeUploadCompatibility } from '../cli/src/bundle/compatibility.ts'
import { getCompatibilityDetails } from '../cli/src/utils.ts'

// Fixtures mirroring the cases getCompatibilityDetails() classifies.
const compatibleSameVersion: Compatibility = {
  name: 'compatible-same',
  localVersion: '1.0.0',
  remoteVersion: '1.0.0',
}

const removedRemoteOnly: Compatibility = {
  name: 'removed-remote-only',
  localVersion: undefined,
  remoteVersion: '1.0.0',
}

const newPlugin: Compatibility = {
  name: 'new-plugin',
  localVersion: '1.0.0',
  remoteVersion: undefined,
}

const versionMismatch: Compatibility = {
  name: 'version-mismatch',
  localVersion: '2.0.0',
  remoteVersion: '1.0.0',
}

const iosCodeChanged: Compatibility = {
  name: 'ios-changed',
  localVersion: '1.0.0',
  remoteVersion: '1.0.0',
  localIosChecksum: 'aaa',
  remoteIosChecksum: 'bbb',
}

describe('summarizeUploadCompatibility', () => {
  it.concurrent('reports skipped when the comparison did not run (undefined)', () => {
    expect(summarizeUploadCompatibility(undefined)).toEqual({
      result: 'skipped',
      incompatibleCount: 0,
      reasons: [],
    })
  })

  it.concurrent('reports compatible for an empty package set (check ran, no native deps)', () => {
    expect(summarizeUploadCompatibility([])).toEqual({
      result: 'compatible',
      incompatibleCount: 0,
      reasons: [],
    })
  })

  it.concurrent('treats matching versions and remote-only removals as compatible', () => {
    expect(summarizeUploadCompatibility([compatibleSameVersion, removedRemoteOnly])).toEqual({
      result: 'compatible',
      incompatibleCount: 0,
      reasons: [],
    })
  })

  it.concurrent('flags a newly added native plugin as incompatible', () => {
    expect(summarizeUploadCompatibility([compatibleSameVersion, newPlugin])).toEqual({
      result: 'incompatible',
      incompatibleCount: 1,
      reasons: ['new_plugin'],
    })
  })

  it.concurrent('aggregates distinct reasons across incompatible packages', () => {
    const summary = summarizeUploadCompatibility([
      compatibleSameVersion,
      versionMismatch,
      iosCodeChanged,
    ])
    expect(summary.result).toBe('incompatible')
    expect(summary.incompatibleCount).toBe(2)
    expect([...summary.reasons].sort()).toEqual(['ios_code_changed', 'version_mismatch'])
  })

  it.concurrent('de-duplicates repeated reasons', () => {
    const summary = summarizeUploadCompatibility([
      versionMismatch,
      { ...versionMismatch, name: 'version-mismatch-2' },
    ])
    expect(summary.incompatibleCount).toBe(2)
    expect(summary.reasons).toEqual(['version_mismatch'])
  })

  it.concurrent('flags one-sided iOS/Android checksum metadata as incompatible CLI drift', () => {
    const oneSided: Compatibility = {
      name: 'cli-metadata',
      localVersion: '1.0.0',
      remoteVersion: '1.0.0',
      localIosChecksum: 'aaa',
      localAndroidChecksum: 'bbb',
    }
    const details = getCompatibilityDetails(oneSided)
    expect(details.compatible).toBe(false)
    expect(details.reasons).toEqual(['platform_checksum_metadata_changed'])
    expect(details.message).toContain('Capgo CLI')

    expect(summarizeUploadCompatibility([oneSided])).toEqual({
      result: 'incompatible',
      incompatibleCount: 1,
      reasons: ['platform_checksum_metadata_changed'],
    })
  })

  it.concurrent('treats whitespace-only remote checksums as absent metadata', () => {
    const whitespaceRemote: Compatibility = {
      name: 'cli-metadata-ws',
      localVersion: '1.0.0',
      remoteVersion: '1.0.0',
      localIosChecksum: 'aaa',
      remoteIosChecksum: '   ',
    }
    const details = getCompatibilityDetails(whitespaceRemote)
    expect(details.compatible).toBe(false)
    expect(details.reasons).toEqual(['platform_checksum_metadata_changed'])
  })
})
