import type { ClientBase } from 'pg'
import type { InventoryConfig, InventoryRow, ObjectObservation, ObservationSnapshot } from '../../supabase/functions/_backend/utils/r2_inventory.ts'
import { Buffer } from 'node:buffer'
import { applyObservations, INVENTORY_ROW_COLUMNS, inventoryTransaction } from '../../supabase/functions/_backend/utils/r2_inventory.ts'

export interface ListPage { objects: ObjectObservation[], truncated: boolean, token?: string }
export interface ListRequest { prefix: string, startAfter?: string, token?: string }
export type ListObjects = (request: ListRequest) => Promise<ListPage>
export interface ScanOptions { bucket: string, prefix: string, job: string, mode: 'backfill' | 'reconcile', write: boolean, maxPages: number, intervalMs: number }
export interface ScanProgress { lastKey: string, token?: string, pages: number, objects: number, skipped: number, complete: boolean }
export const EMPTY_PROGRESS: ScanProgress = { lastKey: '', pages: 0, objects: 0, skipped: 0, complete: false }
const byteLength = (value: string) => Buffer.byteLength(value)
export function compareKeys(a: string, b: string) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}
export function prefixUpperBound(prefix: string): string | null {
  const points = [...prefix].map(char => char.codePointAt(0)!)
  while (points.length) {
    const last = points.pop()!
    if (last < 0x10FFFF) {
      const next = last + 1 === 0xD800 ? 0xE000 : last + 1
      return String.fromCodePoint(...points, next)
    }
  }
  return null
}
export function validatePage(page: ListPage, request: ListRequest): void {
  if (page.objects.length > 1000 || (page.truncated && (!page.objects.length || !page.token)))
    throw new Error('Invalid or non-progressing R2 LIST page')
  let previous = request.startAfter ?? ''
  for (const object of page.objects) {
    if (!object.key.startsWith(request.prefix) || byteLength(object.key) < 1 || byteLength(object.key) > 1024
      || compareKeys(object.key, previous) <= 0 || !Number.isSafeInteger(object.size) || object.size < 0
      || !object.etag || object.etag.length > 256 || !Number.isFinite(Date.parse(object.lastModified))) {
      throw new Error('Invalid R2 LIST object or ordering')
    }
    previous = object.key
  }
}
function checkpointIdentity(options: ScanOptions) {
  if (!options.bucket || byteLength(options.bucket) > 256 || byteLength(options.prefix) > 1024 || !/^[a-z0-9_-]{1,64}$/.test(options.job)
    || !Number.isInteger(options.maxPages) || options.maxPages < 1 || !Number.isInteger(options.intervalMs) || options.intervalMs < 1000) {
    throw new Error('Invalid inventory scan options')
  }
  return [options.bucket, `${options.mode}:${options.job}`, options.prefix]
}
export async function loadProgress(db: ClientBase, options: ScanOptions): Promise<ScanProgress> {
  const identity = checkpointIdentity(options)
  const result = await db.query<{ checkpoint: ScanProgress }>(`SELECT checkpoint FROM public.r2_inventory_checkpoints
    WHERE bucket_name = $1 AND job_name = $2 AND partition_key = $3`, identity)
  const data = result.rows[0]?.checkpoint
  if (!data)
    return { ...EMPTY_PROGRESS }
  if (typeof data.lastKey !== 'string' || (data.lastKey !== '' && !data.lastKey.startsWith(options.prefix))
    || ![data.pages, data.objects, data.skipped].every(value => Number.isSafeInteger(value) && value >= 0)
    || typeof data.complete !== 'boolean' || (data.token !== undefined && typeof data.token !== 'string')) {
    throw new Error('Invalid persisted inventory checkpoint')
  }
  return data
}
export async function checkpointTransaction<T>(db: ClientBase, options: ScanOptions, previous: ScanProgress, next: ScanProgress, operation: () => Promise<T>): Promise<T> {
  const identity = checkpointIdentity(options)
  return inventoryTransaction(db, async () => {
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, partition_key, checkpoint)
      VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`, [...identity, JSON.stringify(EMPTY_PROGRESS)])
    const lock = await db.query<{ matches: boolean }>(`SELECT checkpoint = $4::jsonb AS matches FROM public.r2_inventory_checkpoints
      WHERE bucket_name = $1 AND job_name = $2 AND partition_key = $3 FOR UPDATE`, [...identity, JSON.stringify(previous)])
    if (!lock.rows[0]?.matches)
      throw new Error('Checkpoint advanced in another scanner; resume from committed progress')
    const result = await operation()
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint = $4::jsonb
      WHERE bucket_name = $1 AND job_name = $2 AND partition_key = $3`, [...identity, JSON.stringify(next)])
    return result
  })
}
export async function restartCompletedScan(db: ClientBase, options: ScanOptions): Promise<void> {
  const previous = await loadProgress(db, options)
  if (!previous.complete)
    throw new Error('Only a completed scan can restart; resume incomplete scans normally')
  await checkpointTransaction(db, options, previous, { ...EMPTY_PROGRESS }, async () => {})
}

