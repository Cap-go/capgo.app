import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils.ts'

const admin = getSupabaseClient() as SupabaseClient
const orgIds = [randomUUID(), randomUUID()]
const hostname = `updates-${randomUUID()}.example.com`
const anon = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY)
const authenticated = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY)
let userId: string | undefined

beforeAll(async () => {
  const email = `custom-domains-${randomUUID()}@example.test`
  const password = `custom-domains-${randomUUID()}`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error)
    throw created.error
  userId = created.data.user.id
  const profile = await admin.from('users').insert({ id: userId, email })
  if (profile.error)
    throw profile.error
  const { error } = await admin.from('orgs').insert(orgIds.map(id => ({ id, created_by: userId, name: `Custom domain schema ${id}`, management_email: email })))
  if (error)
    throw error
  const login = await authenticated.auth.signInWithPassword({ email, password })
  if (login.error)
    throw login.error
})

afterAll(async () => {
  await admin.from('org_custom_domains').delete().in('org_id', orgIds)
  await admin.from('orgs').delete().in('id', orgIds)
  if (userId) {
    await admin.from('users').delete().eq('id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
})

describe('organization custom domain storage', () => {
  it('stores one hostname per organization and reserves it across organizations', async () => {
    const inserted = await admin.from('org_custom_domains').insert({ org_id: orgIds[0], hostname, provider_id: randomUUID() })
    expect(inserted.error).toBeNull()
    const sameOrg = await admin.from('org_custom_domains').insert({ org_id: orgIds[0], hostname: `another-${hostname}` })
    expect(sameOrg.error?.code).toBe('23505')
    const sameHostname = await admin.from('org_custom_domains').insert({ org_id: orgIds[1], hostname })
    expect(sameHostname.error?.code).toBe('23505')
    const invalid = await admin.from('org_custom_domains').insert({ org_id: orgIds[1], hostname: 'UPDATES.example.com' })
    expect(invalid.error?.code).toBe('23514')
    const deleteOrg = await admin.from('orgs').delete().eq('id', orgIds[0])
    expect(deleteOrg.error?.code).toBe('23503')
  })

  it.concurrent.each([['anonymous', anon], ['authenticated', authenticated]] as const)('denies direct %s reads and writes', async (_role, client) => {
    expect((await client.from('org_custom_domains').select('*').limit(1)).error?.code).toBe('42501')
    expect((await client.from('org_custom_domains').insert({ org_id: orgIds[1], hostname })).error?.code).toBe('42501')
    expect((await client.from('org_custom_domains').update({ hostname }).eq('org_id', orgIds[0])).error?.code).toBe('42501')
    expect((await client.from('org_custom_domains').delete().eq('org_id', orgIds[0])).error?.code).toBe('42501')
  })
})
