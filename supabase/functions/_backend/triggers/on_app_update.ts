import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cleanStoredImageMetadata } from '../utils/image.ts'
import { cloudlog } from '../utils/logging.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('apps', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['apps']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No app id' })
    throw simpleError('no_id', 'No id', { record })
  }

  if (record.icon_url) {
    await cleanStoredImageMetadata(c, record.icon_url, {
      orgId: record.owner_org,
      appId: record.app_id,
    })
  }

  return c.json(BRES)
})
