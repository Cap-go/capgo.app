import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { BRES, createHono, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { supabaseAdmin, supabaseClient } from '../utils/supabase.ts'
import { version } from '../utils/version.ts'

type AppContext = Context<MiddlewareKeyVariables>

const SUPPORT_CHANNEL_TYPES = ['slack', 'discord', 'teams'] as const
type SupportChannelType = typeof SUPPORT_CHANNEL_TYPES[number]

const bodySchema = z.object({
  org_id: z.uuid(),
  support_channel_type: z.enum(SUPPORT_CHANNEL_TYPES).nullable(),
  support_channel_url: z.url().max(2048).nullable(),
}).refine((value) => {
  const hasType = value.support_channel_type !== null
  const hasUrl = value.support_channel_url !== null
  return hasType === hasUrl
}, {
  message: 'support_channel_type and support_channel_url must both be set or both be null',
}).refine((value) => {
  if (!value.support_channel_url)
    return true
  return value.support_channel_url.startsWith('https://')
}, {
  message: 'support_channel_url must be an https URL',
})

interface SupportChannelRequest {
  org_id: string
  support_channel_type: SupportChannelType | null
  support_channel_url: string | null
}

async function verifyAdmin(c: AppContext): Promise<{ isAdmin: boolean, userId: string | null }> {
  const auth = c.get('auth')
  if (!auth?.userId || auth.authType !== 'jwt' || !auth.jwt) {
    cloudlog({ requestId: c.get('requestId'), message: 'admin_org_support_channel_no_auth' })
    return { isAdmin: false, userId: null }
  }

  const userId = auth.userId
  const userSupabase = supabaseClient(c, auth.jwt)
  const { data: isAdmin, error: adminError } = await userSupabase.rpc('is_platform_admin')

  if (adminError) {
    cloudlog({ requestId: c.get('requestId'), message: 'is_admin_error', error: adminError })
    return { isAdmin: false, userId }
  }

  return { isAdmin: !!isAdmin, userId }
}

export const app = createHono('', version)

app.use('*', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const { isAdmin, userId } = await verifyAdmin(c)

  if (!isAdmin) {
    cloudlog({ requestId: c.get('requestId'), message: 'not_admin_support_channel_attempt', userId })
    throw simpleError('not_admin', 'Only admin users can set organization support channels')
  }

  const body = await parseBody<SupportChannelRequest>(c)
  const parsedBodyResult = safeParseSchema(bodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid request body', { body, parsedBodyResult })
  }

  const { org_id, support_channel_type, support_channel_url } = parsedBodyResult.data
  const adminSupabase = supabaseAdmin(c)

  const { data: org, error: orgError } = await adminSupabase
    .from('orgs')
    .select('id')
    .eq('id', org_id)
    .maybeSingle()

  if (orgError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_org_support_channel_org_lookup_failed',
      org_id,
      error: orgError,
    })
    throw simpleError('org_lookup_failed', 'Failed to load organization')
  }

  if (!org) {
    throw simpleError('org_not_found', 'Organization not found')
  }

  const { error: updateError } = await adminSupabase
    .from('orgs')
    .update({
      support_channel_type,
      support_channel_url,
    })
    .eq('id', org_id)

  if (updateError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_org_support_channel_update_failed',
      adminUserId: userId,
      org_id,
      error: updateError,
    })
    throw simpleError('update_failed', 'Failed to update organization support channel')
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'admin_org_support_channel_updated',
    adminUserId: userId,
    org_id,
    support_channel_type,
  })

  return c.json(BRES)
})
