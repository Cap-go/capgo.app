import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { ListedObject } from '../utils/s3.ts'
import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { s3 } from '../utils/s3.ts'

/**
 * Delta storage GC: reclaims R2 delta objects no kept version references.
 *
 * Per claimed app, one listing page (<= 1,000 keys); apps are claimed in
 * groups until the run budget is spent:
 *  1. skip objects younger than a day (uploads in flight, aborted sessions);
 *  2. drop paths still referenced (live versions, versions deleted < 7 days,
 *     in-progress uploads);
 *  3. copy the rest to the deleted-after-7-days/ trash, which the R2
 *     lifecycle rule purges, so a bad delete stays recoverable for 7 days;
 *  4. delta_gc_begin_delete re-checks under the per-app lock and opens a
 *     2-second lease that holds new uploads of this app (published CLIs insert
 *     through PostgREST under a 3-second anon statement timeout). Deletes only
 *     start in the first DELTA_GC_DELETE_START_WINDOW_MS and each one is
 *     aborted after DELTA_GC_DELETE_TIMEOUT_MS, so every request is settled
 *     well before the lease ends; then delta_gc_end_delete releases it.
 * No database transaction stays open during R2 calls.
 */

export const DELTA_GC_APPS_PER_RUN = 5
export const DELTA_GC_LIST_PAGE_SIZE = 1_000
export const DELTA_GC_MIN_OBJECT_AGE_MS = 24 * 60 * 60 * 1000
// Workers keep at most 6 outbound connections waiting at once and queue the
// rest, so more concurrency only delays requests. A batch of 30 deletes at 6 in
// flight starts within the start window.
export const DELTA_GC_STORAGE_CONCURRENCY = 6
export const DELTA_GC_DELETE_BATCH = 30
export const DELTA_GC_LEASE_MS = 2_000
export const DELTA_GC_DELETE_START_WINDOW_MS = 400
export const DELTA_GC_DELETE_TIMEOUT_MS = 800
// The queue consumer aborts dispatches after 15 seconds. New work starts only
// before the budget and each storage call is bounded, so a run answers within
// about budget + DELTA_GC_STORAGE_TIMEOUT_MS plus one progress write.
export const DELTA_GC_BUDGET_MS = 9_000
export const DELTA_GC_STORAGE_TIMEOUT_MS = 2_000

type Database = ReturnType<typeof getDrizzleClient>

// list_org: the organization prefix this pass is listing (current or former owner).
type ClaimedApp = Record<string, unknown> & { app_id: string, list_org: string, list_cursor: string | null }

export function deltaPrefix(ownerOrg: string, appId: string) {
  return `orgs/${ownerOrg}/apps/${appId}/delta/`
}

export function selectAgedKeys(objects: ListedObject[], now: number, minAgeMs = DELTA_GC_MIN_OBJECT_AGE_MS) {
  return objects
    .filter(object => Number.isFinite(object.lastModified.getTime()) && now - object.lastModified.getTime() >= minAgeMs)
    .map(object => object.key)
}

// A copy that outlives the timeout is treated as not copied: copies are
// idempotent, and an uncopied path is never authorized for deletion.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, fallback)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

// A listing that outlives the timeout fails the page; the next run retries it.
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(reject, timeoutMs, new Error(`${label} timed out after ${timeoutMs}ms`))
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Per-run state. Once a storage call times out it may keep running in the
 * background, so no new storage work starts for the rest of the run (any
 * batch, app or orphan prefix): outstanding requests stay within the limits.
 */
interface GcRun { deadline: number, stalled: boolean }

function canStart(run: GcRun) {
  return !run.stalled && Date.now() < run.deadline
}

async function forEachBounded<T>(items: T[], concurrency: number, shouldStart: () => boolean, worker: (item: T) => Promise<void>) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && shouldStart()) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function unreferencedPaths(db: Database, paths: string[]) {
  if (paths.length === 0)
    return []
  const result = await db.execute<{ paths: string[] }>(sql`SELECT public.delta_gc_unreferenced_paths(${sql.param(paths)}::text[]) AS paths`)
  return result.rows[0]?.paths ?? []
}

/** Where a batch is authorized: an app's delta prefix or an orphan prefix. */
interface DeleteTarget {
  begin: (paths: string[]) => SQL
  end: SQL
  label: string
}

function appTarget(appId: string): DeleteTarget {
  return {
    begin: paths => sql`SELECT public.delta_gc_begin_delete(${appId}, ${sql.param(paths)}::text[], ${DELTA_GC_LEASE_MS}) AS paths`,
    end: sql`SELECT public.delta_gc_end_delete(${appId})`,
    label: appId,
  }
}

function orphanTarget(prefix: string): DeleteTarget {
  return {
    begin: paths => sql`SELECT public.delta_gc_begin_orphan_delete(${prefix}, ${sql.param(paths)}::text[], ${DELTA_GC_LEASE_MS}) AS paths`,
    end: sql`SELECT public.delta_gc_end_orphan_delete(${prefix})`,
    label: prefix,
  }
}

