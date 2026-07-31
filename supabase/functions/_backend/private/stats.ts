import type { Context } from 'hono'
import type { StandardSchema } from '../utils/schema_validation.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Order } from '../utils/types.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { toCsv } from '../utils/csv.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { appIdSchema, deviceIdSchema, hasInvalidQueryLimitInput, hasUnsafeStatsQueryText, MAX_QUERY_LIMIT, queryLimitSchema, safeQueryDateSchema, safeQueryTextSchema, statsActionSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission } from '../utils/rbac.ts'
import { readStats, readStatsInsights } from '../utils/stats.ts'

interface DataStats {
  appId: string
  devicesId?: string[]
  search?: string
  order?: Order[]
  rangeStart?: string | number
  rangeEnd?: string | number
  limit?: number
  actions?: string[]
  days?: number
}

const ORDER_KEYS = ['created_at', 'app_id', 'device_id', 'action', 'version_name'] as const
const EXPORT_FORMATS = ['csv', 'json'] as const
const NUMERIC_RANGE_INPUT = /^-?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)$/

const statsBodyShape = {
  appId: appIdSchema,
  devicesId: z.array(deviceIdSchema).optional(),
  search: safeQueryTextSchema.optional(),
  order: z.array(z.object({
    key: z.enum(ORDER_KEYS),
    sortable: z.enum(['asc', 'desc']),
  })).optional(),
  rangeStart: z.union([safeQueryDateSchema, z.number()]).optional(),
  rangeEnd: z.union([safeQueryDateSchema, z.number()]).optional(),
  limit: queryLimitSchema.optional(),
  actions: z.array(statsActionSchema).optional(),
} as const

const statsBodySchema = z.object(statsBodyShape)

function stripControlChars(input: string): string {
  const out: string[] = []
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    // 0-31 are control chars, 127 is DEL.
    if ((code >= 0 && code <= 31) || code === 127)
      continue
    out.push(input[i])
  }
  return out.join('')
}

function sanitizeFilename(input: string | undefined, extension: 'csv' | 'json'): string | undefined {
  if (!input)
    return undefined

  const trimmed = input.trim()
  if (!trimmed)
    return undefined

  // Strip path separators and control characters.
  const safe = stripControlChars(trimmed)
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180)

  const ext = `.${extension}`
  if (safe.toLowerCase().endsWith(ext))
    return safe
  return `${safe}${ext}`
}

const exportSchema = z.object({
  ...statsBodyShape,
  format: z.enum(EXPORT_FORMATS).optional(),
  filename: z.string().optional(),
})

const statsInsightsSchema = z.object({
  appId: appIdSchema,
  days: z.number().optional(),
  actions: z.array(statsActionSchema).optional(),
})

const insightPeriodDays = [1, 3, 7, 30] as const
type InsightPeriodDays = typeof insightPeriodDays[number]

const defaultInsightActions = [
  'set_fail',
  'update_fail',
  'download_fail',
  'windows_path_fail',
  'canonical_path_fail',
  'directory_path_fail',
  'unzip_fail',
  'low_mem_fail',
  'download_manifest_file_fail',
  'download_manifest_checksum_fail',
  'download_manifest_brotli_fail',
  'finish_download_fail',
  'manifest_path_fail',
  'decrypt_fail',
  'insufficient_disk_space',
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
  'cannotGetBundle',
  'checksum_fail',
  'blocked_by_server_url',
  'backend_refusal',
]

interface StatsBody {
  appId: string
  devicesId?: string[]
  search?: string
  order?: { key: typeof ORDER_KEYS[number], sortable: 'asc' | 'desc' }[]
  rangeStart?: string | number
  rangeEnd?: string | number
  limit?: number
  actions?: string[]
}

interface StatsInsightsBody {
  appId: string
  days?: number
  actions?: string[]
}

interface ExportBody extends StatsBody {
  format?: typeof EXPORT_FORMATS[number]
  filename?: string
}
interface ValidatedStatsRequest<T extends StatsBody | ExportBody> {
  body: T
  startDate: string | undefined
  endDate: string | undefined
}

export const app = new Hono<MiddlewareKeyVariables>()

// Browser clients call this endpoint and require CORS preflight (OPTIONS).
// Use '*' so it also applies to sub-routes like '/export'.
app.use('*', useCors)

function normalizeRangeDate(value: string | number | undefined): string | undefined {
  if (value === undefined)
    return undefined

  const normalizedValue = typeof value === 'string' && NUMERIC_RANGE_INPUT.test(value.trim())
    ? Number(value)
    : value

  const date = new Date(normalizedValue)
  if (Number.isNaN(date.getTime()))
    throw simpleError('invalid_body', 'Invalid body')

  return date.toISOString()
}

function normalizeStatsInsightsPeriodDays(days: number | undefined = 7): InsightPeriodDays | null {
  if (!Number.isInteger(days) || !insightPeriodDays.includes(days as InsightPeriodDays))
    return null

  return days as InsightPeriodDays
}

function createUtcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0))
}

