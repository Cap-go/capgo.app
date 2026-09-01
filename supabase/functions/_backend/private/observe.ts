import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { ObserveSort, ObserveView } from '../utils/observeQuery.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { nativeObserveActions, readNativeObserveStats } from './native_observe_stats.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import {
  buildObserveFindings,
  buildObserveHandoffPrompt,
  extractRoute,
  groupObserveRoutes,
  isObserveView,
  normalizeObserveDays,
  normalizeObserveLimit,
  normalizeObserveSort,
  OBSERVE_AGENT_INSTRUCTIONS,
  OBSERVE_NAV_CONTRACT,
  OBSERVE_SAMPLE_SCAN_LIMIT,
  sortObserveSamples,
  toObserveSample,
} from '../utils/observeQuery.ts'
import { appIdSchema, deviceIdSchema, hasUnsafeQueryText, safeQueryTextSchema, statsActionSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission } from '../utils/rbac.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { getRollingStatsPeriod } from '../utils/statsPeriod.ts'
import { readStats, readStatsInsights } from '../utils/stats.ts'

const observeBodySchema = z.object({
  appId: appIdSchema.optional(),
  app_id: appIdSchema.optional(),
  view: z.string().optional(),
  days: z.number().optional(),
  action: statsActionSchema.optional(),
  deviceId: deviceIdSchema.optional(),
  versionName: safeQueryTextSchema.optional(),
  sort: z.string().optional(),
  limit: z.number().optional(),
})

const defaultMetricActions = [
  'app_launch_ready',
  'app_launch_timeout',
  'webview_page_loaded',
  'webview_dom_content_loaded',
  'app_nav',
] as const

function resolveAppId(body: { appId?: string, app_id?: string }) {
  return body.appId || body.app_id || ''
}

function periodForDays(days: number) {
  const period = getRollingStatsPeriod(days)
  return {
    requested_days: days,
    start: period.start,
    end: period.endInclusive,
    end_exclusive: period.endExclusive,
    labels: period.labels,
  }
}

async function loadSamples(
  c: Context<MiddlewareKeyVariables>,
  input: {
    appId: string
    start: string
    endExclusive: string
    actions?: string[]
    deviceId?: string
    versionName?: string
    sort: ObserveSort
    limit: number
  },
) {
  const scanLimit = input.sort === 'slowest' || input.sort === 'fastest'
    ? OBSERVE_SAMPLE_SCAN_LIMIT
    : Math.min(OBSERVE_SAMPLE_SCAN_LIMIT, Math.max(input.limit * 10, 100))
  const rows = await readStats(c, {
    app_id: input.appId,
    start_date: input.start,
    end_date: input.endExclusive,
    actions: input.actions,
    deviceIds: input.deviceId ? [input.deviceId] : undefined,
    version_name: input.versionName,
    order: [{ key: 'created_at', sortable: input.sort === 'oldest' ? 'asc' : 'desc' }],
    limit: scanLimit,
  }) as Array<{
    device_id?: string
    action?: string
    version_name?: string
    created_at?: string
    metadata?: Record<string, string> | string | null
  }>

  const samples = sortObserveSamples(rows.map(toObserveSample), input.sort)
  return samples.slice(0, input.limit)
}

function sampleActionsForView(view: ObserveView, action?: string) {
  if (action)
    return [action]
  if (view === 'device')
    return [...nativeObserveActions]
  if (view === 'routes')
    return ['app_nav', 'webview_page_loaded', 'webview_dom_content_loaded']
  return [...defaultMetricActions]
}

