import { z } from 'zod'
import { BRES, createHono, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { requireJwtPlatformAdmin } from '../utils/platform_admin_access.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { version } from '../utils/version.ts'

const SUPPORT_CHANNEL_TYPES = ['slack', 'discord', 'teams'] as const

const bodySchema = z.object({
  org_id: z.uuid(),
  support_channel_type: z.enum(SUPPORT_CHANNEL_TYPES).nullable(),
  support_channel_url: z.url().max(2048).nullable(),
}).refine(value => (value.support_channel_type !== null) === (value.support_channel_url !== null), {
  message: 'support_channel_type and support_channel_url must both be set or both be null',
}).refine(value => !value.support_channel_url || value.support_channel_url.startsWith('https://'), {
  message: 'support_channel_url must be an https URL',
})

export const app = createHono('', version)

app.use('*', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const userId = await requireJwtPlatformAdmin(c, 'Only admin users can set organization support channels')
  const parsedBodyResult = safeParseSchema(bodySchema, await parseBody(c))
  if (!parsedBodyResult.success)
    throw simpleError('invalid_json_body', 'Invalid request body', { parsedBodyResult })

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
