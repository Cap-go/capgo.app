import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Order, ReadDevicesParams } from '../utils/types.ts'
import type { VersionCompareFilter, VersionCompareOp } from '../utils/versionCompare.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { sanitizeFilename, toCsv } from '../utils/csv.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { appIdSchema, cursorSchema, deviceIdSchema, hasInvalidQueryLimitInput, hasUnsafeDevicesQueryText, queryLimitSchema, safeQueryTextSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission } from '../utils/rbac.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { countDevices, countInstallSources, readDevices } from '../utils/stats.ts'
import { Constants } from '../utils/supabase.types.ts'
import { parseVersionCompareFilter, VERSION_COMPARE_OPS } from '../utils/versionCompare.ts'

interface DataDevice {
  appId: string
  count?: boolean
  installSourceCounts?: boolean
  /** @deprecated Prefer versionNames for multi-select. Kept for backward compatibility. */
  versionName?: string
  versionNames?: string[]
  versionNameOp?: 'in' | VersionCompareOp
  osVersion?: string
  osVersionOp?: VersionCompareOp
  platform?: typeof Constants.public.Enums.platform_os[number]
  devicesId?: string[]
  deviceIds?: string[] // TODO: remove when migration is done
  installSources?: string[]
  search?: string
  customIdMode?: boolean
  order?: Order[]
  /** Cursor for pagination - pass nextCursor from previous response */
  cursor?: string
  /** Limit for results (default 1000) */
  limit?: number
  updated_at_gt?: string
  updated_at_lte?: string
  format?: 'csv' | 'json'
  filename?: string
}

const orderItemSchema = z.object({
  key: z.string().max(64),
  sortable: z.enum(['asc', 'desc']).optional(),
})
const platformSchema = z.enum(Constants.public.Enums.platform_os)
const versionCompareOpSchema = z.enum(VERSION_COMPARE_OPS)
const MAX_VERSION_NAMES = 50
const EXPORT_FORMATS = ['csv', 'json'] as const
const DEFAULT_EXPORT_LIMIT = 10_000
const devicesBodyShape = {
  appId: appIdSchema,
  count: z.boolean().optional(),
  installSourceCounts: z.boolean().optional(),
  versionName: safeQueryTextSchema.optional(),
  versionNames: z.array(safeQueryTextSchema).max(MAX_VERSION_NAMES).optional(),
  versionNameOp: z.union([z.literal('in'), versionCompareOpSchema]).optional(),
  osVersion: safeQueryTextSchema.optional(),
  osVersionOp: versionCompareOpSchema.optional(),
  platform: platformSchema.optional(),
  devicesId: z.array(deviceIdSchema).optional(),
  deviceIds: z.array(deviceIdSchema).optional(),
  installSources: z.array(safeQueryTextSchema).optional(),
  search: safeQueryTextSchema.optional(),
  customIdMode: z.boolean().optional(),
  order: z.array(orderItemSchema).optional(),
  cursor: cursorSchema.optional(),
  limit: queryLimitSchema.optional(),
  updated_at_gt: z.string().min(1).max(64).optional(),
  updated_at_lte: z.string().min(1).max(64).optional(),
}
const devicesBodySchema = z.object(devicesBodyShape)
const exportSchema = z.object({
  ...devicesBodyShape,
  format: z.enum(EXPORT_FORMATS).optional(),
  filename: z.string().min(1).max(200).optional(),
})

function resolveVersionNameFilter(body: { versionName?: string, versionNames?: string[] }): string | string[] | undefined {
  const names = (body.versionNames ?? [])
    .map(name => name.trim())
    .filter(Boolean)
  if (names.length)
    return [...new Set(names)]
  const single = body.versionName?.trim()
  return single || undefined
}

function firstVersionName(filter: string | string[] | undefined): string | undefined {
  if (!filter)
    return undefined
  return Array.isArray(filter) ? filter[0] : filter
}

function resolveVersionCompares(body: {
  versionName?: string
  versionNames?: string[]
  versionNameOp?: 'in' | VersionCompareOp
  osVersion?: string
  osVersionOp?: VersionCompareOp
}): {
  versionNameFilter: string | string[] | undefined
  versionNameCompare: VersionCompareFilter | undefined
  osVersionCompare: VersionCompareFilter | undefined
} {
  const names = resolveVersionNameFilter(body)
  const versionNameOp = body.versionNameOp
  const versionNameCompare = versionNameOp && versionNameOp !== 'in'
    ? parseVersionCompareFilter(versionNameOp, firstVersionName(names))
    : undefined
  const osVersionCompare = parseVersionCompareFilter(body.osVersionOp ?? 'eq', body.osVersion)

  return {
    versionNameFilter: versionNameCompare ? undefined : names,
    versionNameCompare,
    osVersionCompare,
  }
}

