import type { Context } from 'hono'
import type { ClientBase } from 'pg'
import type { ManifestSizeReceiptFacts } from './manifest_size_receipt.ts'
import type { InventoryRow } from './r2_inventory.ts'
import { getRuntimeKey } from 'hono/adapter'
import { Client } from 'pg'
import { MAX_S3_PATH_LENGTH } from './manifest_limits.ts'
import { INVENTORY_CONFIG, INVENTORY_ROW_COLUMNS, inventoryTransaction, OBSERVATION_MARGIN_US } from './r2_inventory.ts'
import { getEnv } from './utils.ts'

export const RESERVATION_CHUNK_FILES = 100
export const RESERVATION_CANDIDATES = 20
export const RESERVATION_RECHECKS = 2
const encoder = new TextEncoder()

export class ManifestInventoryConflict extends Error {
  constructor(readonly paths: string[]) {
    super('Manifest objects are retired, their reservations are missing or expired, or their evidence conflicts with inventory; request new upload paths')
  }
}

export function usesManifestInventory(c: Context): boolean {
  return c.env?.ENV_NAME === 'capgo_api-prod' || (getRuntimeKey() !== 'workerd' && !!getEnv(c, 'LOCAL_R2_INVENTORY_DB_URL'))
}

// The primary Supabase selector is deliberately never used here.
export async function withManifestInventory<T>(c: Context, operation: (db: Client) => Promise<T>): Promise<T> {
  const url = getRuntimeKey() === 'workerd'
    ? c.env?.HYPERDRIVE_R2_INVENTORY?.connectionString
    : getEnv(c, 'LOCAL_R2_INVENTORY_DB_URL')
  if (!url)
    throw new Error('Independent inventory connection is unavailable')
  const db = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 15000 })
  try {
    await db.connect()
    return await operation(db)
  }
  finally {
    await db.end()
  }
}

export function inventoryCandidatePath(prefix: string, suffix: string, generation: number | string): string {
  const path = `${prefix}${generation === 0 ? '' : `${generation}/`}${suffix}`
  if (path.length > MAX_S3_PATH_LENGTH || encoder.encode(path).length > 1024)
    throw new Error('Manifest inventory path exceeds storage limits')
  return path
}

function usable(row: Pick<InventoryRow, 'r2_state' | 'cleanup_requested_at' | 'size_bytes'> | undefined, size: number): boolean {
  return !row || ((row.r2_state === 'present' || row.r2_state === 'to_be_uploaded') && !row.cleanup_requested_at
    && (row.size_bytes === null || BigInt(row.size_bytes) === BigInt(size)))
}

async function reserveSelected(db: ClientBase, bucket: string, selected: { index: number, key: string, size: number }[]): Promise<Set<string>> {
  if (!selected.length)
    return new Set()
  return inventoryTransaction(db, async () => {
    const result = await db.query<{ r2_key: string }>(`INSERT INTO public.r2_objects AS target
      (bucket_name, r2_key, r2_state, size_bytes, manifest_lease_expires_at)
      SELECT $1, key, 'to_be_uploaded'::public.r2_object_state, size, now() + interval '30 minutes'
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, size bigint) ORDER BY key COLLATE "C"
      ON CONFLICT (bucket_name, r2_key) DO UPDATE SET manifest_lease_expires_at =
        greatest(coalesce(target.manifest_lease_expires_at, now()), now() + interval '30 minutes')
      WHERE target.r2_state IN ('present'::public.r2_object_state, 'to_be_uploaded'::public.r2_object_state)
        AND target.cleanup_requested_at IS NULL AND (target.size_bytes IS NULL OR target.size_bytes = EXCLUDED.size_bytes)
      RETURNING r2_key`, [bucket, JSON.stringify(selected)])
    return new Set(result.rows.map(row => row.r2_key))
  })
}

