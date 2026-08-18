import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import type { Context } from 'hono'
import { Hono } from 'hono/tiny'
import { trackBentoEvent } from '../utils/bento.ts'
import { normalizeBentoEmail, prepareNewUserProvisioning, syncBentoFirstOrgOnUserCreate } from '../utils/bento_first_org.ts'
import { BRES, middlewareAPISecret, quickError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { createApiKey, supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { syncUserPreferenceTags } from '../utils/user_preferences.ts'

export const app = new Hono<MiddlewareKeyVariables>()
const BENTO_REGISTERED_FROM_MOBILE_EVENT = 'user:registered_from_mobile'

async function getRegistrationMetadata(c: Context, userId: string) {
  const { data, error } = await supabaseAdmin(c).auth.admin.getUserById(userId)
  if (error)
    throw error
  return data.user.user_metadata ?? {}
}

app.post('/', middlewareAPISecret, triggerValidator('users', 'INSERT'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['users']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })
  // Configured Bento failures deliberately fail this queue message. Its
  // lifecycle tag writes are idempotent, and retrying avoids silently losing
  // the only recovery enrollment for a newly registered user.
  const shouldProvisionUser = await prepareNewUserProvisioning(c, record)
  if (!shouldProvisionUser)
    return c.json(BRES)

  const registrationMetadata = await getRegistrationMetadata(c, record.id)
  await createApiKey(c, record.id)
  cloudlog({ requestId: c.get('requestId'), message: 'createCustomer stripe' })
  await syncUserPreferenceTags(c, normalizeBentoEmail(record.email), record)
  await syncBentoFirstOrgOnUserCreate(c, record)
  const deviceType = registrationMetadata.registration_device_type
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    const result = await trackBentoEvent(c, normalizeBentoEmail(record.email), {
      registered_at: record.created_at,
      registration_browser: typeof registrationMetadata.registration_browser === 'string' ? registrationMetadata.registration_browser : 'unknown',
      registration_device_type: deviceType,
      registration_os: typeof registrationMetadata.registration_os === 'string' ? registrationMetadata.registration_os : 'unknown',
      user_id: record.id,
    }, BENTO_REGISTERED_FROM_MOBILE_EVENT)
    // Bento fact events are intentionally at-least-once; queue retries may repeat them.
    if (result === false)
      quickError(500, 'bento_mobile_registration_delivery_failed', 'Bento mobile registration delivery failed')
  }
  // "User Joined" should represent a self-signup (technical user expected to onboard),
  // not an account created by accepting an org invite.
  await sendEventToTracking(c, {
    channel: 'user-register',
    event: !record.created_via_invite ? 'User Joined' : 'User Joined by Invite',
    icon: '🎉',
    user_id: record.id,
    notify: false,
  }).catch((error) => {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'User registration tracking failed',
      error,
    })
  })
  return c.json(BRES)
})
