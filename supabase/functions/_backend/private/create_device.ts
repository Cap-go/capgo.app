import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { schema } from '../utils/postgres_schema.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createStatsDevices } from '../utils/stats.ts'

const bodySchema = z.object({
  device_id: z.uuid(),
  app_id: z.string(),
  org_id: z.uuid(),
  platform: z.enum(['ios', 'android']),
  version_name: z.string(),
})

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

interface CreateDeviceBody {
  device_id: string
  app_id: string
  org_id: string
  platform: string
  version_name: string
}

app.post('/', middlewareAuth(), async (c) => {
  const auth = c.get('auth')!

  const body = await parseBody<CreateDeviceBody>(c)
  const parsedBodyResult = safeParseSchema(bodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid JSON body', { body, parsedBodyResult })
  }

  const safeBody = parsedBodyResult.data
  const normalizedOrgId = safeBody.org_id.toLowerCase()

  let appOwnerOrg: string | null = null
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const appResult = await drizzleClient
      .select({ ownerOrg: schema.apps.owner_org })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, safeBody.app_id))
      .limit(1)
    appOwnerOrg = appResult[0]?.ownerOrg ?? null
  }
  catch (error) {
    throw simpleError('internal_db_error', 'Cannot get app', { error, appId: safeBody.app_id })
  }
  finally {
    if (pgClient) {
      closeClient(c, pgClient)
    }
  }

  if (!appOwnerOrg) {
    return quickError(404, 'app_not_found', 'App not found', { app_id: safeBody.app_id })
  }

  if (appOwnerOrg.toLowerCase() !== normalizedOrgId) {
    return quickError(401, 'not_authorized', 'Not authorized', { userId: auth.userId, appId: safeBody.app_id, orgId: normalizedOrgId })
  }

  if (!(await checkPermission(c, 'app.manage_devices', { orgId: appOwnerOrg, appId: safeBody.app_id }))) {
    return quickError(401, 'not_authorized', 'Not authorized', { userId: auth.userId, appId: safeBody.app_id })
  }

  await createStatsDevices(c, {
    app_id: safeBody.app_id,
    device_id: safeBody.device_id,
    version_name: safeBody.version_name,
    platform: safeBody.platform,
    plugin_version: '0.0.0',
    os_version: '0.0.0',
    version_build: '0.0.0',
    custom_id: '',
    is_prod: true,
    is_emulator: false,
    updated_at: new Date().toISOString(),
  }, { includeRequestCountry: false })

  return c.json(BRES)
})
