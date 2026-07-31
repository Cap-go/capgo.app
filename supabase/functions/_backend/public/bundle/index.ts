import type { Database } from '../../utils/supabase.types.ts'
import type { GetLatest } from './get.ts'
import { getBodyOrQuery, honoFactory } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { createBundle } from './create.ts'
import { deleteBundle } from './delete.ts'
import { get } from './get.ts'
import { setChannel } from './set_channel.ts'
import { app as updateMetadataApp } from './update_metadata.ts'

export const app = honoFactory.createApp()
// Bundle writes authenticate through the primary connection so a just-created key is visible.
const writeBundleMiddleware = middlewareKey({ usePostgres: true, readOnly: false })

// Add the route for updating bundle metadata
app.route('/metadata', updateMetadataApp)

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<GetLatest>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return get(c, body, apikey)
})

app.delete('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<GetLatest>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteBundle(c, body, apikey)
})

app.put('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return setChannel(c, body, apikey)
})

app.post('/', writeBundleMiddleware, async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return createBundle(c, body, apikey)
})
