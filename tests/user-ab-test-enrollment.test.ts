import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAuthHeadersForCredentials, getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils.ts'
import { fetchPostgrest } from './db-client'

const email = `ab-enrollment-${randomUUID()}@example.com`
const password = `AbEnrollment!${randomUUID()}`
const createdAt = '2026-10-16T00:00:00+00:00'
const managed = {
  abtests: { retired_experiment: { branch: 'A', assigned_at: createdAt } },
  abtests_enrolled: ['retired_experiment'],
  abtests_bento_sync: { pending: false },
}
let userId: string
let headers: Record<string, string>

beforeAll(async () => {
  const service = getSupabaseClient()
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
  if (error)
    throw error
  userId = data.user.id
  const { error: profileError } = await service.from('users').upsert({
    id: userId,
    email,
    created_at: createdAt,
    created_via_invite: true,
    onboarding: { ...managed, intent: 'ota' },
  })
  if (profileError)
    throw profileError
  headers = await getAuthHeadersForCredentials(email, password)
})

afterAll(async () => {
  if (!userId)
    return
  await getSupabaseClient().from('users').delete().eq('id', userId)
  await getSupabaseClient().auth.admin.deleteUser(userId)
})

describe('user A/B enrollment through PostgREST', () => {
  it.concurrent('allows intent edits while preserving backend assignments, enrollment, creation time and signup provenance', async () => {
    for (const onboarding of [
      { intent: 'publish', abtests: {}, abtests_enrolled: ['forged'], abtests_bento_sync: { pending: true } },
      { intent: 'ota' },
    ]) {
      const response = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?id=eq.${userId}&select=onboarding,created_at,created_via_invite`, {
        method: 'PATCH',
        headers: { ...headers, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ onboarding, created_at: '2030-01-01T00:00:00Z', created_via_invite: false }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      const rows = await response.json() as { onboarding: unknown, created_at: string, created_via_invite: boolean }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].onboarding).toEqual({ ...managed, intent: onboarding.intent })
      expect(new Date(rows[0].created_at).toISOString()).toBe(new Date(createdAt).toISOString())
      expect(rows[0].created_via_invite).toBe(true)
    }
    const provenanceOnly = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?id=eq.${userId}&select=created_via_invite`, {
      method: 'PATCH',
      headers: { ...headers, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ created_via_invite: false }),
    })
    expect(provenanceOnly.status, await provenanceOnly.clone().text()).toBe(200)
    expect(await provenanceOnly.json()).toEqual([{ created_via_invite: true }])
    const upsert = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?on_conflict=id&select=created_via_invite`, {
      method: 'POST',
      headers: { ...headers, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id: userId, email, created_via_invite: false }),
    })
    // A successful upsert can create a row or update an existing one.
    expect([200, 201], await upsert.clone().text()).toContain(upsert.status)
    expect(await upsert.json()).toEqual([{ created_via_invite: true }])
    const { data, error } = await getSupabaseClient().from('users').update({
      onboarding: { ...managed, abtests_enrolled: ['backend-edit'], intent: 'ota' },
      created_via_invite: false,
    }).eq('id', userId).select('onboarding,created_via_invite').single()
    expect(error).toBeNull()
    expect(data?.onboarding).toEqual({ ...managed, abtests_enrolled: ['backend-edit'], intent: 'ota' })
    expect(data?.created_via_invite).toBe(false)
  })

  it.concurrent('allows normal client-created self-signup profiles without trusting a supplied invitation flag', async () => {
    const service = getSupabaseClient()
    const signupEmail = `ab-self-signup-${randomUUID()}@example.com`
    const { data, error } = await service.auth.admin.createUser({ email: signupEmail, password, email_confirm: true })
    expect(error).toBeNull()
    const signupId = data.user!.id
    try {
      const signupHeaders = await getAuthHeadersForCredentials(signupEmail, password)
      const response = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?select=created_via_invite`, {
        method: 'POST',
        headers: { ...signupHeaders, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ id: signupId, email: signupEmail, created_via_invite: true }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      expect(await response.json()).toEqual([{ created_via_invite: false }])
      const update = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?id=eq.${signupId}&select=created_via_invite`, {
        method: 'PATCH',
        headers: { ...signupHeaders, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ created_via_invite: true }),
      })
      expect(update.status, await update.clone().text()).toBe(200)
      expect(await update.json()).toEqual([{ created_via_invite: false }])
    }
    finally {
      await service.from('users').delete().eq('id', signupId)
      await service.auth.admin.deleteUser(signupId)
    }
  })
})
