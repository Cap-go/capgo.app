import { describe, expect, it } from 'vitest'

import { getManifestUrl } from '../supabase/functions/_backend/utils/downloadUrl.ts'
import { encodeManifestPathSegments, getDotfileDeltaStorageCandidateKeys, getManifestStorageCandidateKeys, normalizeLegacyEncodedManifestFileName } from '../supabase/functions/_backend/utils/manifest_encoding.ts'

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


  it.concurrent('percent-encodes leading-dot manifest segments for WAF-safe storage paths', () => {
    expect(encodeManifestPathSegments('.htaccess')).toBe('%2Ehtaccess')
    expect(encodeManifestPathSegments('public/.htaccess')).toBe('public/%2Ehtaccess')
    expect(encodeManifestPathSegments('assets/logo.png')).toBe('assets/logo.png')
  })

  it.concurrent('orders dotfile delta candidates as raw then legacy then encoded', () => {
    const hash = 'a'.repeat(64)
    const legacyPath = `orgs/org-id/apps/com.test.app/delta/${hash}_.htaccess`
    const safePath = `orgs/org-id/apps/com.test.app/delta/${hash}_%2Ehtaccess`

    expect(getDotfileDeltaStorageCandidateKeys(legacyPath)).toEqual([
      legacyPath,
      safePath,
    ])
    expect(getDotfileDeltaStorageCandidateKeys(safePath)).toEqual([
      safePath,
      legacyPath,
    ])
  })

  it.concurrent('encodes nested dot segments such as assets/.well-known/x', () => {
    expect(encodeManifestPathSegments('assets/.well-known/x')).toBe('assets/%2Ewell-known/x')
    const hash = 'b'.repeat(64)
    const legacyPath = `orgs/org-id/apps/com.test.app/delta/${hash}_assets/.well-known/x`
    const safePath = `orgs/org-id/apps/com.test.app/delta/${hash}_assets/%2Ewell-known/x`
    expect(getDotfileDeltaStorageCandidateKeys(legacyPath)).toEqual([
      legacyPath,
      safePath,
    ])
  })

  it.concurrent('rejects dot and dot-dot filename segments in delta dotfile candidates', () => {
    const hash = 'c'.repeat(64)
    const dotOnly = `orgs/org-id/apps/com.test.app/delta/${hash}_.`
    const dotDot = `orgs/org-id/apps/com.test.app/delta/${hash}_../secret`
    expect(getDotfileDeltaStorageCandidateKeys(dotOnly)).toEqual([dotOnly])
    expect(getDotfileDeltaStorageCandidateKeys(dotDot)).toEqual([dotDot])
  })

  it.concurrent('stores a literal %2Ehtaccess filename as %252Ehtaccess and lists read candidates', () => {
    const hash = 'd'.repeat(64)
    const literalSegment = '%2Ehtaccess'
    expect(encodeManifestPathSegments(literalSegment)).toBe('%252Ehtaccess')
    const rawPath = `orgs/org-id/apps/com.test.app/delta/${hash}_${literalSegment}`
    const legacyPath = `orgs/org-id/apps/com.test.app/delta/${hash}_.htaccess`
    const encodedPath = `orgs/org-id/apps/com.test.app/delta/${hash}_%252Ehtaccess`
    expect(getManifestStorageCandidateKeys(rawPath)).toEqual([
      rawPath,
      legacyPath,
      encodedPath,
    ])
  })

  it.concurrent('checks legacy percent, decoded, and upload-location encoded storage keys', () => {
    expect(getManifestStorageCandidateKeys(
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    )).toEqual([
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey@2x.png',
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%25402x.png',
    ])
    expect(getDotfileDeltaStorageCandidateKeys(
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    )).toEqual([
      'orgs/org-id/apps/com.test.app/delta/hash_assets/suite-marketing/images/social-media/sad_post_grey%402x.png',
    ])
  })
})
