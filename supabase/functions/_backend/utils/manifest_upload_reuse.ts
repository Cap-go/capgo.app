import type { Context } from 'hono'
import type { ManifestSizeReceiptEvidence } from './manifest_size_receipt.ts'
import { cloudlog } from './logging.ts'
import { createManifestSizeReceipt, getManifestReceiptBucket } from './manifest_size_receipt.ts'
import { s3 } from './s3.ts'
import { getEnv } from './utils.ts'

/**
 * Server-side existence check for `request_manifest_upload`.
 *
 * The CLI used to probe every delta file with its own GET (up to 10,000 round
 * trips). The server can answer most of that with one listing page per 1,000
 * keys, or a few hundred HEADs, and sign the same `r2_read` size receipt the
 * files read route signs. Any storage failure only drops the entry back to
 * `upload_if_doesnt_exist`, where the CLI keeps its own check.
 */

export interface StoredManifestObject {
  size: number
  etag: string | null
  lastModified: number | null
}

export interface ManifestUploadObjectReader {
  head: (key: string) => Promise<StoredManifestObject | null>
  listPage: (prefix: string, continuationToken: string | null) => Promise<{
    objects: Array<StoredManifestObject & { key: string }>
    nextToken: string | null
  }>
}

export interface FoundManifestObject {
  object: StoredManifestObject
  /** Taken before the storage call that proved the object, like the files read route. */
  readStartedAt: number
}

export interface FindExistingManifestObjectsOptions {
  /** Storage calls (list pages plus HEADs) this request may spend. */
  subrequestBudget?: number
  listPageBudget?: number
  headConcurrency?: number
  deadlineMs?: number
  now?: () => number
}

// Workers allow 10k subrequests per request; stay well under it so the rest of
// the request (Postgres, logging) always fits.
export const MANIFEST_REUSE_SUBREQUEST_BUDGET = 1_000
export const MANIFEST_REUSE_LIST_PAGE_BUDGET = 20
export const MANIFEST_REUSE_HEAD_CONCURRENCY = 32
export const MANIFEST_REUSE_DEADLINE_MS = 10_000
// Up to this many entries, HEADs are cheaper than listing a shared prefix.
export const MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES = 256

async function headPaths(
  reader: ManifestUploadObjectReader,
  paths: string[],
  found: Map<string, FoundManifestObject>,
  concurrency: number,
  deadline: number,
  now: () => number,
): Promise<number> {
  let nextIndex = 0
  let failures = 0
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (nextIndex < paths.length && now() < deadline) {
      const path = paths[nextIndex++]!
      const readStartedAt = now()
      try {
        const object = await reader.head(path)
        if (object)
          found.set(path, { object, readStartedAt })
      }
      catch {
        failures++
      }
    }
  })
  await Promise.all(workers)
  return failures
}

/**
 * Returns the objects that exist at exactly these keys. Entries that cannot be
 * proven within the budget are left out, never guessed.
 */
