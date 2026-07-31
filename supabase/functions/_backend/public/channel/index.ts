import type { Database } from '../../utils/supabase.types.ts'
import type { ChannelSet } from './delete.ts'
import { getBodyOrQuery, honoFactory, parseBody } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { deleteChannel } from './delete.ts'
import { get } from './get.ts'
import { post } from './post.ts'

export const app = honoFactory.createApp()

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<ChannelSet>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return post(c, body, apikey)
})

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<ChannelSet>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return get(c, body, apikey)
})

app.delete('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<ChannelSet>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteChannel(c, body, apikey)
})