export async function requestStartedAt(db: ClientBase): Promise<string> {
  const result = await db.query<{ started_at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at`)
  return result.rows[0].started_at
}
export async function commitBackfillPage(db: ClientBase, options: ScanOptions, previous: ScanProgress, page: ListPage, startedAt: string): Promise<ScanProgress> {
  if (Date.now() - Date.parse(startedAt) > 120_000)
    throw new Error('Backfill observation expired; rerun to read a fresh page')
  const next: ScanProgress = { ...previous, lastKey: page.objects.at(-1)?.key ?? previous.lastKey, token: page.truncated ? page.token : undefined, pages: previous.pages + 1, objects: previous.objects + page.objects.length, complete: !page.truncated }
  if (options.write) {
    await checkpointTransaction(db, options, previous, next, async () => {
      await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state, size_bytes, etag, r2_last_modified_at, last_reconciled_at)
        SELECT $1, key, 'present', size, etag, "lastModified"::timestamptz, $3::timestamptz
        FROM jsonb_to_recordset($2::jsonb) AS x(key text, size bigint, etag text, "lastModified" text)
        ORDER BY key COLLATE "C" ON CONFLICT DO NOTHING`, [options.bucket, JSON.stringify(page.objects), startedAt])
    })
  }
  return next
}
export async function readRangeSnapshot(db: ClientBase, options: ScanOptions, lastKey: string): Promise<ObservationSnapshot> {
  const startedAt = await requestStartedAt(db)
  const upper = prefixUpperBound(options.prefix)
  const result = await db.query<InventoryRow>(`SELECT ${INVENTORY_ROW_COLUMNS} FROM public.r2_objects
    WHERE bucket_name = $1 AND r2_key > $2 AND r2_key >= $3 ${upper === null ? '' : 'AND r2_key < $4'}
    ORDER BY r2_key COLLATE "C" LIMIT 1000`, upper === null ? [options.bucket, lastKey, options.prefix] : [options.bucket, lastKey, options.prefix, upper])
  return { startedAt, rows: result.rows }
}
export function reconcileRange(snapshot: ObservationSnapshot, page: ListPage) {
  const databaseUpper = snapshot.rows.at(-1)?.r2_key
  const providerUpper = page.truncated ? page.objects.at(-1)!.key : undefined
  const upper = databaseUpper && providerUpper
    ? (compareKeys(databaseUpper, providerUpper) <= 0 ? databaseUpper : providerUpper)
    : databaseUpper ?? providerUpper
  const objects = page.objects.filter(object => upper === undefined || compareKeys(object.key, upper) <= 0)
  const rows = snapshot.rows.filter(row => upper === undefined || compareKeys(row.r2_key, upper) <= 0)
  const seen = new Set(objects.map(object => object.key))
  // Absence is inferred only within the fully covered LIST range. A truncated
  // page never says anything about keys beyond its last returned key.
  const missing = rows.filter(row => (row.r2_state === 'present' || row.r2_state === 'to_be_deleted') && !seen.has(row.r2_key))
  return { upper, snapshot: { ...snapshot, rows }, observations: [
    ...objects.map(object => ({ key: object.key, object })),
    ...missing.map(row => ({ key: row.r2_key, object: null })),
  ], complete: databaseUpper === undefined && !page.truncated }
}

export async function listWithCursorFallback(list: ListObjects, request: ListRequest): Promise<ListPage> {
  try {
    return await list(request)
  }
  catch (error) {
    const code = (error as { name?: string, Code?: string }).Code ?? (error as { name?: string }).name
    if (!request.token || !['InvalidArgument', 'InvalidToken', 'InvalidContinuationToken'].includes(code ?? ''))
      throw error
    return list({ prefix: request.prefix, startAfter: request.startAfter })
  }
}

export class InventoryScanFailure extends Error {
  constructor(public progress: ScanProgress, public keys: string[], public originalError: unknown) {
    super('Inventory page failed; resume from the last committed checkpoint')
  }
}

