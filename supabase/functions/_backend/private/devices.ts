import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Order } from '../utils/types.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { appIdSchema, cursorSchema, deviceIdSchema, hasInvalidQueryLimitInput, hasUnsafeDevicesQueryText, queryLimitSchema, safeQueryTextSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission } from '../utils/rbac.ts'
import { countDevices, countInstallSources, readDevices } from '../utils/stats.ts'

interface DataDevice {
  appId: string
  count?: boolean
  installSourceCounts?: boolean
  versionName?: string
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
}

const orderItemSchema = z.object({
  key: z.string().max(64),
  sortable: z.enum(['asc', 'desc']).optional(),
})
const devicesBodySchema = z.object({
  appId: appIdSchema,
  count: z.boolean().optional(),
  installSourceCounts: z.boolean().optional(),
  versionName: safeQueryTextSchema.optional(),
  devicesId: z.array(deviceIdSchema).optional(),
  deviceIds: z.array(deviceIdSchema).optional(),
  installSources: z.array(safeQueryTextSchema).optional(),
  search: safeQueryTextSchema.optional(),
  customIdMode: z.boolean().optional(),
  order: z.array(orderItemSchema).optional(),
  cursor: cursorSchema.optional(),
  limit: queryLimitSchema.optional(),
})

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const bodyRaw = await parseBody<DataDevice>(c)
  if (hasInvalidQueryLimitInput(bodyRaw.limit))
    throw simpleError('invalid_body', 'Invalid body')
  const parsed = safeParseSchema(devicesBodySchema, bodyRaw)
  if (!parsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  }
  const body = parsed.data
  if (hasUnsafeDevicesQueryText(body)) {
    throw simpleError('invalid_body', 'Invalid body')
  }
  cloudlog({ requestId: c.get('requestId'), message: 'post devices body', body })
  if (!(await checkPermission(c, 'app.read_devices', { appId: body.appId }))) {
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.appId })
  }

  const devicesIds = body.devicesId ?? body.deviceIds ?? []
  if (body.installSourceCounts)
    return c.json({ installSources: await countInstallSources(c, body.appId) })
  if (body.count)
    return c.json({ count: await countDevices(c, body.appId, body.customIdMode ?? false, devicesIds, body.versionName, body.search?.trim()) })
  return c.json(await readDevices(c, {
    app_id: body.appId,
    version_name: body.versionName,
    deviceIds: devicesIds,
    installSources: body.installSources,
    search: body.search,
    order: body.order,
    cursor: body.cursor,
    limit: body.limit,
  }, body.customIdMode ?? false))
})