export async function findExistingManifestObjects(
  reader: ManifestUploadObjectReader,
  prefix: string,
  paths: string[],
  options: FindExistingManifestObjectsOptions = {},
): Promise<{ found: Map<string, FoundManifestObject>, listPages: number, heads: number, failures: number }> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.deadlineMs ?? MANIFEST_REUSE_DEADLINE_MS)
  const budget = Math.max(0, options.subrequestBudget ?? MANIFEST_REUSE_SUBREQUEST_BUDGET)
  const listPageBudget = Math.min(budget, Math.max(0, options.listPageBudget ?? MANIFEST_REUSE_LIST_PAGE_BUDGET))
  const concurrency = Math.max(1, options.headConcurrency ?? MANIFEST_REUSE_HEAD_CONCURRENCY)
  const found = new Map<string, FoundManifestObject>()
  const wanted = new Set(paths.filter(path => path.startsWith(prefix)))
  let listPages = 0
  let failures = 0

  if (wanted.size > MANIFEST_REUSE_HEAD_ONLY_MAX_ENTRIES) {
    let token: string | null = null
    let complete = false
    try {
      while (listPages < listPageBudget && found.size < wanted.size && now() < deadline) {
        const readStartedAt = now()
        const page: Awaited<ReturnType<ManifestUploadObjectReader['listPage']>> = await reader.listPage(prefix, token)
        listPages++
        for (const object of page.objects) {
          if (wanted.has(object.key))
            found.set(object.key, { object: { size: object.size, etag: object.etag, lastModified: object.lastModified }, readStartedAt })
        }
        token = page.nextToken
        if (!token) {
          complete = true
          break
        }
      }
    }
    catch {
      failures++
    }
    // A complete listing already answered every key; absent keys stay uploads.
    if (complete)
      return { found, listPages, heads: 0, failures }
  }

  const remaining = [...wanted].filter(path => !found.has(path)).slice(0, Math.max(0, budget - listPages))
  failures += await headPaths(reader, remaining, found, concurrency, deadline, now)
  return { found, listPages, heads: remaining.length, failures }
}

export function manifestSizeReceiptEvidenceFromStoredObject(object: StoredManifestObject, readStartedAt: number): ManifestSizeReceiptEvidence {
  return {
    size: object.size,
    source: 'r2_read',
    evidenceAt: readStartedAt,
    uploadedAt: object.lastModified != null && object.lastModified > 0 ? object.lastModified : undefined,
    etag: object.etag ?? undefined,
  }
}

/** Receipts for every path proven to exist, keyed by exact path. */
export async function createManifestReuseReceipts(
  reader: ManifestUploadObjectReader,
  secret: string,
  bucket: string,
  prefix: string,
  paths: string[],
  options: FindExistingManifestObjectsOptions = {},
): Promise<{ receipts: Map<string, string>, listPages: number, heads: number, failures: number }> {
  const receipts = new Map<string, string>()
  if (!secret || !bucket || paths.length === 0)
    return { receipts, listPages: 0, heads: 0, failures: 0 }
  const result = await findExistingManifestObjects(reader, prefix, paths, options)
  let failures = result.failures
  for (const [path, { object, readStartedAt }] of result.found) {
    try {
      receipts.set(path, await createManifestSizeReceipt(secret, bucket, path, manifestSizeReceiptEvidenceFromStoredObject(object, readStartedAt)))
    }
    catch {
      failures++
    }
  }
  return { receipts, listPages: result.listPages, heads: result.heads, failures }
}

export function createStorageManifestObjectReader(c: Context): ManifestUploadObjectReader {
  return {
    head: key => s3.statObject(c, key),
    listPage: (prefix, token) => s3.listObjectMetadataPage(c, prefix, token),
  }
}

/**
 * Wiring for the endpoint: null when this deployment cannot sign receipts or
 * reach storage, so every entry keeps the client-side existence check.
 */
export function manifestReuseResolver(c: Context): ((prefix: string, paths: string[]) => Promise<Map<string, string>>) | undefined {
  const secret = getEnv(c, 'MANIFEST_SIZE_RECEIPT_SECRET')
  if (!secret || !getEnv(c, 'S3_ACCESS_KEY_ID') || !getEnv(c, 'S3_SECRET_ACCESS_KEY') || !getEnv(c, 'S3_BUCKET'))
    return undefined
  const bucket = getManifestReceiptBucket(getEnv(c, 'ENV_NAME'))
  return async (prefix, paths) => {
    const startedAt = Date.now()
    const result = await createManifestReuseReceipts(createStorageManifestObjectReader(c), secret, bucket, prefix, paths)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'request_manifest_upload reuse check',
      entry_count: paths.length,
      reuse_count: result.receipts.size,
      list_pages: result.listPages,
      heads: result.heads,
      failures: result.failures,
      elapsed_ms: Date.now() - startedAt,
    })
    return result.receipts
  }
}
