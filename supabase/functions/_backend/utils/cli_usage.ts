import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { checkKey, supabaseAdmin } from './supabase.ts'
import { backgroundTask } from './utils.ts'

export interface CliUsageEvent {
  cli_version: string
  command: string
  node_version: string
  os_platform: string
  apikey_id: string | null
  org_id: string | null
  source: 'config' | 'api' | 'events'
  api_version: string
}

export interface AdminCliUsageStats {
  total: number
  by_version: Record<string, number>
  by_command: Record<string, number>
  by_api_version: Record<string, number>
  by_day: Array<{ date: string, count: number }>
  top_apikeys: Array<{ apikey_id: string, count: number }>
}

function emptyAdminCliUsageStats(): AdminCliUsageStats {
  return {
    total: 0,
    by_version: {},
    by_command: {},
    by_api_version: {},
    by_day: [],
    top_apikeys: [],
  }
}

/**
 * Record CLI usage from request headers.
 * Prefer /private/config only for v1 — avoid hot authenticated private routes.
 */
export function trackCliUsage(c: Context, event: CliUsageEvent) {
  if (!event.cli_version)
    return

  try {
    if (getRuntimeKey() === 'workerd' && c.env.CLI_USAGE) {
      backgroundTask(c, Promise.resolve().then(() => {
        try {
          c.env.CLI_USAGE.writeDataPoint({
            blobs: [
              event.cli_version,
              event.command,
              event.node_version,
              event.os_platform,
              event.apikey_id ?? '',
              event.org_id ?? '',
              event.source,
              event.api_version,
            ],
            indexes: [event.apikey_id || 'anonymous'],
          })
        }
        catch (error) {
          cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage AE write failed', error: serializeError(error) })
        }
      }))
      return
    }

    backgroundTask(c, (async () => {
      const pgClient = getPgClient(c, false)
      try {
        await pgClient.query(
          `INSERT INTO public.cli_usage
            (cli_version, command, node_version, os_platform, apikey_id, org_id, source, api_version)
           VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8)`,
          [
            event.cli_version,
            event.command,
            event.node_version,
            event.os_platform,
            event.apikey_id,
            event.org_id,
            event.source,
            event.api_version,
          ],
        )
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage insert error', error: serializeError(error) })
      }
      finally {
        await closeClient(c, pgClient)
      }
    })())
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackCliUsage error', error: serializeError(error) })
  }
}

export async function resolveCliUsageIdentity(
  c: Context,
  capgkey: string | undefined,
): Promise<{ apikey_id: string | null, org_id: string | null }> {
  if (!capgkey)
    return { apikey_id: null, org_id: null }

  try {
    const apikey = await checkKey(c, capgkey, supabaseAdmin(c))
    if (!apikey)
      return { apikey_id: null, org_id: null }
    return {
      apikey_id: apikey.rbac_id ?? null,
      org_id: null,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'resolveCliUsageIdentity failed', error: serializeError(error) })
    return { apikey_id: null, org_id: null }
  }
}

function rowsToRecord(rows: Array<{ key: string, count: number }>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const key = row.key || 'unknown'
    result[key] = Number(row.count) || 0
  }
  return result
}

