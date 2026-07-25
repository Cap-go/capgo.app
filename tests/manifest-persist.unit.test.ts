import { describe, expect, it } from 'vitest'
import { buildTrustedManifestRows } from '../supabase/functions/_backend/utils/manifest_persist.ts'

describe('buildTrustedManifestRows', () => {
  it.concurrent('ignores client file_size and enforces s3 path prefix', () => {
    const rows = buildTrustedManifestRows(42, [
      {
        file_name: 'index.html',
        s3_path: 'orgs/org/apps/com.app/delta/h_index.html',
        file_hash: 'abc',
        file_size: 123456,
      },
      {
        file_name: 'evil.js',
        s3_path: 'orgs/other/apps/com.evil/delta/x_evil.js',
        file_hash: 'evil',
        file_size: 1,
      },
      {
        file_name: '',
        s3_path: 'orgs/org/apps/com.app/delta/bad',
        file_hash: 'bad',
      },
    ], 'orgs/org/apps/com.app/')

    expect(rows).toEqual([{
      app_version_id: 42,
      file_name: 'index.html',
      s3_path: 'orgs/org/apps/com.app/delta/h_index.html',
      file_hash: 'abc',
      file_size: 0,
    }])
  })
})
