import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOrgOwnedByUser,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  POSTGRES_URL,
  setAuthenticatedClaim,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_ID,
} from './test-utils.ts'
import { fetchPostgrest } from './db-client'

const password = `EmailFromAuth!${randomUUID()}`
const ownEmail = `email-from-auth-${randomUUID()}@example.com`
const otherEmail = `email-from-auth-other-${randomUUID()}@example.com`
let userId: string
let headers: Record<string, string>

beforeAll(async () => {
  const service = getSupabaseClient()
  const { data, error } = await service.auth.admin.createUser({ email: ownEmail, password, email_confirm: true })
  if (error)
    throw error
  userId = data.user.id
  const { error: profileError } = await service.from('users').upsert({ id: userId, email: ownEmail })
  if (profileError)
    throw profileError
  headers = await getAuthHeadersForCredentials(ownEmail, password)
})

afterAll(async () => {
  if (!userId)
    return
  await getSupabaseClient().from('users').delete().eq('id', userId)
  await getSupabaseClient().auth.admin.deleteUser(userId)
})

function restHeaders(extra: Record<string, string>) {
  return { ...headers, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...extra }
}

describe('public.users.email follows the auth email', () => {
  it('ignores a client PATCH of the profile email while keeping other profile edits', async () => {
    const response = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?id=eq.${userId}&select=email,first_name`, {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ email: otherEmail, first_name: 'Renamed' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual([{ email: ownEmail, first_name: 'Renamed' }])

    const upsert = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?on_conflict=id&select=email`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify({ id: userId, email: otherEmail }),
    })
    expect([200, 201], await upsert.clone().text()).toContain(upsert.status)
    expect(await upsert.json()).toEqual([{ email: ownEmail }])

    const { data } = await getSupabaseClient().from('users').select('email').eq('id', userId).single()
    expect(data?.email).toBe(ownEmail)

    // A drifted profile email is realigned even when the client repeats it.
    const { error: driftError } = await getSupabaseClient().from('users').update({ email: otherEmail }).eq('id', userId)
    expect(driftError).toBeNull()
    const repeat = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?id=eq.${userId}&select=email`, {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ email: otherEmail }),
    })
    expect(repeat.status, await repeat.clone().text()).toBe(200)
    expect(await repeat.json()).toEqual([{ email: ownEmail }])
  })

  it('stores the auth email when a client creates its own profile row', async () => {
    const service = getSupabaseClient()
    const signupEmail = `email-from-auth-signup-${randomUUID()}@example.com`
    const { data, error } = await service.auth.admin.createUser({ email: signupEmail, password, email_confirm: true })
    expect(error).toBeNull()
    const signupId = data.user!.id
    try {
      const signupHeaders = await getAuthHeadersForCredentials(signupEmail, password)
      const response = await fetchPostgrest(`${SUPABASE_BASE_URL}/rest/v1/users?select=email`, {
        method: 'POST',
        headers: { ...signupHeaders, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ id: signupId, email: otherEmail }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      expect(await response.json()).toEqual([{ email: signupEmail }])
    }
    finally {
      await service.from('users').delete().eq('id', signupId)
      await service.auth.admin.deleteUser(signupId)
    }
  })
})

// Invite resolution runs in a rolled-back transaction on a single connection so
// SET LOCAL ROLE and JWT claims stick.
describe('invite_user_to_org_rbac invitee resolution', () => {
  let pool: Pool
  let client: PoolClient
  const query = (text: string, params?: Array<string | number | null>) => client.query(text, params)

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    try {
      await query('ROLLBACK')
    }
    finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createAccount(authEmail: string, confirmed: boolean, profileEmail = authEmail) {
    const id = randomUUID()
    await query(
      'INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1::uuid, $2, CASE WHEN $3 THEN now() ELSE NULL END)',
      [id, authEmail, confirmed ? 'true' : 'false'],
    )
    // Direct backend write: simulates a profile email that drifted from auth.
    await query('INSERT INTO public.users (id, email) VALUES ($1::uuid, $2)', [id, profileEmail])
    return id
  }

  async function invite(email: string, orgId: string) {
    const { rows } = await query('SELECT public.invite_user_to_org_rbac($1::varchar, $2::uuid, $3::text) AS result', [email, orgId, 'org_admin'])
    return rows[0].result as string
  }

  async function pendingInviteCount(orgId: string, inviteeId: string) {
    const { rows } = await query(
      'SELECT count(*)::int AS count FROM public.org_users WHERE org_id = $1::uuid AND user_id = $2::uuid',
      [orgId, inviteeId],
    )
    return rows[0].count as number
  }

  it('only binds invitations to an account whose confirmed auth email matches', async () => {
    const targetEmail = `invite-target-${randomUUID()}@example.com`
    const confirmedEmail = `invite-confirmed-${randomUUID()}@example.com`
    const unconfirmedEmail = `invite-unconfirmed-${randomUUID()}@example.com`
    const mismatchedProfileId = await createAccount(`invite-other-${randomUUID()}@example.com`, true, targetEmail)
    const unconfirmedId = await createAccount(unconfirmedEmail, false)
    const confirmedId = await createAccount(confirmedEmail, true)
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite email resolution org')

    await setAuthenticatedClaim(query, USER_ID)

    expect(await invite(targetEmail, orgId)).toBe('NO_EMAIL')
    expect(await invite(unconfirmedEmail, orgId)).toBe('NO_EMAIL')
    expect(await invite(confirmedEmail, orgId)).toBe('OK')

    expect(await pendingInviteCount(orgId, mismatchedProfileId)).toBe(0)
    expect(await pendingInviteCount(orgId, unconfirmedId)).toBe(0)
    expect(await pendingInviteCount(orgId, confirmedId)).toBe(1)
  })
})
