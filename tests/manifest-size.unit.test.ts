import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCompleteManifestVersionSizes, buildManifestVersionSizesQuery, buildManifestSizeLookupQuery as buildPluginManifestSizeLookupQuery, getManifestDownloadSize as getPluginManifestDownloadSize, MAX_MANIFEST_SIZE_FILES, MAX_MANIFEST_SIZE_VERSIONS } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { MAX_MANIFEST_ENTRIES } from '../supabase/functions/_backend/utils/manifest_limits.ts'
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
    const app = new Hono()
    const contextReads = vi.fn()
    app.get('/', async (c) => {
      vi.spyOn(c, 'get').mockImplementation((key) => {
        contextReads(key)
        throw new Error(`postgres context was read: ${key}`)
      })
      return c.json(await getPluginManifestDownloadSize(c, 'com.example.app', undefined, undefined, [
        { file_name: 'main.js', file_hash: 'hash-b' },
      ]))
    })
    const response = await app.request('/')

    expect(response.status).toBe(200)
    expect(contextReads).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
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
    expect(lookup?.text).toContain('allowed_versions')
    expect(lookup?.text).toContain('WHERE id = ids.version_id')
    expect(lookup?.text).toContain('OFFSET 0')
    // Sizes come from version_files/delta_files only.
    expect(lookup?.text).toContain('version_file.app_version_id = av.id')
    expect(lookup?.text).not.toContain('public.manifest')
    expect(lookup?.text).toContain('m.file_hash = r.file_hash')
    expect(lookup?.text).toContain('SELECT DISTINCT file_hash, version_id')
    // One lookup branch.
    expect(lookup?.text).not.toContain('\nUNION ALL\n')
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
    expect(byId?.text).toContain('WHERE id = $3')
    expect(byId?.text).toContain('OFFSET 0')
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

  it.concurrent('reads whole versions through the app-scoped primary key probe', () => {
    const lookup = buildManifestVersionSizesQuery('com.example.app', [42, 43])

    expect(lookup.text).toContain('WHERE id = ids.version_id')
    expect(lookup.text).toContain('OFFSET 0')
    expect(lookup.text).toContain('av.app_id = $2 AND av.deleted = false')
    expect(lookup.text).toContain('version_file.app_version_id = av.id')
    expect(lookup.text).not.toContain('public.manifest')
    expect(lookup.values).toEqual([[42, 43], 'com.example.app'])
  })

  it.concurrent('only builds cacheable size maps for versions with every size known', () => {
    const sizes = buildCompleteManifestVersionSizes([
      { file_hash: 'hash-a', version_id: '42' as never, file_size: '100' },
      { file_hash: 'hash-b', version_id: 42, file_size: 50 },
      { file_hash: 'hash-a', version_id: 43, file_size: 100 },
      { file_hash: 'hash-c', version_id: 43, file_size: 0 },
      { file_hash: 'hash-d', version_id: 43, file_size: 10 },
    ])

    expect([...sizes.entries()]).toEqual([[42, { 'hash-a': 100, 'hash-b': 50 }]])
  })

  it.concurrent('keeps a __proto__ file hash as an own key', () => {
    const sizes = buildCompleteManifestVersionSizes([
      { file_hash: 'hash-a', version_id: 42, file_size: 100 },
      { file_hash: '__proto__', version_id: 42, file_size: 7 },
    ]).get(42)!

    expect(Object.keys(sizes)).toEqual(['hash-a', '__proto__'])
    expect(JSON.parse(JSON.stringify(sizes))).toEqual(JSON.parse('{"hash-a":100,"__proto__":7}'))
  })
})

describe('manifest download size cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves version-scoped files from Cache API without querying postgres', async () => {
    const cachedKeys: string[] = []
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (request: Request) => {
          cachedKeys.push(request.url)
          return new Response(JSON.stringify({ 'hash-a': 100, 'hash-b': 25 }))
        },
      }),
    })

    const result = await getPluginManifestDownloadSize({
      req: { url: 'https://plugin.capgo.test/updates/manifest_size' },
      get(key: string) {
        throw new Error(`postgres context was read: ${key}`)
      },
    } as never, 'com.example.app', undefined, undefined, [
      { file_name: 'index.html', file_hash: 'hash-a', download_url: 'https://plugin.capgo.test/files/read/attachments/a?key=42' },
      { file_name: 'main.js', file_hash: 'hash-b', download_url: 'https://plugin.capgo.test/files/read/attachments/b?key=42' },
      { file_name: 'new.js', file_hash: 'hash-z', download_url: 'https://plugin.capgo.test/files/read/attachments/z?key=42' },
    ])

    expect(cachedKeys).toEqual(['https://plugin.capgo.test/.manifest-sizes-v1?app_id=com.example.app&version_id=42'])
    expect(result.totalSize).toBe(125)
    expect(result.knownFiles).toBe(2)
    expect(result.unknownFiles).toBe(1)
  })
})

describe('plugin manifest size request bounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const untouchedContext = {
    req: { url: 'https://plugin.capgo.test/updates/manifest_size' },
    get(key: string) {
      throw new Error(`postgres context was read: ${key}`)
    },
  } as never

  it('caps a file list at the bundle upload limit', () => {
    expect(MAX_MANIFEST_SIZE_FILES).toBe(MAX_MANIFEST_ENTRIES)
  })

  it('refuses a file list over the cap before any lookup', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('cache was opened')
      },
    })
    const files = Array.from({ length: MAX_MANIFEST_SIZE_FILES + 1 }, (_, index) => ({
      file_name: `file-${index}.js`,
      file_hash: `hash-${index}`,
      download_url: 'https://plugin.capgo.test/files/read/attachments/a?key=42',
    }))

    await expect(getPluginManifestDownloadSize(untouchedContext, 'com.example.app', undefined, undefined, files))
      .rejects
      .toMatchObject({ status: 400, cause: { error: 'too_many_files', moreInfo: { max: MAX_MANIFEST_SIZE_FILES, count: MAX_MANIFEST_SIZE_FILES + 1 } } })
  })

  it('refuses files spanning more bundles than the cap before reading any manifest', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('cache was opened')
      },
    })
    const files = Array.from({ length: MAX_MANIFEST_SIZE_VERSIONS + 1 }, (_, index) => ({
      file_name: `file-${index}.js`,
      file_hash: `hash-${index}`,
      download_url: `https://plugin.capgo.test/files/read/attachments/a?key=${index + 1}`,
    }))

    await expect(getPluginManifestDownloadSize(untouchedContext, 'com.example.app', undefined, undefined, files))
      .rejects
      .toMatchObject({ status: 400, cause: { error: 'too_many_versions', moreInfo: { max: MAX_MANIFEST_SIZE_VERSIONS, count: MAX_MANIFEST_SIZE_VERSIONS + 1 } } })
  })

  it('still serves a single-bundle manifest at the file cap', async () => {
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async () => new Response(JSON.stringify({ 'hash-0': 10 })),
      }),
    })
    const files = Array.from({ length: MAX_MANIFEST_SIZE_FILES }, (_, index) => ({
      file_name: `file-${index}.js`,
      file_hash: `hash-${index}`,
      download_url: 'https://plugin.capgo.test/files/read/attachments/a?key=42',
    }))

    const result = await getPluginManifestDownloadSize(untouchedContext, 'com.example.app', undefined, undefined, files)

    expect(result.knownFiles).toBe(1)
    expect(result.unknownFiles).toBe(MAX_MANIFEST_SIZE_FILES - 1)
  })
})
