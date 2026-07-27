import { describe, expect, it } from 'vitest'

import { getManifestUrl } from '../supabase/functions/_backend/utils/downloadUrl.ts'
import { getManifestStorageCandidateKeys, normalizeLegacyEncodedManifestFileName } from '../supabase/functions/_backend/utils/manifest_encoding.ts'

describe('manifest path encoding', () => {
  it.concurrent.each([
    {
      label: 'legacy encoded file_name',
      fileName: 'assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      s3Path: 'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      expectedFileName: 'assets/suite-marketing/images/social-media/sad_post_grey@2x.png',
    },
    {
      label: 'new raw file_name',
      fileName: 'assets/suite-marketing/images/social-media/sad_post_grey@2x.png',
      s3Path: 'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      expectedFileName: 'assets/suite-marketing/images/social-media/sad_post_grey@2x.png',
    },
    {
      label: 'new raw percent file_name',
      fileName: 'assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      s3Path: 'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%25402x.png',
      expectedFileName: 'assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    },
  ])('returns updater-safe manifest response fields for $label', ({ fileName, s3Path, expectedFileName }) => {
    const context = {
      req: {
        url: 'https://example.com/updates',
        header: () => undefined,
      },
      get: () => 'test-request',
    }
    const manifest = getManifestUrl(context as any, 123, [{
      file_name: fileName,
      file_hash: 'hash',
      s3_path: s3Path,
    }], 'device-id')

    expect(manifest[0].file_name).toBe(expectedFileName)
    expect(manifest[0].download_url).toContain(s3Path)
  })

  it.concurrent('normalizes future old-cli manifest inserts before persisting rows', () => {
    expect(normalizeLegacyEncodedManifestFileName(
      'assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    )).toBe('assets/suite-marketing/images/social-media/sad_post_grey@2x.png')
  })

  it.concurrent('keeps literal percent paths from new-cli uploads unchanged', () => {
    expect(normalizeLegacyEncodedManifestFileName(
      'assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%25402x.png',
    )).toBe('assets/suite-marketing/images/social-media/sad_post_grey%402x.png')
  })

  it.concurrent('does not decode legacy %00 into a Postgres-illegal null character', () => {
    // Keep the encoded form rather than decoding to U+0000 (PG text rejects that).
    expect(normalizeLegacyEncodedManifestFileName(
      'assets/bad%00.js',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/bad%00.js',
    )).toBe('assets/bad%00.js')
  })


  it.concurrent('checks legacy percent, decoded, and upload-location encoded storage keys', () => {
    expect(getManifestStorageCandidateKeys(
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    )).toEqual([
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey@2x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%25402x.png',
    ])
  })
})
