import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import type { DeviceLink } from './delete.ts'
import { checkChannelSelfIPRateLimit, isChannelSelfRateLimited, recordChannelSelfIPRequest, recordChannelSelfRequest } from '../../utils/channelSelfRateLimit.ts'
import { getBodyOrQuery, honoFactory, parseBody, simpleRateLimit } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { cloudlog } from '../../utils/logging.ts'
import { buildRateLimitInfo } from '../../utils/rateLimitInfo.ts'
import { backgroundTask } from '../../utils/utils.ts'
import { deleteOverride } from './delete.ts'
import { get } from './get.ts'
import { post } from './post.ts'

function logDeviceRequestContext(
  c: Context,
  operation: 'set' | 'get' | 'delete',
  body: Partial<DeviceLink>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
) {
  cloudlog({ requestId: c.get('requestId'), message: `device ${operation} body`, body })
  cloudlog({
    requestId: c.get('requestId'),
    message: `device ${operation} apikey context`,
    apikeyId: apikey.id,
    userId: apikey.user_id,
  })
}

async function assertDeviceIPRateLimit(c: Context, appId: string) {
  const ipRateLimitStatus = await checkChannelSelfIPRateLimit(c, appId, 'Device API IP rate limited')
  if (ipRateLimitStatus.limited) {
    simpleRateLimit({ reason: 'ip_rate_limit_exceeded', app_id: appId, ...buildRateLimitInfo(ipRateLimitStatus.resetAt) })
  }
}

async function assertDeviceOperationRateLimit(c: Context, body: Partial<DeviceLink>, operation: 'set' | 'get' | 'delete') {
  if (!body.device_id || !body.app_id) {
    return
  }

  const rateLimitChannel = operation === 'set' ? body.channel : undefined
  const rateLimitStatus = await isChannelSelfRateLimited(c, body.app_id, body.device_id, operation, rateLimitChannel)
  if (rateLimitStatus.limited) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `Device API ${operation} rate limited`,
      app_id: body.app_id,
      device_id: body.device_id,
      channel: body.channel,
    })
    simpleRateLimit({ app_id: body.app_id, device_id: body.device_id, ...buildRateLimitInfo(rateLimitStatus.resetAt) })
  }
}

function recordDeviceIPRateLimit(c: Context, appId: string) {
  // IP rate limiting is a second-layer limiter (per-minute) and is not required
  // for per-operation burst enforcement. Record it in the background.
  return recordChannelSelfIPRequest(c, appId)
}

async function recordDeviceRateLimitSafely(
  c: Context,
  body: Partial<DeviceLink>,
  operation: 'set' | 'get' | 'delete',
) {
  // Intentionally awaited for op-level rate limiting: this is the limiter that
  // must be effective immediately for burst protection.
  if (body.device_id && body.app_id) {
    try {
      const rateLimitChannel = operation === 'set' ? body.channel : undefined
      await recordChannelSelfRequest(c, body.app_id, body.device_id, operation, rateLimitChannel)
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: `Failed to record device ${operation} rate limit`, app_id: body.app_id, device_id: body.device_id, error })
    }
  }
  if (body.app_id) {
    backgroundTask(c, recordDeviceIPRateLimit(c, body.app_id))
  }
}

export const app = honoFactory.createApp()

async function handleDeviceOperation<TBody extends Partial<DeviceLink>>(
  c: Context,
  operation: 'set' | 'get' | 'delete',
  body: TBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  handler: (c: Context, body: TBody, apikey: Database['public']['Tables']['apikeys']['Row']) => Promise<Response>,
) {
  logDeviceRequestContext(c, operation, body, apikey)

  if (body.app_id) {
    await assertDeviceIPRateLimit(c, body.app_id)
  }

  await assertDeviceOperationRateLimit(c, body, operation)

  try {
    return await handler(c, body, apikey)
  }
  finally {
    // Record the request for rate limiting (all requests, not just successful ones, to prevent abuse through repeated invalid requests)
    await recordDeviceRateLimitSafely(c, body, operation)
  }
}

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<DeviceLink>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return await handleDeviceOperation(c, 'set', body, apikey, post)
})

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<DeviceLink>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return await handleDeviceOperation(c, 'get', body, apikey, get)
})

app.delete('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<DeviceLink>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return await handleDeviceOperation(c, 'delete', body, apikey, deleteOverride)
})
