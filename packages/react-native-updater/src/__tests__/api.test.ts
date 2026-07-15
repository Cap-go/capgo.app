import { describe, expect, test } from 'bun:test'
import { PLUGIN_VERSION } from '../version'
import type { DownloadOptions, ManifestEntry } from '../definitions'

describe('react-native-updater API contract', () => {
  test('plugin version is semver', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('manifest entries use Capgo snake_case wire format', () => {
    const entry: ManifestEntry = {
      file_name: 'index.android.bundle.br',
      file_hash: 'abc123',
      download_url: 'https://example.com/file',
    }
    expect(entry.file_name?.endsWith('.br')).toBe(true)
    const opts: DownloadOptions = {
      url: 'https://404.capgo.app/no.zip',
      version: '1.0.1',
      manifest: [entry],
    }
    expect(opts.manifest?.[0].file_hash).toBe('abc123')
  })
})
