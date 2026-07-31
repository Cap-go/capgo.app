import type { Database } from '../../utils/supabase.types.ts'
import { getBodyOrQuery, honoFactory, useCors } from '../../utils/hono.ts'
import { middlewareAuth, middlewareKey } from '../../utils/hono_middleware.ts'
import { getAuditLogs } from './audit.ts'
import { deleteOrg } from './delete.ts'
import { get } from './get.ts'
import { deleteMember } from './members/delete.ts'
import { get as getMembers } from './members/get.ts'
import { post as inviteUser } from './members/post.ts'
import { post } from './post.ts'
import { put } from './put.ts'

export const app = honoFactory.createApp()

// Browser clients call this function directly and need CORS preflight support.
app.use('*', useCors)

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return get(c, body, apikey)
})

app.put('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return put(c, body, apikey)
})

app.post('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row'] | null | undefined
  return post(c, body, apikey)
})

app.delete('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteOrg(c, body, apikey)
})

app.get('/members', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return getMembers(c, body, apikey)
})

app.post('/members', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return inviteUser(c, body, apikey)
})

app.delete('/members', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteMember(c, body, apikey)
})

app.get('/audit', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  return getAuditLogs(c, body)
})
