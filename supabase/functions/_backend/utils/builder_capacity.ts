import type { Context } from 'hono'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

export interface BuilderCapacityEvent {
  created_at: number
  workers_total: number
  delta: number
}

const CAPACITY_ADVISORY_LOCK_KEY = 874_201_903

export function msFromBuilderTimestamp(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return null
  return Math.trunc(value)
}

export function isoFromBuilderTimestamp(value: number | null | undefined): string | null {
  const ms = msFromBuilderTimestamp(value)
  if (ms === null)
    return null
  return new Date(ms).toISOString()
}

export async function recordBuilderCapacityIfChanged(
  c: Context,
  workersTotal: number,
  source = 'sync',
): Promise<BuilderCapacityEvent | null> {
  const total = Math.max(0, Math.trunc(workersTotal))
  const client = getPgClient(c)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_ADVISORY_LOCK_KEY])

    const { rows: latestRows } = await client.query<{ workers_total: number }>(
      `SELECT workers_total
       FROM public.builder_capacity_events
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    const previous = latestRows[0]?.workers_total ?? null
    if (previous === total) {
      await client.query('COMMIT')
      return null
    }

    const delta = previous === null ? total : total - previous
    const { rows } = await client.query<{
      created_at: string
      workers_total: number
      delta: number
    }>(
      `INSERT INTO public.builder_capacity_events (workers_total, delta, source)
       VALUES ($1, $2, $3)
       RETURNING created_at, workers_total, delta`,
      [total, delta, source],
    )
    await client.query('COMMIT')

    const inserted = rows[0]
    if (!inserted)
      return null

    cloudlog({
      requestId: c.get('requestId'),
      message: 'builder capacity event recorded',
      workers_total: total,
      delta,
      source,
    })

    return {
      created_at: Date.parse(inserted.created_at),
      workers_total: inserted.workers_total,
      delta: inserted.delta,
    }
  }
  catch (error) {
    try {
      await client.query('ROLLBACK')
    }
    catch {
      // ignore rollback errors
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed recording builder capacity event',
      error: String(error),
    })
    return null
  }
  finally {
    await closeClient(c, client)
  }
}
