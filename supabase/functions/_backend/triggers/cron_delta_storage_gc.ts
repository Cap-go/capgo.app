import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { ListedObject } from '../utils/s3.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { s3 } from '../utils/s3.ts'

/**
 * Delta storage GC: reclaims R2 delta objects no kept version references.
 *
 * Per claimed app, one listing page (<= 1,000 keys) per run:
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
export const DELTA_GC_DELETE_BATCH = 100
export const DELTA_GC_LEASE_MS = 2_000
export const DELTA_GC_DELETE_START_WINDOW_MS = 400
export const DELTA_GC_DELETE_TIMEOUT_MS = 800
export const DELTA_GC_BUDGET_MS = 25_000
const DELTA_GC_COPY_CONCURRENCY = 25
// One batch starts all of its deletes at once inside the start window.
const DELTA_GC_DELETE_CONCURRENCY = DELTA_GC_DELETE_BATCH

type Database = ReturnType<typeof getDrizzleClient>

type ClaimedApp = Record<string, unknown> & { app_id: string, owner_org: string, list_cursor: string | null }

export function deltaPrefix(ownerOrg: string, appId: string) {
  return `orgs/${ownerOrg}/apps/${appId}/delta/`
}

export function selectAgedKeys(objects: ListedObject[], now: number, minAgeMs = DELTA_GC_MIN_OBJECT_AGE_MS) {
  return objects
    .filter(object => Number.isFinite(object.lastModified.getTime()) && now - object.lastModified.getTime() >= minAgeMs)
    .map(object => object.key)
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
  const result = await db.execute<{ paths: string[] }>(sql`SELECT public.delta_gc_unreferenced_paths(${paths}::text[]) AS paths`)
  return result.rows[0]?.paths ?? []
}

/** Copies, then deletes inside one lease. Returns the number of deleted objects. */
async function trashBatch(c: Context, db: Database, appId: string, paths: string[], deadline: number) {
  const copied: string[] = []
  await forEachBounded(paths, DELTA_GC_COPY_CONCURRENCY, () => Date.now() < deadline, async (path) => {
    if (await s3.copyObjectToTrash(c, path))
      copied.push(path)
  })
  if (copied.length === 0)
    return 0

  // Measured before the call: the database lease starts no earlier than this.
  const leaseStartedAt = Date.now()
  const begin = await db.execute<{ paths: string[] }>(sql`
    SELECT public.delta_gc_begin_delete(${appId}, ${copied}::text[], ${DELTA_GC_LEASE_MS}) AS paths
  `)
  const allowed = begin.rows[0]?.paths ?? []
  if (allowed.length === 0)
    return 0
  const startWindowEnd = leaseStartedAt + DELTA_GC_DELETE_START_WINDOW_MS
  let deleted = 0
  try {
    await forEachBounded(allowed, DELTA_GC_DELETE_CONCURRENCY, () => Date.now() < startWindowEnd, async (path) => {
      if (await s3.deleteObjectKey(c, path, DELTA_GC_DELETE_TIMEOUT_MS))
        deleted++
    })
  }
  finally {
    await db.execute(sql`SELECT public.delta_gc_end_delete(${appId})`)
  }
  if (deleted < allowed.length)
    cloudlog({ requestId: c.get('requestId'), message: 'delta gc deletes left for the next pass', appId, allowed: allowed.length, deleted })
  return deleted
}

async function collectAppPage(c: Context, db: Database, app: ClaimedApp, deadline: number) {
  const { objects, nextToken } = await s3.listObjectPage(c, deltaPrefix(app.owner_org, app.app_id), app.list_cursor, DELTA_GC_LIST_PAGE_SIZE)
  const candidates = await unreferencedPaths(db, selectAgedKeys(objects, Date.now()))
  let deleted = 0
  let processed = 0
  while (processed < candidates.length && Date.now() < deadline) {
    deleted += await trashBatch(c, db, app.app_id, candidates.slice(processed, processed + DELTA_GC_DELETE_BATCH), deadline)
    processed += DELTA_GC_DELETE_BATCH
  }

  // A page cut short by the run budget is listed again from the same token.
  const nextCursor = processed >= candidates.length ? nextToken : app.list_cursor
  return { listed: objects.length, candidates: candidates.length, deleted, nextCursor }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const startedAt = Date.now()
  const deadline = startedAt + DELTA_GC_BUDGET_MS
  const pool = await getPgClient(c, false)
  try {
    const db = getDrizzleClient(pool)
    const claimed = await db.execute<ClaimedApp>(sql`SELECT * FROM public.delta_gc_claim(${DELTA_GC_APPS_PER_RUN})`)
    for (const claimedApp of claimed.rows) {
      if (Date.now() >= deadline)
        break
      try {
        const page = await collectAppPage(c, db, claimedApp, deadline)
        await db.execute(sql`SELECT public.delta_gc_finish(${claimedApp.app_id}, ${page.nextCursor}, NULL)`)
        cloudlog({ requestId: c.get('requestId'), message: 'delta gc page done', appId: claimedApp.app_id, ...page })
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'delta gc app failed', appId: claimedApp.app_id, error })
        // Restart the listing on the next pass: continuation tokens are not durable.
        await db.execute(sql`SELECT public.delta_gc_finish(${claimedApp.app_id}, NULL, ${error instanceof Error ? error.message : 'unknown error'})`)
      }
    }
    cloudlog({ requestId: c.get('requestId'), message: 'delta gc run done', apps: claimed.rows.length, durationMs: Date.now() - startedAt })
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pool)
  }
})
