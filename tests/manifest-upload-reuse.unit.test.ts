import type { ManifestUploadObjectReader, StoredManifestObject } from '../supabase/functions/_backend/utils/manifest_upload_reuse.ts'
import { describe, expect, it } from 'vitest'
import { resolveManifestUploadResponse } from '../cli/src/bundle/manifest-upload.ts'
import { verifyManifestSizeReceipts } from '../supabase/functions/_backend/utils/manifest_size_receipt.ts'
import { createManifestUploadResponse, validateManifestUploadRequest } from '../supabase/functions/_backend/utils/manifest_upload.ts'
import { createManifestReuseReceipts, findExistingManifestObjects, MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES } from '../supabase/functions/_backend/utils/manifest_upload_reuse.ts'

const CAPABILITY_SECRET = '0123456789abcdef0123456789abcdef'
const RECEIPT_SECRET = 'receipt-secret-receipt-secret-32b'
const BUCKET = 'capgo'
const PREFIX = 'orgs/org-1/apps/com.example.app/delta/'

function storedObject(size: number): StoredManifestObject {
  return { size, etag: 'd41d8cd98f00b204e9800998ecf8427e', lastModified: Date.now() - 60_000 }
}

/** In-memory bucket that records every storage call the server makes. */
function fakeReader(objects: Map<string, StoredManifestObject>, options: { pageSize?: number, failHead?: Set<string>, failList?: boolean } = {}) {
  const calls = { heads: [] as string[], listPages: 0 }
  const keys = [...objects.keys()].sort()
  const pageSize = options.pageSize ?? 1_000
  const reader: ManifestUploadObjectReader = {
    head: async (key) => {
      calls.heads.push(key)
      if (options.failHead?.has(key))
        throw new Error('storage unavailable')
      return objects.get(key) ?? null
    },
    listPage: async (prefix, token) => {
      calls.listPages++
      if (options.failList)
        throw new Error('list unavailable')
      const matching = keys.filter(key => key.startsWith(prefix))
      const start = token ? Number(token) : 0
      const page = matching.slice(start, start + pageSize)
      const next = start + pageSize
      return {
        objects: page.map(key => ({ key, ...objects.get(key)! })),
        nextToken: next < matching.length ? String(next) : null,
      }
    },
  }
  return { reader, calls }
}

function paths(count: number) {
  return Array.from({ length: count }, (_, index) => `${PREFIX}${index.toString(16).padStart(64, '0')}_file-${index}.js`)
}

describe('server-side manifest existence check', () => {
  it('uses HEADs for small manifests and finds only existing exact keys', async () => {
    const wanted = paths(5)
    const { reader, calls } = fakeReader(new Map([[wanted[1]!, storedObject(10)], [wanted[3]!, storedObject(30)]]))
    const result = await findExistingManifestObjects(reader, PREFIX, wanted)
    expect([...result.found.keys()].sort()).toEqual([wanted[1], wanted[3]].sort())
    expect(calls.listPages).toBe(0)
    expect(calls.heads.sort()).toEqual([...wanted].sort())
  })

  it('answers a large manifest from a complete listing without per-file HEADs', async () => {
    const wanted = paths(MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES * 4)
    const objects = new Map(wanted.filter((_, index) => index % 2 === 0).map(path => [path, storedObject(7)]))
    objects.set(`${PREFIX}${'f'.repeat(64)}_other-version.js`, storedObject(1))
    const { reader, calls } = fakeReader(objects, { pageSize: 50 })
    const result = await findExistingManifestObjects(reader, PREFIX, wanted)
    expect(result.found.size).toBe(wanted.length / 2)
    expect(calls.heads).toEqual([])
    expect(calls.listPages).toBeGreaterThan(1)
  })

  it('falls back to bounded HEADs when the listing exceeds its page budget', async () => {
    const wanted = paths(MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES * 2)
    const objects = new Map(wanted.map(path => [path, storedObject(3)]))
    for (let index = 0; index < 500; index++)
      objects.set(`${PREFIX}!unrelated-${String(index).padStart(3, "0")}`, storedObject(1))
    const { reader, calls } = fakeReader(objects, { pageSize: 10 })
    const result = await findExistingManifestObjects(reader, PREFIX, wanted, { listPageBudget: 2, subrequestBudget: 40 })
    expect(calls.listPages).toBe(2)
    expect(calls.heads.length).toBe(38)
    // Only what the budget proved; the rest stays a client-side check.
    expect(result.found.size).toBe(38)
  })

  it('treats storage errors as unknown, never as existing', async () => {
    const wanted = paths(3)
    const { reader } = fakeReader(new Map(wanted.map(path => [path, storedObject(5)])), { failHead: new Set([wanted[0]!]) })
    const result = await findExistingManifestObjects(reader, PREFIX, wanted)
    expect(result.found.has(wanted[0]!)).toBe(false)
    expect(result.found.size).toBe(2)
    expect(result.failures).toBe(1)

    const large = paths(MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES + 1)
    const failingList = fakeReader(new Map(large.map(path => [path, storedObject(5)])), { failList: true })
    const listed = await findExistingManifestObjects(failingList.reader, PREFIX, large)
    expect(listed.failures).toBe(1)
    expect(listed.found.size).toBe(large.length)
  })

  it('signs receipts the set_manifest verifier accepts for that exact path only', async () => {
    const wanted = paths(2)
    const { reader } = fakeReader(new Map([[wanted[0]!, storedObject(1234)]]))
    const { receipts } = await createManifestReuseReceipts(reader, RECEIPT_SECRET, BUCKET, PREFIX, wanted)
    expect([...receipts.keys()]).toEqual([wanted[0]])
    const receipt = receipts.get(wanted[0]!)!
    await expect(verifyManifestSizeReceipts(RECEIPT_SECRET, [{ path: wanted[0]!, receipt }], BUCKET)).resolves.toEqual([1234])
    // A client cannot move a receipt to another path or forge it without the secret.
    await expect(verifyManifestSizeReceipts(RECEIPT_SECRET, [{ path: wanted[1]!, receipt }], BUCKET)).resolves.toBeNull()
    await expect(verifyManifestSizeReceipts('another-secret-another-secret-32', [{ path: wanted[0]!, receipt }], BUCKET)).resolves.toBeNull()
  })

  it('signs nothing without a receipt secret', async () => {
    const wanted = paths(1)
    const { reader, calls } = fakeReader(new Map([[wanted[0]!, storedObject(1)]]))
    const { receipts } = await createManifestReuseReceipts(reader, '', BUCKET, PREFIX, wanted)
    expect(receipts.size).toBe(0)
    expect(calls.heads).toEqual([])
  })
})

