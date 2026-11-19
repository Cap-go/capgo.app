/**
 * Re-enqueue pgmq jobs for delta_files rows that still have file_size = 0 after a
 * failed on_manifest_create drain. Dry run by default; pass --apply to send messages.
 *
 * SUPABASE_DB_URL=... bun scripts/requeue_unsized_delta_files.ts
 * SUPABASE_DB_URL=... bun scripts/requeue_unsized_delta_files.ts --apply --batch=200
 */
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { Client } from 'pg'

export interface UnsizedDeltaRequeueCursor {
  lastId: string
  done: boolean
}

export const INITIAL_UNSIZED_DELTA_REQUEUE_CURSOR: UnsizedDeltaRequeueCursor = { lastId: '0', done: false }

export interface RequeueUnsizedDeltaBatchOptions {
  apply: boolean
  batchSize: number
  createdAfter?: string
  limit?: number
}

export function buildUnsizedDeltaApplyCheckpointPath(databaseHash: string, createdAfter?: string): string {
  const filterSuffix = createdAfter
    ? `-${createHash('sha256').update(createdAfter).digest('hex').slice(0, 12)}`
    : '-all'
  return join(tmpdir(), `unsized-delta-requeue-apply-${databaseHash.slice(0, 12)}${filterSuffix}.json`)
}

export async function requeueUnsizedDeltaBatch(
  client: Pick<Client, 'query'>,
  cursor: UnsizedDeltaRequeueCursor,
  options: RequeueUnsizedDeltaBatchOptions,
) {
  if (cursor.done)
    return { cursor, scanned: 0, requeued: 0 }

  if (options.limit !== undefined && options.limit <= 0)
    return { cursor, scanned: 0, requeued: 0, limit: 0 }

  const limit = Math.min(options.batchSize, options.limit ?? options.batchSize)
  const rows = await client.query<{ id: string }>(`
    SELECT df.id::text
    FROM public.delta_files AS df
    WHERE df.file_size = 0
      AND df.id > $1::bigint
      ${options.createdAfter ? 'AND df.created_at >= $3::timestamptz' : ''}
    ORDER BY df.id
    LIMIT $2`, options.createdAfter
    ? [cursor.lastId, limit, options.createdAfter]
    : [cursor.lastId, limit])

  if (rows.rows.length === 0)
    return { cursor: { lastId: cursor.lastId, done: true }, scanned: 0, requeued: 0 }

  let requeued = 0
  if (options.apply) {
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL statement_timeout = \'30s\'')
      const sent = await client.query<{ count: string }>(`
        WITH targets AS (
          SELECT df.*
          FROM public.delta_files AS df
          WHERE df.id = ANY($1::bigint[]) AND df.file_size = 0
        ), queued AS (
          SELECT pgmq.send(
            'on_manifest_create',
            pg_catalog.jsonb_build_object(
              'function_name', 'on_manifest_create',
              'function_type', 'cloudflare',
              'payload', pg_catalog.jsonb_build_object(
                'old_record', NULL,
                'record', pg_catalog.to_jsonb(df),
                'type', 'INSERT',
                'table', 'delta_files',
                'schema', 'public'
              )
            )
          ) AS msg_id
          FROM targets AS df
        )
        SELECT count(*)::text AS count FROM queued`, [rows.rows.map(row => row.id)])
      requeued = Number(sent.rows[0]?.count ?? 0)
      await client.query('COMMIT')
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }

  const lastId = rows.rows.at(-1)!.id
  const nextLimit = options.limit === undefined ? undefined : Math.max(0, options.limit - rows.rows.length)
  const done = rows.rows.length < limit
  return {
    cursor: { lastId, done },
    scanned: rows.rows.length,
    requeued,
    ...(nextLimit === undefined ? {} : { limit: nextLimit }),
  }
}

export function parseUnsizedDeltaRequeueArgs(argv = process.argv) {
  const apply = argv.includes('--apply')
  const batchArg = argv.find(arg => arg.startsWith('--batch='))
  const limitArg = argv.find(arg => arg.startsWith('--limit='))
  const createdAfterArg = argv.find(arg => arg.startsWith('--created-after='))
  const batchSize = Number(batchArg?.split('=')[1] ?? 200)
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined
  const createdAfter = createdAfterArg ? createdAfterArg.split('=').slice(1).join('=') : undefined
  if (!Number.isFinite(batchSize) || batchSize <= 0)
    throw new Error('--batch must be a positive number')
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
    throw new Error('--limit must be a positive number')
  if (createdAfterArg !== undefined && !createdAfter)
    throw new Error('--created-after must not be empty')
  return { apply, batchSize, createdAfter, limit }
}

async function main() {
  const databaseUrl = env.SUPABASE_DB_URL
  if (!databaseUrl)
    throw new Error('Set SUPABASE_DB_URL explicitly')

  const options = parseUnsizedDeltaRequeueArgs()
  const database = createHash('sha256').update(databaseUrl).digest('hex')
  const checkpointPath = env.UNSIZED_DELTA_REQUEUE_CHECKPOINT
    ?? buildUnsizedDeltaApplyCheckpointPath(database, options.createdAfter)
  let cursor = INITIAL_UNSIZED_DELTA_REQUEUE_CURSOR
  let limit = options.limit

  if (options.apply) {
    try {
      const saved = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        createdAfter?: string | null
        cursor?: UnsizedDeltaRequeueCursor
        database?: string
      }
      if (saved.database !== database)
        throw new Error('Checkpoint belongs to another database')
      const savedCreatedAfter = saved.createdAfter ?? null
      const currentCreatedAfter = options.createdAfter ?? null
      if (savedCreatedAfter !== currentCreatedAfter)
        throw new Error('Checkpoint filter does not match --created-after')
      if (typeof saved.cursor?.lastId !== 'string' || !/^\d+$/.test(saved.cursor.lastId) || typeof saved.cursor.done !== 'boolean')
        throw new Error('Invalid checkpoint cursor')
      cursor = saved.cursor
    }
    catch (error: unknown) {
      const err = error as { code?: string }
      if (err.code !== 'ENOENT')
        throw error
    }
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query('SET statement_timeout = \'30s\'')
  try {
    while (!cursor.done && (limit === undefined || limit > 0)) {
      const progress = await requeueUnsizedDeltaBatch(client, cursor, {
        apply: options.apply,
        batchSize: options.batchSize,
        createdAfter: options.createdAfter,
        limit,
      })
      cursor = progress.cursor
      if ('limit' in progress && typeof progress.limit === 'number')
        limit = progress.limit
      if (options.apply) {
        await writeFile(`${checkpointPath}.tmp`, JSON.stringify({
          createdAfter: options.createdAfter ?? null,
          cursor,
          database,
        }), { mode: 0o600 })
        await rename(`${checkpointPath}.tmp`, checkpointPath)
      }
      console.log(JSON.stringify({ ...progress, apply: options.apply }))
      if (cursor.done || (typeof limit === 'number' && limit <= 0))
        break
    }
  }
  finally {
    await client.end()
  }
}

if (import.meta.main)
  await main()
