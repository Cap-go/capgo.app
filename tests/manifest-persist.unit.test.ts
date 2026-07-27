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

  it.concurrent('keeps all valid rows when s3PathPrefix is omitted', () => {
    const rows = buildTrustedManifestRows(7, [
      {
        file_name: 'a.js',
        s3_path: 'orgs/a/apps/com.a/delta/h_a.js',
        file_hash: 'ha',
      },
      {
        file_name: 'b.js',
        s3_path: 'orgs/b/apps/com.b/delta/h_b.js',
        file_hash: 'hb',
      },
    ])

    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.file_size === 0)).toBe(true)
  })

  it.concurrent('normalizes legacy percent-encoded file names', () => {
    const rows = buildTrustedManifestRows(9, [{
      file_name: 'assets/img/sad_post_grey%402x.png',
      s3_path: 'orgs/org/apps/com.app/delta/hash_assets/img/sad_post_grey%402x.png',
      file_hash: 'imghash',
    }])

    expect(rows[0]?.file_name).toBe('assets/img/sad_post_grey@2x.png')
    expect(rows[0]?.file_size).toBe(0)
  })

  it.concurrent('keeps legacy %00 encoded names but drops raw null bytes', () => {
    const rows = buildTrustedManifestRows(11, [
      {
        file_name: 'ok.js',
        s3_path: 'orgs/org/apps/com.app/delta/h_ok.js',
        file_hash: 'okhash',
      },
      {
        // Decode would yield U+0000 — keep the encoded form (Postgres-safe).
        file_name: 'bad%00.js',
        s3_path: 'orgs/org/apps/com.app/delta/h_bad%00.js',
        file_hash: 'badhash',
      },
      {
        file_name: 'raw\0null.js',
        s3_path: 'orgs/org/apps/com.app/delta/h_raw.js',
        file_hash: 'rawhash',
      },
    ], 'orgs/org/apps/com.app/')

    expect(rows).toEqual([
      {
        app_version_id: 11,
        file_name: 'ok.js',
        s3_path: 'orgs/org/apps/com.app/delta/h_ok.js',
        file_hash: 'okhash',
        file_size: 0,
      },
      {
        app_version_id: 11,
        file_name: 'bad%00.js',
        s3_path: 'orgs/org/apps/com.app/delta/h_bad%00.js',
        file_hash: 'badhash',
        file_size: 0,
      },
    ])
  })
})


