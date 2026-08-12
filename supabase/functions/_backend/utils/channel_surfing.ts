import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

export interface AdminChannelSurfingStats {
  total_events: number
  unique_devices: number
  unique_apps: number
  by_day: Array<{ date: string, events: number, devices: number, apps: number }>
  top_apps: Array<{ app_id: string, events: number, devices: number }>
}

function emptyAdminChannelSurfingStats(): AdminChannelSurfingStats {
  return {
    total_events: 0,
    unique_devices: 0,
    unique_apps: 0,
    by_day: [],
    top_apps: [],
  }
}

function usesAppLogAnalytics(c: Context): boolean {
  return getRuntimeKey() === 'workerd' && !!c.env.APP_LOG
}

function appFilterSql(app_id?: string): string {
  return app_id ? `AND index1 = '${escapeSqlString(app_id)}'` : ''
}

async function getAdminChannelSurfingFromAE(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminChannelSurfingStats> {
  const timeFilter = `timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    AND blob2 = 'setChannel'
    ${appFilterSql(app_id)}`

  const [summaryRows, dayRows, appRows] = await Promise.all([
    runQueryToCFA<{ total_events: number, unique_devices: number, unique_apps: number }>(
      c,
      `SELECT
        count() AS total_events,
        COUNT(DISTINCT blob1) AS unique_devices,
        COUNT(DISTINCT index1) AS unique_apps
      FROM app_log
      WHERE ${timeFilter}`,
    ),
    runQueryToCFA<{ date: string, events: number, devices: number, apps: number }>(
      c,
      `SELECT
        formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
        count() AS events,
        COUNT(DISTINCT blob1) AS devices,
        COUNT(DISTINCT index1) AS apps
      FROM app_log
      WHERE ${timeFilter}
      GROUP BY date
      ORDER BY date ASC`,
    ),
    runQueryToCFA<{ app_id: string, events: number, devices: number }>(
      c,
      `SELECT
        index1 AS app_id,
        count() AS events,
        COUNT(DISTINCT blob1) AS devices
      FROM app_log
      WHERE ${timeFilter}
      GROUP BY app_id
      ORDER BY events DESC
      LIMIT 50`,
    ),
  ])

  const summary = summaryRows[0]
  return {
    total_events: Number(summary?.total_events) || 0,
    unique_devices: Number(summary?.unique_devices) || 0,
    unique_apps: Number(summary?.unique_apps) || 0,
    by_day: dayRows.map(row => ({
      date: row.date,
      events: Number(row.events) || 0,
      devices: Number(row.devices) || 0,
      apps: Number(row.apps) || 0,
    })),
    top_apps: appRows.map(row => ({
      app_id: row.app_id || 'unknown',
      events: Number(row.events) || 0,
      devices: Number(row.devices) || 0,
    })),
  }
}

async function getAdminChannelSurfingFromPostgres(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminChannelSurfingStats> {
  const pgClient = getPgClient(c, true)
  try {
    const params: unknown[] = [start_date, end_date]
    let appFilter = ''
    if (app_id) {
      params.push(app_id)
      appFilter = `AND app_id = $${params.length}`
    }

    const [summaryRes, dayRes, appRes] = await Promise.all([
      pgClient.query<{ total_events: string, unique_devices: string, unique_apps: string }>(
        `SELECT
          count(*)::bigint AS total_events,
          count(DISTINCT device_id)::bigint AS unique_devices,
          count(DISTINCT app_id)::bigint AS unique_apps
         FROM public.stats
         WHERE action = 'setChannel'
           AND created_at >= $1::timestamptz
           AND created_at < $2::timestamptz
           ${appFilter}`,
        params,
      ),
      pgClient.query<{ date: string, events: string, devices: string, apps: string }>(
        `SELECT
          to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
          count(*)::bigint AS events,
          count(DISTINCT device_id)::bigint AS devices,
          count(DISTINCT app_id)::bigint AS apps
         FROM public.stats
         WHERE action = 'setChannel'
           AND created_at >= $1::timestamptz
           AND created_at < $2::timestamptz
           ${appFilter}
         GROUP BY 1
         ORDER BY 1 ASC`,
        params,
      ),
      pgClient.query<{ app_id: string, events: string, devices: string }>(
        `SELECT
          app_id,
          count(*)::bigint AS events,
          count(DISTINCT device_id)::bigint AS devices
         FROM public.stats
         WHERE action = 'setChannel'
           AND created_at >= $1::timestamptz
           AND created_at < $2::timestamptz
           ${appFilter}
         GROUP BY app_id
         ORDER BY events DESC
         LIMIT 50`,
        params,
      ),
    ])

    const summary = summaryRes.rows[0]
    return {
      total_events: Number(summary?.total_events) || 0,
      unique_devices: Number(summary?.unique_devices) || 0,
      unique_apps: Number(summary?.unique_apps) || 0,
      by_day: dayRes.rows.map(row => ({
        date: row.date,
        events: Number(row.events) || 0,
        devices: Number(row.devices) || 0,
        apps: Number(row.apps) || 0,
      })),
      top_apps: appRes.rows.map(row => ({
        app_id: row.app_id || 'unknown',
        events: Number(row.events) || 0,
        devices: Number(row.devices) || 0,
      })),
    }
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function getAdminChannelSurfing(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminChannelSurfingStats> {
  try {
    if (usesAppLogAnalytics(c))
      return await getAdminChannelSurfingFromAE(c, start_date, end_date, app_id)
    return await getAdminChannelSurfingFromPostgres(c, start_date, end_date, app_id)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getAdminChannelSurfing failed', error: serializeError(error) })
    return emptyAdminChannelSurfingStats()
  }
}
