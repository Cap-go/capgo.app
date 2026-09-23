import { describe, expect, it } from 'vitest'
import { buildManifestDownloadSizeResult, normalizeManifestSizeFiles, parseManifestSizeVersionId } from '../supabase/functions/_backend/utils/manifest_size.ts'

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
})
