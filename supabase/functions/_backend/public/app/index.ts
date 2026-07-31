import type { Database } from '../../utils/supabase.types.ts'
import type { CreateDemoApp } from './demo.ts'
import type { CreateApp } from './post.ts'
import type { FetchStoreMetadataBody } from './store_metadata.ts'
import { getBodyOrQuery, honoFactory, useCors } from '../../utils/hono.ts'
import { middlewareKey, middlewareAuth } from '../../utils/hono_middleware.ts'
import { deleteApp } from './delete.ts'
import { createDemoApp } from './demo.ts'
import { get, getAll } from './get.ts'
import { post } from './post.ts'
import { put } from './put.ts'
import { fetchStoreMetadata } from './store_metadata.ts'

export const app = honoFactory.createApp()

// Enable CORS for all routes (browser requests need OPTIONS preflight for all app endpoints)
app.use('*', useCors)

app.get('/', middlewareKey(), async (c) => {
  const pageQuery = c.req.query('page')
  const limitQuery = c.req.query('limit')
  const orgId = c.req.query('org_id')

  const page = pageQuery ? Number.parseInt(pageQuery) : undefined
  const limit = limitQuery ? Number.parseInt(limitQuery) : undefined

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const subkey = c.get('subkey') as Database['public']['Tables']['apikeys']['Row'] | undefined
  const keyToUse = subkey || apikey

  return getAll(c, keyToUse, page, limit, orgId)
})

app.get('/:id', middlewareKey(), async (c) => {
  const id = c.req.param('id')
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const subkey = c.get('subkey') as Database['public']['Tables']['apikeys']['Row'] | undefined
  const keyToUse = subkey || apikey
  return get(c, id, keyToUse)
})

app.post('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<CreateApp>(c)
  return post(c, body)
})

app.put('/:id', middlewareKey(), async (c) => {
  const id = c.req.param('id')
  const body = await getBodyOrQuery<{
    name?: string
    icon?: string
    retention?: number
    expose_metadata?: boolean
    allow_device_custom_id?: boolean
    need_onboarding?: boolean
    existing_app?: boolean
    block_provider_infra_requests?: boolean
    ios_store_url?: string | null
    android_store_url?: string | null
  }>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const subkey = c.get('subkey') as Database['public']['Tables']['apikeys']['Row'] | undefined
  const keyToUse = subkey || apikey
  return put(c, id, body, keyToUse)
})

app.delete('/:id', middlewareKey(), async (c) => {
  const id = c.req.param('id')
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const subkey = c.get('subkey') as Database['public']['Tables']['apikeys']['Row'] | undefined
  const keyToUse = subkey || apikey
  return deleteApp(c, id, keyToUse)
})

// Demo app creation supports both JWT (browser) and API key authentication
app.post('/demo', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<CreateDemoApp>(c)
  return createDemoApp(c, body)
})

app.post('/store-metadata', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<FetchStoreMetadataBody>(c)
  return fetchStoreMetadata(c, body)
})