async function getAdminCliUsageFromAE(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminCliUsageStats> {
  const timeFilter = `timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')`

  const [totalRows, versionRows, commandRows, apiVersionRows, dayRows, apikeyRows] = await Promise.all([
    runQueryToCFA<{ total: number }>(c, `SELECT count() AS total FROM cli_usage WHERE ${timeFilter}`),
    runQueryToCFA<{ key: string, count: number }>(c, `SELECT blob1 AS key, count() AS count FROM cli_usage WHERE ${timeFilter} GROUP BY key ORDER BY count DESC LIMIT 50`),
    runQueryToCFA<{ key: string, count: number }>(c, `SELECT blob2 AS key, count() AS count FROM cli_usage WHERE ${timeFilter} GROUP BY key ORDER BY count DESC LIMIT 50`),
    runQueryToCFA<{ key: string, count: number }>(c, `SELECT blob8 AS key, count() AS count FROM cli_usage WHERE ${timeFilter} GROUP BY key ORDER BY count DESC LIMIT 50`),
    runQueryToCFA<{ date: string, count: number }>(c, `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date, count() AS count FROM cli_usage WHERE ${timeFilter} GROUP BY date ORDER BY date ASC`),
    runQueryToCFA<{ apikey_id: string, count: number }>(c, `SELECT index1 AS apikey_id, count() AS count FROM cli_usage WHERE ${timeFilter} AND index1 != 'anonymous' GROUP BY apikey_id ORDER BY count DESC LIMIT 20`),
  ])

  return {
    total: Number(totalRows[0]?.total) || 0,
    by_version: rowsToRecord(versionRows),
    by_command: rowsToRecord(commandRows),
    by_api_version: rowsToRecord(apiVersionRows),
    by_day: dayRows.map(row => ({ date: row.date, count: Number(row.count) || 0 })),
    top_apikeys: apikeyRows.map(row => ({
      apikey_id: row.apikey_id || 'unknown',
      count: Number(row.count) || 0,
    })),
  }
}

async function getAdminCliUsageFromPostgres(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminCliUsageStats> {
  const pgClient = getPgClient(c, true)
  try {
    const [totalRes, versionRes, commandRes, apiVersionRes, dayRes, apikeyRes] = await Promise.all([
      pgClient.query<{ total: string }>(
        `SELECT count(*)::bigint AS total FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
        [start_date, end_date],
      ),
      pgClient.query<{ key: string, count: string }>(
        `SELECT coalesce(cli_version, 'unknown') AS key, count(*)::bigint AS count
         FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
         GROUP BY 1 ORDER BY count DESC LIMIT 50`,
        [start_date, end_date],
      ),
      pgClient.query<{ key: string, count: string }>(
        `SELECT coalesce(command, 'unknown') AS key, count(*)::bigint AS count
         FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
         GROUP BY 1 ORDER BY count DESC LIMIT 50`,
        [start_date, end_date],
      ),
      pgClient.query<{ key: string, count: string }>(
        `SELECT coalesce(api_version, 'unknown') AS key, count(*)::bigint AS count
         FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
         GROUP BY 1 ORDER BY count DESC LIMIT 50`,
        [start_date, end_date],
      ),
      pgClient.query<{ date: string, count: string }>(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
                count(*)::bigint AS count
         FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
         GROUP BY 1 ORDER BY 1 ASC`,
        [start_date, end_date],
      ),
      pgClient.query<{ apikey_id: string, count: string }>(
        `SELECT apikey_id::text AS apikey_id, count(*)::bigint AS count
         FROM public.cli_usage
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
           AND apikey_id IS NOT NULL
         GROUP BY 1 ORDER BY count DESC LIMIT 20`,
        [start_date, end_date],
      ),
    ])

    return {
      total: Number(totalRes.rows[0]?.total) || 0,
      by_version: rowsToRecord(versionRes.rows.map(r => ({ key: r.key, count: Number(r.count) }))),
      by_command: rowsToRecord(commandRes.rows.map(r => ({ key: r.key, count: Number(r.count) }))),
      by_api_version: rowsToRecord(apiVersionRes.rows.map(r => ({ key: r.key, count: Number(r.count) }))),
      by_day: dayRes.rows.map(row => ({ date: row.date, count: Number(row.count) || 0 })),
      top_apikeys: apikeyRes.rows.map(row => ({
        apikey_id: row.apikey_id || 'unknown',
        count: Number(row.count) || 0,
      })),
    }
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function getAdminCliUsage(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminCliUsageStats> {
  try {
    if (c.env.CLI_USAGE) {
      return await getAdminCliUsageFromAE(c, start_date, end_date)
    }
    return await getAdminCliUsageFromPostgres(c, start_date, end_date)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getAdminCliUsage failed', error: serializeError(error) })
    return emptyAdminCliUsageStats()
  }
}
