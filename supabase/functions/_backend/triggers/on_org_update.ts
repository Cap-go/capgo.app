import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cleanStoredImageMetadata } from '../utils/image.ts'
import { cloudlog } from '../utils/logging.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('orgs', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['orgs']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No org id' })
    throw simpleError('no_id', 'No id', { record })
  }

  if (record.logo) {
    await cleanStoredImageMetadata(c, record.logo, { orgId: record.id })
  }

  return c.json(BRES)
})