export async function scanInventory(db: ClientBase, list: ListObjects, options: ScanOptions, config: InventoryConfig, onProgress: (progress: ScanProgress) => void = () => {}, stopping: () => boolean = () => false): Promise<ScanProgress> {
  let progress = await loadProgress(db, options)
  for (let pageNumber = 0; !progress.complete && pageNumber < options.maxPages && !stopping(); pageNumber++) {
    const start = Date.now()
    let observedKeys: string[] = []
    try {
      if (options.mode === 'backfill') {
        const startedAt = await requestStartedAt(db)
        const request = { prefix: options.prefix, startAfter: progress.lastKey || undefined, token: progress.token }
        const page = await listWithCursorFallback(list, request)
        observedKeys = page.objects.slice(0, 1000).map(object => object.key)
        validatePage(page, request)
        progress = await commitBackfillPage(db, options, progress, page, startedAt)
      }
      else {
        const snapshot = await readRangeSnapshot(db, options, progress.lastKey)
        const request = { prefix: options.prefix, startAfter: progress.lastKey || undefined }
        const page = await list(request)
        observedKeys = page.objects.slice(0, 1000).map(object => object.key)
        validatePage(page, request)
        const range = reconcileRange(snapshot, page)
        const next = { ...progress, lastKey: range.upper ?? page.objects.at(-1)?.key ?? progress.lastKey, pages: progress.pages + 1, objects: progress.objects + range.observations.length, complete: range.complete }
        if (options.write) {
          await checkpointTransaction(db, options, progress, next, async () => {
            for (let offset = 0; offset < range.observations.length; offset += 1000) {
              const skipped = await applyObservations(db, options.bucket, range.snapshot, range.observations.slice(offset, offset + 1000), config, true)
              next.skipped += skipped.length
            }
          })
        }
        progress = next
      }
      onProgress(progress)
    }
    catch (error) {
      throw new InventoryScanFailure(progress, observedKeys, error)
    }
    const remaining = options.intervalMs - (Date.now() - start)
    if (remaining > 0 && !progress.complete && pageNumber + 1 < options.maxPages && !stopping())
      await new Promise(resolve => setTimeout(resolve, remaining))
  }
  return progress
}

export async function collectInventoryTombstones(db: ClientBase, bucket: string, job: string, config: InventoryConfig): Promise<number> {
  if (!/^[a-z0-9_-]{1,64}$/.test(job))
    throw new Error('Invalid inventory checkpoint job')
  return inventoryTransaction(db, async () => {
    const prerequisites = await db.query<{ job_name: string }>(`SELECT job_name FROM public.r2_inventory_checkpoints
      WHERE bucket_name = $1 AND partition_key = '' AND job_name = ANY($2::text[])
      AND checkpoint ->> 'complete' = 'true' AND coalesce((checkpoint ->> 'skipped')::bigint, 0) = 0`, [bucket, [`backfill:${job}`, `reconcile:${job}`]])
    if (prerequisites.rows.length !== 2)
      throw new Error('Tombstone collection requires completed full-bucket backfill and reconciliation without skipped observations')
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, accepted_event_floor)
      VALUES ($1, 'admission', now() - $2::int * interval '1 day') ON CONFLICT DO NOTHING`, [bucket, config.tombstoneDays])
    // Exclusive row lock waits for event transactions holding FOR SHARE. Advancing
    // the floor and deleting expired history are one transaction.
    await db.query(`UPDATE public.r2_inventory_checkpoints SET accepted_event_floor = greatest(accepted_event_floor, now() - $2::int * interval '1 day')
      WHERE bucket_name = $1 AND job_name = 'admission' AND partition_key = ''`, [bucket, config.tombstoneDays])
    const deleted = await db.query(`WITH candidates AS (
      SELECT object.bucket_name, object.r2_key FROM public.r2_objects AS object
      JOIN public.r2_inventory_checkpoints AS admission ON admission.bucket_name = object.bucket_name AND admission.job_name = 'admission' AND admission.partition_key = ''
      WHERE object.bucket_name = $1 AND object.r2_state = 'deleted' AND object.tombstone_expires_at < now()
      AND (object.last_event_at IS NULL OR object.last_event_at < admission.accepted_event_floor)
      AND (object.last_reconciled_at IS NULL OR object.last_reconciled_at < admission.accepted_event_floor)
      ORDER BY object.tombstone_expires_at, object.r2_key LIMIT 1000 FOR UPDATE OF object SKIP LOCKED
    ) DELETE FROM public.r2_objects AS target USING candidates WHERE target.bucket_name = candidates.bucket_name AND target.r2_key = candidates.r2_key`, [bucket])
    return deleted.rowCount ?? 0
  })
}