// Advisory reads are bulk indexed. Only conditional upserts confer a reservation.
export async function reserveManifestPaths(db: ClientBase, bucket: string, prefix: string, suffixes: string[], sizes: number[], uuid: () => string = () => crypto.randomUUID()): Promise<string[]> {
  const output: string[] = []
  for (let offset = 0; offset < suffixes.length; offset += RESERVATION_CHUNK_FILES) {
    let unresolved = suffixes.slice(offset, offset + RESERVATION_CHUNK_FILES).map((suffix, i) => ({ index: offset + i, suffix, size: sizes[offset + i] }))
    for (let attempt = 0; attempt <= RESERVATION_RECHECKS && unresolved.length; attempt++) {
      const candidates = unresolved.map(file => ({ ...file, paths: Array.from({ length: RESERVATION_CANDIDATES }, (_, n) => {
        try {
          return inventoryCandidatePath(prefix, file.suffix, n)
        }
        catch (error) {
          if (n === 0)
            throw error
          return null
        }
      }).filter((path): path is string => path !== null) }))
      const rows = await db.query<InventoryRow>(`SELECT ${INVENTORY_ROW_COLUMNS} FROM public.r2_objects
        WHERE bucket_name = $1 AND r2_key = ANY($2::text[])`, [bucket, candidates.flatMap(file => file.paths)])
      const byKey = new Map(rows.rows.map(row => [row.r2_key, row]))
      const selected = candidates.flatMap((file) => {
        // Prefer reusable objects/reservations over a missing lower generation.
        const key = file.paths.find(key => byKey.has(key) && usable(byKey.get(key), file.size))
          ?? file.paths.find(key => !byKey.has(key))
        return key ? [{ index: file.index, key, size: file.size }] : []
      })
      const accepted = await reserveSelected(db, bucket, selected)
      for (const file of selected) {
        if (accepted.has(file.key))
          output[file.index] = file.key.slice(prefix.length)
      }
      unresolved = unresolved.filter(file => !output[file.index])
      if (!selected.length)
        break
    }
    if (unresolved.length) {
      const fallback = unresolved.map(file => ({ index: file.index, size: file.size, key: inventoryCandidatePath(prefix, file.suffix, uuid()) }))
      const accepted = await reserveSelected(db, bucket, fallback)
      if (fallback.some(file => !accepted.has(file.key)))
        throw new ManifestInventoryConflict(fallback.filter(file => !accepted.has(file.key)).map(file => file.key))
      for (const file of fallback)
        output[file.index] = file.key.slice(prefix.length)
    }
  }
  return output
}

export interface ManifestInventoryEntry { path: string, facts?: ManifestSizeReceiptFacts }

// Millisecond receipt boundaries have lower precision than Postgres event history.
// A safety band also covers local/R2/database clock ambiguity.
function clearlyAfter(evidence: bigint, boundary: string | null): boolean {
  return boundary === null || evidence > BigInt(boundary) + OBSERVATION_MARGIN_US
}