describe('request_manifest_upload reuse response', () => {
  const request = validateManifestUploadRequest({
    protocol_version: 1,
    version_id: 77,
    delta_encryption: { enabled: false },
    manifest_upload_auto_enabled: false,
    file_hash_format: 'sha256_hex',
    entries: [0, 1, 2].map(id => ({
      id,
      file_name: `file-${id}.js`,
      compression: 'none',
      file_hash: String(id).repeat(64),
      uploaded_bytes_sha256: 'b'.repeat(64),
      uploaded_bytes_size: 10,
    })),
  })
  const baseOptions = {
    ownerOrg: 'org-1',
    appId: 'com.example.app',
    sessionKey: null,
    secret: CAPABILITY_SECRET,
    keyId: '2026-11-a',
    publicBaseUrl: 'https://api.example.invalid',
  }

  it('returns reuse with a receipt and no upload token for existing objects', async () => {
    let checkedPaths: string[] = []
    const response = await createManifestUploadResponse(request, {
      ...baseOptions,
      resolveReuseReceipts: async (prefix, paths) => {
        expect(prefix).toBe(PREFIX)
        checkedPaths = paths
        return new Map([[paths[1]!, 'v2.receipt-for-1']])
      },
    })
    expect(checkedPaths).toHaveLength(3)
    expect(response.default_action).toBe('upload_if_doesnt_exist')
    expect(response.entries[1]).toEqual({
      id: 1,
      s3_path_suffix: checkedPaths[1]!.slice(PREFIX.length),
      action: 'reuse',
      file_size_receipt: 'v2.receipt-for-1',
    })
    expect(response.entries[0]!.upload_token).toMatch(/^[\w-]{43}$/)
    expect(response.entries[0]).not.toHaveProperty('action')
    expect(response.entries[2]!.upload_token).toMatch(/^[\w-]{43}$/)

    // The published CLI contract accepts the mixed response.
    const resolved = resolveManifestUploadResponse(request, JSON.parse(JSON.stringify(response)))
    expect(resolved.entries.map(entry => entry.action)).toEqual(['upload_if_doesnt_exist', 'reuse', 'upload_if_doesnt_exist'])
    expect(resolved.entries[1]!.fileSizeReceipt).toBe('v2.receipt-for-1')
    expect(resolved.entries[1]!.uploadAuthorization).toBeUndefined()
  })

  it('keeps every entry on the client check when the server check fails', async () => {
    const response = await createManifestUploadResponse(request, {
      ...baseOptions,
      resolveReuseReceipts: async () => {
        throw new Error('storage down')
      },
    })
    expect(response.entries.every(entry => typeof entry.upload_token === 'string' && entry.action === undefined)).toBe(true)
  })
})
