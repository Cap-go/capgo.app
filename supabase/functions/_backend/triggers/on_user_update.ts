import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { normalizeBentoEmail, syncBentoFirstOrgOnEmailChange } from '../utils/bento_first_org.ts'
import { BRES, middlewareAPISecret, quickError, simpleError, triggerValidator } from '../utils/hono.ts'
import { cleanStoredImageMetadata } from '../utils/image.ts'
import { cloudlog } from '../utils/logging.ts'
import { createApiKey } from '../utils/supabase.ts'
import { syncUserDisplayNameIntegrations, userDisplayNameChanged } from '../utils/user_display_name_sync.ts'
import { syncUserPreferenceTags } from '../utils/user_preferences.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('users', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['users']['Row']
  const oldRecord = c.get('oldRecord') as Database['public']['Tables']['users']['Row'] | undefined
  cloudlog({ requestId: c.get('requestId'), message: 'user updated', userId: record.id })
  if (!record.email) {
    cloudlog({ requestId: c.get('requestId'), message: 'No email' })
    return c.json(BRES)
  }
  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id')
  }

  const newEmail = normalizeBentoEmail(record.email)
  const oldEmail = oldRecord?.email ? normalizeBentoEmail(oldRecord.email) : undefined
  if (oldEmail && oldEmail !== newEmail) {
    const suppressionResult = await syncBentoFirstOrgOnEmailChange(c, oldEmail, newEmail)
    if (suppressionResult === false)
      quickError(500, 'bento_first_org_suppression_failed', 'Bento first-organization recovery suppression failed')
  }

  await syncUserPreferenceTags(c, newEmail, record, oldRecord, oldEmail)

  if (userDisplayNameChanged(oldRecord, record)) {
    const synced = await syncUserDisplayNameIntegrations(c, record)
    if (!synced)
      quickError(500, 'user_display_name_sync_failed', 'User display name sync failed')
  }

  await createApiKey(c, record.id)

  const newImagePath = record.image_url
  const oldImagePath = oldRecord?.image_url
  if (newImagePath && newImagePath !== oldImagePath) {
    await cleanStoredImageMetadata(c, newImagePath, { userId: record.id })
  }

  return c.json(BRES)
})