function deviceTimelineNext(deviceId?: string) {
  return deviceId
    ? { view: 'device' as const, deviceId }
    : { view: 'summary' as const }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const bodyRaw = await parseBody<Record<string, unknown>>(c)
  const parsed = safeParseSchema(observeBodySchema, bodyRaw)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })

  const body = parsed.data
  const appId = resolveAppId(body)
  if (!appId || hasUnsafeQueryText(appId) || hasUnsafeQueryText(body.versionName))
    throw simpleError('missing_params', 'appId is required')

  const viewValue = body.view ?? 'summary'
  if (!isObserveView(viewValue))
    throw simpleError('invalid_view', 'view must be summary, metrics, events, device, versions, or routes')
  const view: ObserveView = viewValue

  const days = normalizeObserveDays(body.days)
  if (!days)
    throw simpleError('invalid_days', 'days must be one of 1, 3, 7, or 30')

  const sort = normalizeObserveSort(body.sort)
  const limit = normalizeObserveLimit(body.limit)
  const action = body.action
  const deviceId = body.deviceId
  const versionName = body.versionName?.trim() || undefined

  if (view === 'device' && !deviceId)
    throw simpleError('missing_params', 'deviceId is required for view=device')

  if (!(await checkPermission(c, 'app.read', { appId })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: appId })

  cloudlog({ requestId: c.get('requestId'), message: 'post private/observe body', body: { appId, view, days, action, deviceId, versionName, sort, limit } })

  const period = periodForDays(days)

  if (view === 'summary' || view === 'versions') {
    const stats = await readNativeObserveStats(c, appId, days, 'version')
    const findings = buildObserveFindings({
      overview: stats.overview,
      actionBreakdown: stats.actionBreakdown,
      versions: stats.versions,
    })
    const handoff_prompt = buildObserveHandoffPrompt({
      appId,
      days,
      overview: stats.overview,
      findings,
    })

    if (view === 'versions') {
      return c.json({
        view,
        app_id: appId,
        period: stats.period,
        versions: stats.versions,
        releaseMarkers: stats.releaseMarkers,
        agent_instructions: OBSERVE_AGENT_INSTRUCTIONS,
      })
    }

    return c.json({
      view,
      app_id: appId,
      period: stats.period,
      overview: stats.overview,
      actionBreakdown: stats.actionBreakdown.slice(0, 15),
      versions: stats.versions.slice(0, 12),
      releaseMarkers: stats.releaseMarkers,
      findings,
      handoff_prompt,
      agent_instructions: OBSERVE_AGENT_INSTRUCTIONS,
      nav_contract: OBSERVE_NAV_CONTRACT,
    })
  }

  if (view === 'events') {
    const actions = action ? [action] : [...nativeObserveActions]
    const insights = await readStatsInsights(c, {
      app_id: appId,
      start_date: period.start,
      end_date: period.end_exclusive,
      actions,
      version_name: versionName,
    })
    return c.json({
      view,
      app_id: appId,
      period,
      ...insights,
      agent_instructions: OBSERVE_AGENT_INSTRUCTIONS,
      next: deviceTimelineNext(insights.actions[0]?.latest_device_id),
    })
  }

  const sampleActions = sampleActionsForView(view, action)

  const samples = await loadSamples(c, {
    appId,
    start: period.start,
    endExclusive: period.end_exclusive,
    actions: sampleActions,
    deviceId,
    versionName,
    sort: view === 'device' ? 'oldest' : sort,
    limit: view === 'device' ? Math.min(200, Math.max(limit, 50)) : limit,
  })

  if (view === 'routes') {
    const routes = groupObserveRoutes(samples)
    return c.json({
      view,
      app_id: appId,
      period,
      routes,
      samples: samples.filter(sample => extractRoute(sample.metadata)).slice(0, limit),
      nav_contract: OBSERVE_NAV_CONTRACT,
      agent_instructions: OBSERVE_AGENT_INSTRUCTIONS,
    })
  }

  if (view === 'device') {
    return c.json({
      view,
      app_id: appId,
      device_id: deviceId,
      period,
      events: samples,
      agent_instructions: 'This device timeline is the session substitute. Read events in created_at order to see launch, WebView, crashes, and navigations.',
    })
  }

  return c.json({
    view,
    app_id: appId,
    period,
    samples,
    agent_instructions: OBSERVE_AGENT_INSTRUCTIONS,
    next: deviceTimelineNext(samples[0]?.device_id),
  })
})
