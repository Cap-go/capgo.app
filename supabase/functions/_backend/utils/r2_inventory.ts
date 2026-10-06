import type { ClientBase } from 'pg'
import { cloudlogErr } from './logging.ts'

export type InventoryState = 'to_be_uploaded' | 'present' | 'to_be_deleted' | 'deleted'
export interface InventoryEvent {
  bucket: string
  key: string
  state: 'present' | 'deleted'
  eventTime: string
  size: number | null
  etag: string | null
}
export interface RepairTask { bucket: string, key: string, kind: 'verify' }
export interface InventoryConfig { readonly tombstoneDays: number }
export const INVENTORY_CONFIG: InventoryConfig = Object.freeze({ tombstoneDays: 7 })
const encoder = new TextEncoder()
const createActions = new Set(['PutObject', 'CopyObject', 'CompleteMultipartUpload'])
const deleteActions = new Set(['DeleteObject', 'LifecycleDeletion'])
export const OBSERVATION_MARGIN_US = 5_000_000n

export function timestampUs(value: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value))
    throw new Error('Invalid R2 eventTime')
  const millis = Date.parse(value)
  if (!Number.isFinite(millis) || value.startsWith('0000-') || new Date(millis).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('Invalid R2 eventTime')
  const fraction = value.match(/\.(\d+)Z$/)?.[1] ?? ''
  return BigInt(Math.floor(millis / 1000)) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

export function normalizeEtag(value: string): string {
  return value.replace(/^"|"$/g, '')
}

export function parseInventoryEvent(body: unknown, bucket: string): InventoryEvent {
  if (!body || typeof body !== 'object')
    throw new Error('Invalid R2 notification')
  const data = body as Record<string, unknown>
  const object = data.object as Record<string, unknown> | undefined
  if (data.bucket !== bucket || !object || typeof object.key !== 'string'
    || object.key.includes('\0') || encoder.encode(object.key).length < 1 || encoder.encode(object.key).length > 1024
    || typeof data.eventTime !== 'string' || typeof data.action !== 'string') {
    throw new Error('Invalid R2 notification identity')
  }
  timestampUs(data.eventTime)
  const state = createActions.has(data.action) ? 'present' : deleteActions.has(data.action) ? 'deleted' : null
  if (!state)
    throw new Error('Unsupported R2 notification action')
  if (state === 'present' && (!Number.isSafeInteger(object.size) || Number(object.size) < 0
    || typeof object.eTag !== 'string' || object.eTag.includes('\0') || object.eTag.length > 256)) {
    throw new Error('Invalid R2 creation metadata')
  }
  return {
    bucket,
    key: object.key,
    state,
    eventTime: data.eventTime,
    size: state === 'present' ? Number(object.size) : null,
    etag: state === 'present' ? normalizeEtag(String(object.eTag)) : null,
  }
}

export async function inventoryTransaction<T>(db: ClientBase, operation: () => Promise<T>): Promise<T> {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL statement_timeout = '10s'`)
    await db.query(`SET LOCAL lock_timeout = '5s'`)
    const result = await operation()
    await db.query('COMMIT')
    return result
  }
  catch (error) {
    await db.query('ROLLBACK').catch((rollbackError) => {
      cloudlogErr({ event: 'r2_inventory_rollback_failed', error: rollbackError instanceof Error ? rollbackError.message : 'Unknown error' })
    })
    throw error
  }
}

export interface InventoryRow {
  r2_key: string
  r2_state: InventoryState
  size_bytes: string | null
  etag: string | null
  revision: string
  cleanup_requested_at: string | null
  event_us: string | null
  reconciled_us: string | null
  first_seen_us: string
}
export const INVENTORY_ROW_COLUMNS = `r2_key, r2_state, size_bytes, etag, revision, cleanup_requested_at,
  (extract(epoch FROM last_event_at) * 1000000)::bigint::text AS event_us,
  (extract(epoch FROM last_reconciled_at) * 1000000)::bigint::text AS reconciled_us,
  (extract(epoch FROM first_seen_at) * 1000000)::bigint::text AS first_seen_us`

function sameFacts(row: InventoryRow, event: InventoryEvent) {
  return event.state === 'deleted'
    ? row.r2_state === 'deleted'
    : row.r2_state !== 'deleted' && row.size_bytes !== null
      && BigInt(row.size_bytes) === BigInt(event.size!) && row.etag === event.etag
}

// At most 100 events, one transaction, and a fixed number of SQL statements.
// Existing rows are locked in key order; missing inserts use ON CONFLICT DO NOTHING.
// No provider I/O or queue publication occurs while the connection is held.
export async function applyInventoryEvents(db: ClientBase, events: InventoryEvent[], config: InventoryConfig): Promise<RepairTask[]> {
  if (events.length > 100)
    throw new Error('Inventory batch exceeds 100 events')
  if (!events.length)
    return []
  const bucket = events[0].bucket
  if (events.some(event => event.bucket !== bucket))
    throw new Error('Inventory batches must have one bucket')
  const groups = new Map<string, InventoryEvent[]>()
  for (const event of events) {
    const previous = groups.get(event.key)
    const time = timestampUs(event.eventTime)
    const previousTime = previous ? timestampUs(previous[0].eventTime) : null
    if (previousTime === null || time > previousTime)
      groups.set(event.key, [event])
    else if (time === previousTime && !previous!.some(item => item.state === event.state && item.size === event.size && item.etag === event.etag))
      previous!.push(event)
  }
  return inventoryTransaction(db, async () => {
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, accepted_event_floor)
      VALUES ($1, 'admission', now() - $2::int * interval '1 day') ON CONFLICT DO NOTHING`, [bucket, config.tombstoneDays])
    const admission = await db.query<{ floor_us: string, now_us: string }>(`SELECT
      (extract(epoch FROM greatest(accepted_event_floor, now() - $2::int * interval '1 day')) * 1000000)::bigint::text AS floor_us,
      (extract(epoch FROM now()) * 1000000)::bigint::text AS now_us
      FROM public.r2_inventory_checkpoints WHERE bucket_name = $1 AND job_name = 'admission' AND partition_key = '' FOR SHARE`, [bucket, config.tombstoneDays])
    const floor = BigInt(admission.rows[0].floor_us)
    const future = BigInt(admission.rows[0].now_us) + OBSERVATION_MARGIN_US
    const unambiguous = [...groups.values()].filter(group => group.length === 1).map(group => group[0])
    const fresh = unambiguous.filter(event => timestampUs(event.eventTime) >= floor && timestampUs(event.eventTime) <= future)
    await db.query(`INSERT INTO public.r2_objects (bucket_name, r2_key, r2_state, size_bytes, etag, last_event_at, tombstone_expires_at)
      SELECT $1, key, state::public.r2_object_state, size, etag, "eventTime"::timestamptz,
        CASE WHEN state = 'deleted' THEN now() + $3::int * interval '1 day' END
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, state text, size bigint, etag text, "eventTime" text)
      ORDER BY key COLLATE "C" ON CONFLICT DO NOTHING`, [bucket, JSON.stringify(fresh), config.tombstoneDays])
    const existing = await db.query<InventoryRow>(`SELECT ${INVENTORY_ROW_COLUMNS} FROM public.r2_objects
      WHERE bucket_name = $1 AND r2_key = ANY($2::text[]) ORDER BY r2_key COLLATE "C" FOR UPDATE`, [bucket, [...groups.keys()]])
    const rows = new Map(existing.rows.map(row => [row.r2_key, row]))
    const repairs: RepairTask[] = []
    const updates: InventoryEvent[] = []
    for (const [key, group] of groups) {
      const event = group[0]
      const time = timestampUs(event.eventTime)
      const row = rows.get(key)
      const last = row?.event_us ? BigInt(row.event_us) : null
      const observed = row?.reconciled_us ? BigInt(row.reconciled_us) : null
      if (last !== null && time < last)
        continue
      if (observed !== null && time < observed - OBSERVATION_MARGIN_US)
        continue
      if (time > future || group.length > 1 || (time < floor && !(last !== null && last >= time))) {
        repairs.push({ bucket, key, kind: 'verify' })
        continue
      }
      if (last === time) {
        if (!row || !sameFacts(row, event))
          repairs.push({ bucket, key, kind: 'verify' })
        continue
      }
      if (observed !== null && time <= observed + OBSERVATION_MARGIN_US) {
        if (!row || !sameFacts(row, event))
          repairs.push({ bucket, key, kind: 'verify' })
        continue
      }
      if (row)
        updates.push(event)
    }
    await db.query(`UPDATE public.r2_objects AS target SET
      r2_state = CASE WHEN (target.r2_state = 'to_be_deleted' OR target.cleanup_requested_at IS NOT NULL) AND x.state = 'present'
        THEN 'to_be_deleted'::public.r2_object_state ELSE x.state::public.r2_object_state END,
      size_bytes = CASE WHEN x.state = 'present' THEN x.size ELSE target.size_bytes END,
      etag = CASE WHEN x.state = 'present' THEN x.etag ELSE target.etag END,
      r2_last_modified_at = CASE WHEN x.state = 'present' THEN NULL ELSE target.r2_last_modified_at END,
      last_event_at = x."eventTime"::timestamptz,
      tombstone_expires_at = CASE WHEN x.state = 'deleted' THEN now() + $3::int * interval '1 day' END
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, state text, size bigint, etag text, "eventTime" text)
      WHERE target.bucket_name = $1 AND target.r2_key = x.key`, [bucket, JSON.stringify(updates), config.tombstoneDays])
    return repairs
  })
}

