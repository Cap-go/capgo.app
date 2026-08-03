import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { changeEmailBento } from '../utils/bento.ts'
import { BRES, middlewareAPISecret, quickError, simpleError, triggerValidator } from '../utils/hono.ts'
import { cleanStoredImageMetadata } from '../utils/image.ts'
import { cloudlog } from '../utils/logging.ts'
import { createApiKey } from '../utils/supabase.ts'
import { syncUserPreferenceTags } from '../utils/user_preferences.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('users', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['users']['Row']
  const oldRecord = c.get('oldRecord') as Database['public']['Tables']['users']['Row'] | undefined
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })
  if (!record.email) {
    cloudlog({ requestId: c.get('requestId'), message: 'No email' })
    return c.json(BRES)
  }
  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }
  await createApiKey(c, record.id)

  const newImagePath = record.image_url
  const oldImagePath = oldRecord?.image_url
  if (newImagePath && newImagePath !== oldImagePath) {
    await cleanStoredImageMetadata(c, newImagePath)
  }

  const newEmail = record.email.trim().toLowerCase()
  const oldEmail = oldRecord?.email?.trim().toLowerCase()
  if (oldEmail && oldEmail !== newEmail) {
    const changeEmailResult = await changeEmailBento(c, oldEmail, newEmail)
    if (changeEmailResult === false)
      quickError(500, 'bento_change_email_failed', 'Bento email change failed')
    await syncUserPreferenceTags(c, newEmail, record, oldRecord, newEmail)
  }
  else {
    await syncUserPreferenceTags(c, record.email, record, oldRecord, oldRecord?.email)
  }

  return c.json(BRES)
})