/**
 * Copies, then deletes inside one lease. `complete` is false when an allowed
 * delete failed or never started (its delta_files row is already gone), or
 * when the target refused the batch for now: the page must be listed again
 * rather than skipped.
 */
async function trashBatch(c: Context, db: Database, target: DeleteTarget, paths: string[], run: GcRun) {
  const copied: string[] = []
  // A timed-out copy keeps running in the background: stop the whole run so
  // outstanding copies never exceed DELTA_GC_STORAGE_CONCURRENCY.
  await forEachBounded(paths, DELTA_GC_STORAGE_CONCURRENCY, () => canStart(run), async (path) => {
    const result = await withTimeout(s3.copyObjectToTrash(c, path).then(ok => ok ? 'copied' as const : 'failed' as const), DELTA_GC_STORAGE_TIMEOUT_MS, 'timeout' as const)
    if (result === 'copied')
      copied.push(path)
    else if (result === 'timeout')
      run.stalled = true
  })
  // Every candidate must be copied: a skipped or failed copy keeps the cursor.
  const copyComplete = copied.length === paths.length
  if (copied.length === 0)
    return { deleted: 0, complete: copyComplete }

  // Measured before the call: the database lease starts no earlier than this.
  const leaseStartedAt = Date.now()
  // The begin call also records every allowed path as an unsettled delete.
  const begin = await db.execute<{ paths: string[] | null }>(target.begin(copied))
  const allowed = begin.rows[0]?.paths
  if (allowed == null)
    return { deleted: 0, complete: false }
  if (allowed.length === 0)
    return { deleted: 0, complete: copyComplete }
  const startWindowEnd = leaseStartedAt + DELTA_GC_DELETE_START_WINDOW_MS
  const confirmed: string[] = []
  await forEachBounded(allowed, DELTA_GC_STORAGE_CONCURRENCY, () => Date.now() < startWindowEnd, async (path) => {
    if (await s3.deleteObjectKey(c, path, DELTA_GC_DELETE_TIMEOUT_MS))
      confirmed.push(path)
  })
  // Release early only when R2 confirmed every delete. An aborted or failed
  // request may still be applied, so the lease then runs to its end, and the
  // path stays recorded for repairUnsettledDeletes.
  if (confirmed.length === allowed.length)
    await db.execute(target.end)
  if (confirmed.length > 0)
    await db.execute(sql`SELECT public.delta_gc_confirm_deleted(${sql.param(confirmed)}::text[])`)
  if (confirmed.length < allowed.length)
    cloudlog({ requestId: c.get('requestId'), message: 'delta gc deletes left for the next pass', target: target.label, allowed: allowed.length, deleted: confirmed.length })
  return { deleted: confirmed.length, complete: confirmed.length === allowed.length && copyComplete }
}

async function collectAppPage(c: Context, db: Database, app: ClaimedApp, run: GcRun) {
  const { objects, nextToken } = await withDeadline(s3.listObjectPage(c, deltaPrefix(app.list_org, app.app_id), app.list_cursor, DELTA_GC_LIST_PAGE_SIZE), DELTA_GC_STORAGE_TIMEOUT_MS, 'R2 listing')
  const candidates = await unreferencedPaths(db, selectAgedKeys(objects, Date.now()))
  let deleted = 0
  let processed = 0
  let allDeleted = true
  while (processed < candidates.length && canStart(run)) {
    const batch = await trashBatch(c, db, appTarget(app.app_id), candidates.slice(processed, processed + DELTA_GC_DELETE_BATCH), run)
    deleted += batch.deleted
    allDeleted &&= batch.complete
    processed += DELTA_GC_DELETE_BATCH
    // An unconfirmed delete keeps the app lease to its end; a later batch
    // must not release it (delta_gc_end_delete), so stop this app's page.
    if (!batch.complete)
      break
  }

  // A page cut short by the run budget, or with an allowed delete that did not
  // happen, is listed again from the same token.
  const pageDone = processed >= candidates.length && allDeleted
  const nextCursor = pageDone ? nextToken : app.list_cursor
  return { listed: objects.length, candidates: candidates.length, deleted, nextCursor, pageDone }
}

type UnsettledDelete = Record<string, unknown> & { path: string, referenced: boolean }

/**
 * A delete whose outcome was unknown may land after an upload reused the key.
 * Referenced objects are checked about 1 minute, 1 hour and 1 day after the
 * delete and restored from their trash copy whenever missing; unreferenced
 * paths are left to the normal pass.
 */
async function repairUnsettledDeletes(c: Context, db: Database, run: GcRun) {
  const due = await db.execute<UnsettledDelete>(sql`SELECT * FROM public.delta_gc_claim_unsettled(20)`)
  for (const item of due.rows) {
    if (!canStart(run))
      break
    const outcome = item.referenced
      ? await withTimeout(s3.restoreFromTrashIfMissing(c, item.path), DELTA_GC_STORAGE_TIMEOUT_MS, 'timeout' as const)
      : 'unreferenced'
    if (outcome === 'timeout')
      run.stalled = true
    // A referenced object is re-checked over a day before the record goes,
    // so a DELETE R2 applies very late is still repaired from the trash.
    if (outcome === 'present' || outcome === 'restored' || outcome === 'unreferenced')
      await db.execute(sql`SELECT public.delta_gc_settle(${item.path}, ${outcome !== 'unreferenced'})`)
    else
      cloudlog({ requestId: c.get('requestId'), message: 'delta gc unsettled delete kept for retry', path: item.path, outcome })
  }
}

