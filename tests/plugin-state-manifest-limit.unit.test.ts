import type { PluginStateManifestDoc } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { describe, expect, it } from 'vitest'
import { pluginStateManifestPublication } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'

describe('plugin manifest KV size limit', () => {
  it.concurrent('publishes a replica marker for a valid manifest exceeding 25MiB of UTF-8', () => {
    const hash = 'a'.repeat(64)
    const entries = Array.from({ length: 5000 }, (_, index) => ({
      file_name: `${index}-${'é'.repeat(1490)}`,
      file_hash: hash,
      s3_path: `files/${'é'.repeat(1490)}`,
    }))
    const doc: PluginStateManifestDoc = {
      f: 1,
      built_at: 123,
      version_id: 123,
      app_id: 'com.test.manifestlimit',
      deleted: false,
      entries,
      sizes: entries.map(entry => [entry.file_hash, '10']),
    }
    expect(JSON.stringify(doc).length).toBeLessThan(25 * 1024 * 1024)
    const publication = pluginStateManifestPublication(doc)
    expect(publication).toEqual({
      f: 1,
      built_at: 123,
      version_id: 123,
      app_id: 'com.test.manifestlimit',
      fallback: 'replica',
      reason: 'kv_value_limit',
    })
    expect(new TextEncoder().encode(JSON.stringify(publication)).byteLength).toBeLessThan(1024)
  })

  it.concurrent('keeps a fitting manifest unchanged', () => {
    const doc: PluginStateManifestDoc = {
      f: 1, built_at: 123, version_id: 123, app_id: 'com.test.manifestlimit', deleted: false,
      entries: [{ file_name: 'main.js', file_hash: 'a'.repeat(64), s3_path: 'files/main.js' }],
      sizes: [['a'.repeat(64), '10']],
    }
    expect(pluginStateManifestPublication(doc)).toBe(doc)
  })
})
