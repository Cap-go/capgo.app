import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createClient } from './sql-data-client'
import { getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils'

const admin = getSupabaseClient()
const appId = 'com.example.serving.' + randomUUID().replaceAll('-', '')
beforeAll(async () => {
  const { data: parent, error } = await admin.from('apps').select('owner_org,user_id').eq('app_id', 'com.demo.app').single()
  expect(error).toBeNull()
  if (!parent)
    throw new Error('Missing local demo fixture')
  const inserted = await admin.from('apps').insert({ app_id: appId, name: 'Regional serving test', icon_url: '', owner_org: parent.owner_org, user_id: parent.user_id })
  expect(inserted.error).toBeNull()
})
afterAll(async () => { await admin.from('apps').delete().eq('app_id', appId) })

it('defaults, validates and round trips policy through SQL data client without PostgREST', async () => {
  const first = await admin.from('apps').select('serving_regions,serving_region_mode').eq('app_id', appId).single()
  expect(first.data?.serving_regions).toHaveLength(9)
  expect(first.data?.serving_region_mode).toBe('route')
  const changed = await admin.from('apps').update({ serving_regions: ['NA'], serving_region_mode: 'block' }).eq('app_id', appId)
  expect(changed.error).toBeNull()
  const saved = await admin.from('apps').select('serving_regions,serving_region_mode').eq('app_id', appId).single()
  expect(saved.data).toEqual({ serving_regions: ['NA'], serving_region_mode: 'block' })
  const invalid = await admin.from('apps').update({ serving_regions: [] }).eq('app_id', appId)
  expect(invalid.error?.code).toBe('23514')
})

it('keeps anonymous settings updates denied by existing RLS', async () => {
  await admin.from('apps').update({ serving_region_mode: 'block' }).eq('app_id', appId)
  const anon = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY)
  await anon.from('apps').update({ serving_region_mode: 'route' }).eq('app_id', appId)
  const saved = await admin.from('apps').select('serving_region_mode').eq('app_id', appId).single()
  expect(saved.data?.serving_region_mode).toBe('block')
})