function getStatsInsightsPeriod(days: InsightPeriodDays, now = new Date()) {
  const todayStart = createUtcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const endExclusive = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const start = new Date(endExclusive.getTime() - days * 24 * 60 * 60 * 1000)
  const labels: string[] = []
  for (let cursor = new Date(start); cursor.getTime() < endExclusive.getTime(); cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
    labels.push(cursor.toISOString().slice(0, 10))
  }

  return {
    requested_days: days,
    start: start.toISOString(),
    end: new Date(endExclusive.getTime() - 1).toISOString(),
    end_exclusive: endExclusive.toISOString(),
    labels,
  }
}

async function getValidatedStatsRequestBody<T extends StatsBody | ExportBody>(
  c: Context,
  schema: StandardSchema<T>,
  logMessage: string,
): Promise<ValidatedStatsRequest<T>> {
  const bodyRaw = await parseBody<DataStats>(c)
  if (hasInvalidQueryLimitInput(bodyRaw.limit))
    throw simpleError('invalid_body', 'Invalid body')
  const parsed = safeParseSchema(schema, bodyRaw)
  if (!parsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  }
  const body = parsed.data
  if (hasUnsafeStatsQueryText(body)) {
    throw simpleError('invalid_body', 'Invalid body')
  }
  const startDate = normalizeRangeDate(body.rangeStart)
  const endDate = normalizeRangeDate(body.rangeEnd)
  cloudlog({ requestId: c.get('requestId'), message: logMessage, body })
  const hasAppReadLogsPermission = await checkPermission(c, 'app.read_logs', { appId: body.appId })
  if (!hasAppReadLogsPermission) {
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.appId })
  }
  return { body, startDate, endDate }
}

function createStatsReadParams(
  body: StatsBody | ExportBody,
  startDate: string | undefined,
  endDate: string | undefined,
  limit = body.limit,
) {
  const order: Order[] | undefined = body.order?.map(item => ({ key: item.key, sortable: item.sortable }))

  return {
    app_id: body.appId,
    start_date: startDate,
    end_date: endDate,
    deviceIds: body.devicesId,
    search: body.search,
    order,
    limit,
    actions: body.actions,
  }
}

app.post('/', middlewareAuth(), async (c) => {
  const { body, startDate, endDate } = await getValidatedStatsRequestBody(c, statsBodySchema, 'post private/stats body')
  return c.json(await readStats(c, createStatsReadParams(body, startDate, endDate)))
})

app.post('/insights', middlewareAuth(), async (c) => {
  const bodyRaw = await parseBody<DataStats>(c)
  const parsed = safeParseSchema(statsInsightsSchema, bodyRaw)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })

  const body = parsed.data as StatsInsightsBody
  const days = normalizeStatsInsightsPeriodDays(body.days)
  if (!days)
    throw simpleError('invalid_days', 'days must be one of 1, 3, 7, or 30')

  const hasAppReadLogsPermission = await checkPermission(c, 'app.read_logs', { appId: body.appId })
  if (!hasAppReadLogsPermission)
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.appId })

  const period = getStatsInsightsPeriod(days)
  const actions = body.actions?.length ? body.actions : defaultInsightActions
  cloudlog({ requestId: c.get('requestId'), message: 'post private/stats/insights body', body: { appId: body.appId, days, actionCount: actions.length } })

  return c.json({
    ...(await readStatsInsights(c, {
      app_id: body.appId,
      start_date: period.start,
      end_date: period.end_exclusive,
      actions,
    })),
    period: {
      requested_days: period.requested_days,
      start: period.start,
      end: period.end,
      labels: period.labels,
    },
  })
})

app.post('/export', middlewareAuth(), async (c) => {
  const { body, startDate, endDate } = await getValidatedStatsRequestBody(c, exportSchema, 'post private/stats/export body')
  const format: NonNullable<ExportBody['format']> = body.format ?? 'csv'
  const limit = Math.min(Math.max(body.limit ?? 10_000, 1), MAX_QUERY_LIMIT)
  const data = await readStats(c, createStatsReadParams(body, startDate, endDate, limit))

  if (format === 'json') {
    return c.json({
      format: 'json',
      data,
      limit,
      rowCount: Array.isArray(data) ? data.length : 0,
    })
  }

  const header = ['created_at', 'app_id', 'device_id', 'action', 'version_name', 'metadata'] as const
  const csv = toCsv(
    header,
    (Array.isArray(data) ? data : []).map((row: any) => ({
      created_at: row.created_at ?? '',
      app_id: row.app_id ?? '',
      device_id: row.device_id ?? '',
      action: row.action ?? '',
      version_name: row.version_name ?? '',
      metadata: row.metadata ? JSON.stringify(row.metadata) : '',
    })),
  )

  const defaultFilename = `capgo-logs-${body.appId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  const safeFilename = sanitizeFilename(body.filename, 'csv')
  return c.json({
    format: 'csv',
    filename: safeFilename || defaultFilename,
    contentType: 'text/csv; charset=utf-8',
    limit,
    rowCount: Array.isArray(data) ? data.length : 0,
    csv,
  })
})
