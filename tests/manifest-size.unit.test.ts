import { describe, expect, it } from 'vitest'
import { buildManifestSizeLookupQuery as buildPluginManifestSizeLookupQuery, getManifestDownloadSize as getPluginManifestDownloadSize } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { buildManifestDownloadSizeResult, buildManifestSizeLookupQuery, normalizeManifestSizeFiles, parseManifestSizeVersionId } from '../supabase/functions/_backend/utils/manifest_size.ts'

describe('manifest download size helpers', () => {
  it.concurrent('parses explicit bundle ids for console manifest size requests', () => {
    expect(parseManifestSizeVersionId(42)).toBe(42)
    expect(parseManifestSizeVersionId('42')).toBe(42)
    expect(parseManifestSizeVersionId(' 42 ')).toBe(42)
    expect(parseManifestSizeVersionId(0)).toBeUndefined()
    expect(parseManifestSizeVersionId('42-file')).toBeUndefined()
  })

  it.concurrent('normalizes valid manifest files and extracts version ids from download urls', () => {
    const files = normalizeManifestSizeFiles([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42&device_id=device',
      },
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42&device_id=device',
      },
      {
        file_name: 'main.js',
        file_hash: 'hash-b',
      },
      {
        file_name: 'bad.js',
        file_hash: '',
      },
    ])

    expect(files).toEqual([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42&device_id=device',
        version_id: 42,
      },
      {
        file_name: 'main.js',
        file_hash: 'hash-b',
        download_url: null,
        version_id: null,
      },
    ])
  })

  it.concurrent('does not truncate large manifests', () => {
    const input = Array.from({ length: 10050 }, (_, index) => ({
      file_name: `file-${index}.js`,
      file_hash: `hash-${index}`,
    }))

    const files = normalizeManifestSizeFiles(input)

    expect(files).toHaveLength(input.length)
    expect(files.at(-1)).toEqual({
      file_name: 'file-10049.js',
      file_hash: 'hash-10049',
      download_url: null,
      version_id: null,
    })
  })

  it.concurrent('sums known file sizes and marks missing metadata as unknown', () => {
    const files = normalizeManifestSizeFiles([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42',
      },
      {
        file_name: 'main.js',
        file_hash: 'hash-b',
      },
      {
        file_name: 'style.css',
        file_hash: 'hash-c',
      },
    ])

    const result = buildManifestDownloadSizeResult(files, [
      { file_hash: 'hash-a', version_id: 42, file_size: 100 },
      { file_hash: 'hash-b', version_id: null, file_size: '50' },
      { file_hash: 'hash-c', version_id: null, file_size: 0 },
    ])

    expect(result.totalSize).toBe(150)
    expect(result.knownFiles).toBe(2)
    expect(result.unknownFiles).toBe(1)
    expect(result.files).toEqual([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42',
        size: 100,
      },
      {
        file_name: 'main.js',
        file_hash: 'hash-b',
        download_url: null,
        size: 50,
      },
      {
        file_name: 'style.css',
        file_hash: 'hash-c',
        download_url: null,
        error: 'size_unknown',
      },
    ])
  })

  it.concurrent('skips the database when no version scope is available', () => {
    const files = normalizeManifestSizeFiles([
      { file_name: 'main.js', file_hash: 'hash-b' },
    ])

    expect(buildManifestSizeLookupQuery('com.example.app', undefined, undefined, files)).toBeNull()
    expect(buildManifestSizeLookupQuery('com.example.app', '', undefined, files)).toBeNull()
  })

  it.concurrent('returns unknown sizes without querying postgres when no version scope exists', async () => {
    const result = await getPluginManifestDownloadSize({
      get(key: string) {
        throw new Error(`postgres context was read: ${key}`)
      },
    } as never, 'com.example.app', undefined, undefined, [
      { file_name: 'main.js', file_hash: 'hash-b' },
    ])

    expect(result).toEqual({
      totalSize: 0,
      knownFiles: 0,
      unknownFiles: 1,
      files: [{
        file_name: 'main.js',
        file_hash: 'hash-b',
        download_url: null,
        error: 'size_unknown',
      }],
    })
  })

  it.concurrent('looks up per-file version ids without scanning every app version', () => {
    const files = normalizeManifestSizeFiles([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42',
      },
      {
        file_name: 'index-copy.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index-copy.html.br?key=42',
      },
    ])

    const lookup = buildManifestSizeLookupQuery('com.example.app', undefined, undefined, files)

    expect(lookup).not.toBeNull()
    expect(lookup?.text).toContain('av.id = r.version_id')
    expect(lookup?.text).toContain('m.app_version_id = av.id')
    expect(lookup?.text).toContain('m.file_hash = r.file_hash')
    expect(lookup?.text).toContain('SELECT DISTINCT file_hash, version_id')
    expect(lookup?.text).not.toContain('UNION ALL')
    expect(lookup?.text).not.toContain('$4::text IS NULL')
    expect(JSON.parse(lookup!.values[0])).toEqual([
      { file_hash: 'hash-a', version_id: 42 },
      { file_hash: 'hash-a', version_id: 42 },
    ])
    expect(lookup?.values[1]).toBe('com.example.app')
    expect(lookup?.values).toHaveLength(2)
  })

  it.concurrent('uses one equality for a fallback version id or name', () => {
    const files = normalizeManifestSizeFiles([
      { file_name: 'main.js', file_hash: 'hash-b' },
    ])

    const byId = buildManifestSizeLookupQuery('com.example.app', '1.2.3', 7, files)
    expect(byId?.text).toContain('av.id = $3')
    expect(byId?.text).not.toContain('av.name = $3')
    expect(byId?.values).toEqual([expect.any(String), 'com.example.app', 7])

    const byName = buildManifestSizeLookupQuery('com.example.app', '1.2.3', undefined, files)
    expect(byName?.text).toContain('av.name = $3')
    expect(byName?.text).not.toContain('av.id = $3')
    expect(byName?.values).toEqual([expect.any(String), 'com.example.app', '1.2.3'])
  })

  it.concurrent('keeps plugin and backend lookup sql identical', () => {
    const files = normalizeManifestSizeFiles([
      {
        file_name: 'index.html.br',
        file_hash: 'hash-a',
        download_url: 'https://plugin.capgo.test/files/read/attachments/path/index.html.br?key=42',
      },
      { file_name: 'main.js', file_hash: 'hash-b' },
    ])

    expect(buildPluginManifestSizeLookupQuery('com.example.app', '1.2.3', undefined, files))
      .toEqual(buildManifestSizeLookupQuery('com.example.app', '1.2.3', undefined, files))
  })
})