export interface ObjectObservation { key: string, size: number, etag: string, lastModified: string }
export interface ObservationSnapshot { rows: InventoryRow[], startedAt: string }
export async function readObservationSnapshot(db: ClientBase, bucket: string, keys: string[]): Promise<ObservationSnapshot> {
  if (keys.length > 1000)
    throw new Error('Observation exceeds 1000 keys')
  const started = await db.query<{ started_at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at`)
  const result = await db.query<InventoryRow>(`SELECT ${INVENTORY_ROW_COLUMNS} FROM public.r2_objects WHERE bucket_name = $1 AND r2_key = ANY($2::text[])`, [bucket, keys])
  return { rows: result.rows, startedAt: started.rows[0].started_at }
}

// Compare revisions captured before the R2 request; never overwrite a concurrent event.
export async function applyObservations(db: ClientBase, bucket: string, snapshot: ObservationSnapshot, observations: { key: string, object: ObjectObservation | null }[], config: InventoryConfig, alreadyInTransaction = false): Promise<string[]> {
  if (observations.length > 1000 || Date.now() - Date.parse(snapshot.startedAt) > 120_000)
    throw new Error('Observation expired or exceeded its bound')
  const previous = new Map(snapshot.rows.map(row => [row.r2_key, row]))
  const input = observations.map(item => ({
    key: item.key,
    present: item.object !== null,
    size: item.object?.size ?? null,
    etag: item.object?.etag ?? null,
    modified: item.object?.lastModified ?? null,
    revision: previous.get(item.key)?.revision ?? null,
    firstSeenUs: previous.get(item.key)?.first_seen_us ?? null,
  }))
  const operation = async () => {
    const applied = await db.query<{ r2_key: string }>(`INSERT INTO public.r2_objects AS target
      (bucket_name, r2_key, r2_state, size_bytes, etag, r2_last_modified_at, last_reconciled_at, tombstone_expires_at)
      SELECT $1, key, CASE WHEN present THEN 'present' ELSE 'deleted' END::public.r2_object_state,
        size, etag, modified::timestamptz, $3::timestamptz,
        CASE WHEN NOT present THEN now() + $4::int * interval '1 day' END
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, present boolean, size bigint, etag text, modified text, revision bigint, "firstSeenUs" bigint)
      WHERE revision IS NULL ORDER BY key COLLATE "C" ON CONFLICT DO NOTHING RETURNING r2_key`, [bucket, JSON.stringify(input), snapshot.startedAt, config.tombstoneDays])
    const updated = await db.query<{ r2_key: string }>(`UPDATE public.r2_objects AS target SET
      r2_state = CASE WHEN (target.r2_state = 'to_be_deleted' OR target.cleanup_requested_at IS NOT NULL) AND x.present THEN 'to_be_deleted'::public.r2_object_state
        WHEN target.r2_state = 'to_be_uploaded' AND NOT x.present THEN target.r2_state
        ELSE CASE WHEN x.present THEN 'present' ELSE 'deleted' END::public.r2_object_state END,
      size_bytes = CASE WHEN x.present THEN x.size ELSE target.size_bytes END,
      etag = CASE WHEN x.present THEN x.etag ELSE target.etag END,
      r2_last_modified_at = CASE WHEN x.present THEN x.modified::timestamptz ELSE target.r2_last_modified_at END,
      last_reconciled_at = $3::timestamptz,
      tombstone_expires_at = CASE WHEN NOT x.present AND target.r2_state <> 'to_be_uploaded'
        THEN coalesce(target.tombstone_expires_at, now() + $4::int * interval '1 day') END
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, present boolean, size bigint, etag text, modified text, revision bigint, "firstSeenUs" bigint)
      WHERE target.bucket_name = $1 AND target.r2_key = x.key AND target.revision = x.revision AND (extract(epoch FROM target.first_seen_at) * 1000000)::bigint = x."firstSeenUs"
      RETURNING target.r2_key`, [bucket, JSON.stringify(input), snapshot.startedAt, config.tombstoneDays])
    const keys = new Set([...applied.rows, ...updated.rows].map(row => row.r2_key))
    return observations.filter(item => !keys.has(item.key)).map(item => item.key)
  }
  return alreadyInTransaction ? operation() : inventoryTransaction(db, operation)
}