type OrphanPrefix = Record<string, unknown> & { prefix: string, list_cursor: string | null }

/**
 * Former-owner prefixes of deleted apps: listed page by page and sent through
 * the same trash copy and lease as app objects, because the app id may be
 * recreated. Objects need no minimum age: the app that wrote them is gone.
 */
async function drainOrphanPrefix(c: Context, db: Database, orphan: OrphanPrefix, run: GcRun) {
  const { objects, nextToken } = await withDeadline(s3.listObjectPage(c, orphan.prefix, orphan.list_cursor, DELTA_GC_LIST_PAGE_SIZE), DELTA_GC_STORAGE_TIMEOUT_MS, 'R2 listing')
  const keys = objects.map(object => object.key)
  let deleted = 0
  let processed = 0
  let allDeleted = true
  while (processed < keys.length && canStart(run)) {
    const batch = await trashBatch(c, db, orphanTarget(orphan.prefix), keys.slice(processed, processed + DELTA_GC_DELETE_BATCH), run)
    deleted += batch.deleted
    allDeleted &&= batch.complete
    processed += DELTA_GC_DELETE_BATCH
    if (!batch.complete)
      break
  }
  // A page cut short is listed again from the same token; the task is only
  // removed once its last page was fully processed.
  const pageDone = processed >= keys.length && allDeleted
  const nextCursor = pageDone ? nextToken : orphan.list_cursor
  await db.execute(sql`SELECT public.delta_gc_finish_orphan_prefix(${orphan.prefix}, ${nextCursor}, ${pageDone})`)
  return { listed: objects.length, deleted, pageDone }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const startedAt = Date.now()
  const run: GcRun = { deadline: startedAt + DELTA_GC_BUDGET_MS, stalled: false }
  const pool = await getPgClient(c, false)
  try {
    const db = getDrizzleClient(pool)
    if (canStart(run))
      await repairUnsettledDeletes(c, db, run)
    // Most apps list an empty or small prefix, so one run covers many apps;
    // each app gets at most one page per run.
    const seen = new Set<string>()
    let claimedApps = 0
    while (canStart(run)) {
      const claimed = await db.execute<ClaimedApp>(sql`SELECT * FROM public.delta_gc_claim(${DELTA_GC_APPS_PER_RUN})`)
      const fresh = claimed.rows.filter(row => !seen.has(row.app_id))
      // Apps already paged in this run continue on the next run.
      for (const again of claimed.rows.filter(row => seen.has(row.app_id)))
        await db.execute(sql`SELECT public.delta_gc_finish(${again.app_id}, ${again.list_cursor}, NULL, false)`)
      if (fresh.length === 0)
        break
      claimedApps += fresh.length
      for (const claimedApp of fresh) {
        seen.add(claimedApp.app_id)
        if (!canStart(run)) {
          await db.execute(sql`SELECT public.delta_gc_finish(${claimedApp.app_id}, ${claimedApp.list_cursor}, NULL, false)`)
          continue
        }
        try {
          const page = await collectAppPage(c, db, claimedApp, run)
          await db.execute(sql`SELECT public.delta_gc_finish(${claimedApp.app_id}, ${page.nextCursor}, NULL, ${page.pageDone})`)
          cloudlog({ requestId: c.get('requestId'), message: 'delta gc page done', appId: claimedApp.app_id, ...page })
        }
        catch (error) {
          cloudlogErr({ requestId: c.get('requestId'), message: 'delta gc app failed', appId: claimedApp.app_id, error })
          // Restart the listing on the next pass: continuation tokens are not durable.
          await db.execute(sql`SELECT public.delta_gc_finish(${claimedApp.app_id}, NULL, ${error instanceof Error ? error.message : 'unknown error'})`)
        }
      }
    }
    if (canStart(run)) {
      const orphans = await db.execute<OrphanPrefix>(sql`SELECT * FROM public.delta_gc_claim_orphan_prefixes(2)`)
      for (const orphan of orphans.rows) {
        if (!canStart(run))
          break
        try {
          const page = await drainOrphanPrefix(c, db, orphan, run)
          cloudlog({ requestId: c.get('requestId'), message: 'delta gc orphan prefix page done', prefix: orphan.prefix, ...page })
        }
        catch (error) {
          // The claim expires and the prefix is retried by a later run.
          cloudlogErr({ requestId: c.get('requestId'), message: 'delta gc orphan prefix failed', prefix: orphan.prefix, error })
        }
      }
    }
    cloudlog({ requestId: c.get('requestId'), message: 'delta gc run done', apps: claimedApps, durationMs: Date.now() - startedAt })
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pool)
  }
})