async function parseAuthorizedDevicesBody(c: Context<MiddlewareKeyVariables>, schema: typeof devicesBodySchema | typeof exportSchema, logLabel: string) {
  const bodyRaw = await parseBody<DataDevice>(c)
  if (hasInvalidQueryLimitInput(bodyRaw.limit))
    throw simpleError('invalid_body', 'Invalid body')
  const parsed = safeParseSchema(schema, bodyRaw)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  const body = parsed.data as DataDevice
  if (hasUnsafeDevicesQueryText(body))
    throw simpleError('invalid_body', 'Invalid body')
  if (body.osVersion?.trim() && !parseVersionCompareFilter(body.osVersionOp ?? 'eq', body.osVersion))
    throw simpleError('invalid_body', 'Invalid body')
  if (body.versionNameOp && body.versionNameOp !== 'in') {
    const names = resolveVersionNameFilter(body)
    const nameList = Array.isArray(names) ? names : names ? [names] : []
    if (nameList.length > 1 || !parseVersionCompareFilter(body.versionNameOp, firstVersionName(names)))
      throw simpleError('invalid_body', 'Invalid body')
  }
  cloudlog({ requestId: c.get('requestId'), message: logLabel, body })
  if (!(await checkPermission(c, 'app.read_devices', { appId: body.appId })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.appId })
  return body
}

function toReadDevicesParams(body: z.infer<typeof devicesBodySchema>, limit?: number): { params: ReadDevicesParams, customIdMode: boolean } {
  const devicesIds = body.devicesId ?? body.deviceIds ?? []
  const { versionNameFilter, versionNameCompare, osVersionCompare } = resolveVersionCompares(body)
  return {
    customIdMode: body.customIdMode ?? false,
    params: {
      app_id: body.appId,
      version_name: versionNameFilter,
      version_name_compare: versionNameCompare,
      os_version_compare: osVersionCompare,
      platform: body.platform,
      deviceIds: devicesIds,
      installSources: body.installSources,
      search: body.search,
      order: body.order,
      cursor: body.cursor,
      limit,
      updated_at_gt: body.updated_at_gt,
      updated_at_lte: body.updated_at_lte,
    },
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const body = await parseAuthorizedDevicesBody(c, devicesBodySchema, 'post devices body')
  const devicesIds = body.devicesId ?? body.deviceIds ?? []
  const { versionNameFilter, versionNameCompare, osVersionCompare } = resolveVersionCompares(body)
  if (body.installSourceCounts)
    return c.json({ installSources: await countInstallSources(c, body.appId) })
  if (body.count) {
    return c.json({
      count: await countDevices(
        c,
        body.appId,
        body.customIdMode ?? false,
        devicesIds,
        versionNameFilter,
        body.search?.trim(),
        {
          platform: body.platform,
          updatedAt: { gt: body.updated_at_gt, lte: body.updated_at_lte },
          osVersionCompare,
          versionNameCompare,
        },
      ),
    })
  }
  const { params, customIdMode } = toReadDevicesParams(body, body.limit)
  return c.json(await readDevices(c, params, customIdMode))
})

app.post('/export', middlewareAuth(), async (c) => {
  const body = await parseAuthorizedDevicesBody(c, exportSchema, 'post devices export body')
  const format = body.format ?? 'csv'
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_EXPORT_LIMIT, 1), DEFAULT_EXPORT_LIMIT)
  const { params, customIdMode } = toReadDevicesParams(body, limit)
  const result = await readDevices(c, { ...params, cursor: undefined }, customIdMode)
  const rows = result.data

  if (format === 'json') {
    return c.json({
      format: 'json',
      data: rows,
      limit,
      rowCount: rows.length,
    })
  }

  const header = [
    'device_id',
    'custom_id',
    'platform',
    'os_version',
    'version_name',
    'version_build',
    'plugin_version',
    'updated_at',
    'is_prod',
    'is_emulator',
    'install_source',
    'country_code',
  ] as const
  const csv = toCsv(header, rows.map(row => ({
    device_id: row.device_id ?? '',
    custom_id: row.custom_id ?? '',
    platform: row.platform ?? '',
    os_version: row.os_version ?? '',
    version_name: row.version_name ?? '',
    version_build: row.version_build ?? '',
    plugin_version: row.plugin_version ?? '',
    updated_at: row.updated_at ?? '',
    is_prod: row.is_prod ?? '',
    is_emulator: row.is_emulator ?? '',
    install_source: row.install_source ?? '',
    country_code: row.country_code ?? '',
  })))
  const defaultFilename = `capgo-devices-${body.appId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  const safeFilename = sanitizeFilename(body.filename, 'csv')
  return c.json({
    format: 'csv',
    filename: safeFilename || defaultFilename,
    contentType: 'text/csv; charset=utf-8',
    limit,
    rowCount: rows.length,
    csv,
  })
})