export async function registerManifestInventory(db: ClientBase, bucket: string, entries: ManifestInventoryEntry[]): Promise<void> {
  if (entries.length > 10_000)
    throw new Error('Manifest inventory registration exceeds its bound')
  await inventoryTransaction(db, async () => {
    await db.query(`INSERT INTO public.r2_inventory_checkpoints (bucket_name, job_name, accepted_event_floor)
      VALUES ($1, 'admission', now() - $2::int * interval '1 day') ON CONFLICT DO NOTHING`, [bucket, INVENTORY_CONFIG.tombstoneDays])
    const clock = await db.query<{ now_us: string }>(`SELECT
      (extract(epoch FROM now()) * 1000000)::bigint::text AS now_us
      FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name='admission' AND partition_key='' FOR SHARE`, [bucket])
    const now = BigInt(clock.rows[0].now_us)
    const usableUploadedAt = (value: number | null) => value !== null && BigInt(value) * 1000n <= now + OBSERVATION_MARGIN_US ? value : null
    const rejected: string[] = []
    const unique = new Map<string, ManifestInventoryEntry>()
    for (const entry of entries) {
      // Shared paths must retain the v2 reservation gate even with mixed receipts.
      if (entry.facts?.version === 2 || unique.get(entry.path)?.facts?.version !== 2)
        unique.set(entry.path, entry)
    }
    const ordered = [...unique.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    for (let offset = 0; offset < ordered.length; offset += 500) {
      const chunk = ordered.slice(offset, offset + 500)
      // Lock existing reservations in the same order as retirement. A receipt
      // cannot recreate a missing reservation after placeholder expiry.
      const locked = await db.query<InventoryRow>(`SELECT ${INVENTORY_ROW_COLUMNS} FROM public.r2_objects WHERE bucket_name=$1 AND r2_key=ANY($2::text[]) ORDER BY r2_key COLLATE "C" FOR UPDATE`, [bucket, chunk.map(entry => entry.path)])
      const rows = new Map(locked.rows.map(row => [row.r2_key, row]))
      const updates: { path: string, size: number, etag: string | null, evidence: number, uploaded: number | null, refresh: boolean }[] = []
      for (const entry of chunk) {
        const row = rows.get(entry.path)
        const facts = entry.facts
        if (row && (row.r2_state === 'to_be_deleted' || row.cleanup_requested_at)) {
          rejected.push(entry.path)
          continue
        }
        if (facts?.version !== 2) {
          if (row?.r2_state === 'deleted')
            rejected.push(entry.path)
          continue
        }
        const evidence = BigInt(facts.evidenceAt!) * 1000n
        if (!row || evidence > now + OBSERVATION_MARGIN_US) {
          rejected.push(entry.path)
          continue
        }
        const newer = clearlyAfter(evidence, row.event_us) && clearlyAfter(evidence, row.reconciled_us)
        if ((row.r2_state === 'deleted' || row.r2_state === 'to_be_uploaded') && !newer) {
          rejected.push(entry.path)
          continue
        }
        updates.push({ path: entry.path, size: facts.size, etag: facts.etag, evidence: facts.evidenceAt!, uploaded: usableUploadedAt(facts.uploadedAt), refresh: newer })
      }
      // Check the database clock after acquiring the locks, not transaction-start
      // now(). Expiry and extension are one conditional write; any rejected key
      // rolls back the whole manifest, including previously processed chunks.
      const renewed = await db.query<{ r2_key: string }>(`WITH checked AS MATERIALIZED (SELECT clock_timestamp() AS at)
        UPDATE public.r2_objects AS target SET
        r2_state='present'::public.r2_object_state,
        size_bytes=CASE WHEN x.refresh THEN x.size ELSE target.size_bytes END,
        etag=CASE WHEN x.refresh THEN x.etag ELSE target.etag END,
        last_reconciled_at=CASE WHEN x.refresh THEN greatest(target.last_reconciled_at,to_timestamp(x.evidence / 1000.0)) ELSE target.last_reconciled_at END,
        r2_last_modified_at=CASE WHEN x.refresh THEN greatest(target.r2_last_modified_at,to_timestamp(x.uploaded / 1000.0)) ELSE target.r2_last_modified_at END,
        tombstone_expires_at=NULL,
        manifest_lease_expires_at=greatest(target.manifest_lease_expires_at,checked.at+interval '30 minutes')
        FROM jsonb_to_recordset($2::jsonb) AS x(path text,size bigint,etag text,evidence bigint,uploaded bigint,refresh boolean), checked
        WHERE target.bucket_name=$1 AND target.r2_key=x.path AND target.manifest_lease_expires_at>checked.at
        RETURNING target.r2_key`, [bucket, JSON.stringify(updates)])
      const accepted = new Set(renewed.rows.map(row => row.r2_key))
      rejected.push(...updates.filter(entry => !accepted.has(entry.path)).map(entry => entry.path))
    }
    if (rejected.length)
      throw new ManifestInventoryConflict(rejected)
  })
}
