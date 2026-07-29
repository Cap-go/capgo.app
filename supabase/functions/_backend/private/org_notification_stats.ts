import { sql } from 'drizzle-orm'
import { createHono, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import {
  MAX_ORG_NOTIFICATION_STATS_APPS,
  readNotificationStatsCF,
} from '../utils/nativeNotifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'
import { version } from '../utils/version.ts'

interface OrgNotificationStatsBody {
  org_id?: string
  days?: number
}

export const app = createHono('private/org_notification_stats', version)
app.use('*', useCors)

async function readOrgNotificationOverview(c: Parameters<typeof getPgClient>[0], orgId: string) {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c, true)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM public.notification_campaigns WHERE owner_org = ${orgId}) AS campaigns,
        (SELECT COUNT(*)::int FROM public.notification_provider_configs WHERE owner_org = ${orgId} AND status = 'configured') AS configured_providers,
        COALESCE(
          (
            SELECT array_agg(app_id ORDER BY app_id)
            FROM public.apps
            WHERE owner_org = ${orgId}
          ),
          '{}'::text[]
        ) AS app_ids
    `)
    const row = (result.rows[0] ?? {}) as {
      campaigns?: number
      configured_providers?: number
      app_ids?: string[] | null
    }
    const appIds = Array.isArray(row.app_ids) ? row.app_ids.filter(Boolean) : []
    return {
      apps: appIds.length,
      campaigns: Number(row.campaigns ?? 0),
      configured_providers: Number(row.configured_providers ?? 0),
      appIds,
    }
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<OrgNotificationStatsBody>(c)
  if (!body.org_id)
    throw simpleError('missing_params', 'org_id is required')
  const orgId = body.org_id.trim()
  if (!orgId || orgId.length > 64)
    throw simpleError('invalid_body', 'Invalid body', { field: 'org_id' })
  if (!(await checkPermission(c, 'org.read', { orgId })))
    throw quickError(403, 'org_access_denied', 'You can\'t access this organization', { org_id: orgId })

  const rawDays = Number(body.days ?? 30)
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 1), 92) : 30

  const overview = await readOrgNotificationOverview(c, orgId)
  const totals = new Map<string, number>()
  try {
    for (let i = 0; i < overview.appIds.length; i += MAX_ORG_NOTIFICATION_STATS_APPS) {
      const appIds = overview.appIds.slice(i, i + MAX_ORG_NOTIFICATION_STATS_APPS)
      if (!appIds.length)
        continue
      const rows = await readNotificationStatsCF(c, { appIds, days, throwOnError: true })
      for (const row of rows) {
        const event = String(row.event || '')
        if (!event)
          continue
        totals.set(event, (totals.get(event) ?? 0) + Number(row.count || 0))
      }
    }
  }
  catch (error) {
    throw quickError(503, 'notification_stats_unavailable', 'Failed to load organization notification stats', { org_id: orgId }, error)
  }

  const data = [...totals.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count)
  const totalEvents = data.reduce((sum, item) => sum + Number(item.count || 0), 0)
  return c.json({
    data,
    overview: {
      apps: overview.apps,
      apps_queried: overview.appIds.length,
      campaigns: overview.campaigns,
      configured_providers: overview.configured_providers,
      total_events: totalEvents,
    },
  })
})
