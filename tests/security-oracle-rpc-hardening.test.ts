import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ORG_SUPER_ADMIN,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  ORG_ID,
  USER_EMAIL,
  USER_ID,
  USER_PASSWORD,
} from './test-utils'

function normalizeLocalhostUrl(raw: string | undefined): string {
  if (!raw)
    return ''
  try {
    const url = new URL(raw)
    if (url.hostname === 'localhost')
      url.hostname = '127.0.0.1'
    return url.toString().replace(/\/$/, '')
  }
  catch {
    return raw.replace('localhost', '127.0.0.1')
  }
}

const SUPABASE_URL = normalizeLocalhostUrl(env.SUPABASE_URL)
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY as string
const APP_ID = 'com.demo.app'

function createAnonymousClient() {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
  })
}

function createAnonymousApiKeyClient(apikey: string) {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        capgkey: apikey,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

function isPermissionDenied(error: { code?: string, message?: string } | null) {
  return error?.code === '42501' || /permission denied/i.test(error?.message ?? '')
}

function isNoRights(error: { message?: string } | null) {
  return /NO_RIGHTS/i.test(error?.message ?? '')
}

function isOrgNotFound(error: { message?: string } | null) {
  return /ORG_NOT_FOUND/i.test(error?.message ?? '')
}

describe('anonymous oracle RPC hardening', () => {
  it.concurrent('blocks invite_user_to_org_rbac for anonymous callers', async () => {
    const client = createAnonymousClient()
    const missingOrgId = randomUUID()

    const existingOrgResult = await client.rpc('invite_user_to_org_rbac', {
      email: 'oracle-test@capgo.app',
      org_id: ORG_ID,
      role_name: 'org_member',
    })
    const missingOrgResult = await client.rpc('invite_user_to_org_rbac', {
      email: 'oracle-test@capgo.app',
      org_id: missingOrgId,
      role_name: 'org_member',
    })

    expect(isPermissionDenied(existingOrgResult.error)).toBe(true)
    expect(isPermissionDenied(missingOrgResult.error)).toBe(true)
    expect(existingOrgResult.data).toBeNull()
    expect(missingOrgResult.data).toBeNull()
  })

  it.concurrent('keeps get_user_id(text) callable for published CLI anonymous callers', async () => {
    const client = createAnonymousClient()

    const validKeyResult = await client.rpc('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
    })
    const invalidKeyResult = await client.rpc('get_user_id', {
      apikey: '00000000-0000-0000-0000-000000000000',
    })

    expect(validKeyResult.error).toBeNull()
    expect(validKeyResult.data).toBe(USER_ID)
    expect(invalidKeyResult.error).toBeNull()
    expect(invalidKeyResult.data).toBeNull()
  })

  it.concurrent('keeps get_user_id(text, text) denied for anonymous callers', async () => {
    const client = createAnonymousApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const result = await client.rpc('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
      app_id: APP_ID,
    })

    expect(isPermissionDenied(result.error)).toBe(true)
    expect(result.data).toBeNull()
  })

  it.concurrent('blocks get_org_perm_for_apikey RPCs for anonymous callers', async () => {
    const client = createAnonymousApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const v1Result = await client.rpc('get_org_perm_for_apikey', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
      app_id: APP_ID,
    })
    const v2Result = await client.rpc('get_org_perm_for_apikey_v2', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
      app_id: APP_ID,
    })
    const invalidKeyResult = await client.rpc('get_org_perm_for_apikey', {
      apikey: '00000000-0000-0000-0000-000000000000',
      app_id: APP_ID,
    })

    expect(isPermissionDenied(v1Result.error)).toBe(true)
    expect(isPermissionDenied(v2Result.error)).toBe(true)
    expect(isPermissionDenied(invalidKeyResult.error)).toBe(true)
    expect(v1Result.data).toBeNull()
    expect(v2Result.data).toBeNull()
    expect(invalidKeyResult.data).toBeNull()
  })

  it.concurrent('blocks anonymous execute on member/org oracle RPCs', async () => {
    const client = createAnonymousClient()
    const missingOrgId = randomUUID()

    const revokedCalls = await Promise.all([
      client.rpc('get_org_members_rbac', { p_org_id: ORG_ID }),
      client.rpc('get_org_members_rbac', { p_org_id: missingOrgId }),
      client.rpc('is_member_of_org', { user_id: USER_ID, org_id: ORG_ID }),
      client.rpc('is_member_of_org', { user_id: USER_ID, org_id: missingOrgId }),
      client.rpc('update_org_invite_role_rbac', {
        p_org_id: ORG_ID,
        p_user_id: USER_ID,
        p_new_role_name: 'org_member',
      }),
      client.rpc('update_tmp_invite_role_rbac', {
        p_org_id: ORG_ID,
        p_email: 'oracle-test@capgo.app',
        p_new_role_name: 'org_member',
      }),
    ])

    for (const result of revokedCalls) {
      expect(isPermissionDenied(result.error)).toBe(true)
      expect(result.data).toBeNull()
    }
  })

  it.concurrent('does not leak org existence through check_org_members_2fa_enabled', async () => {
    const client = createAnonymousClient()
    const missingOrgId = randomUUID()

    const existingOrgResult = await client.rpc('check_org_members_2fa_enabled', {
      org_id: ORG_ID,
    })
    const missingOrgResult = await client.rpc('check_org_members_2fa_enabled', {
      org_id: missingOrgId,
    })

    expect(isNoRights(existingOrgResult.error)).toBe(true)
    expect(isNoRights(missingOrgResult.error)).toBe(true)
    expect(existingOrgResult.error?.message).toBe(missingOrgResult.error?.message)
    expect(existingOrgResult.data).toBeNull()
    expect(missingOrgResult.data).toBeNull()
  })

  it.concurrent('does not leak org existence through check_org_members_password_policy', async () => {
    const client = createAnonymousClient()
    const missingOrgId = randomUUID()

    const existingOrgResult = await client.rpc('check_org_members_password_policy', {
      org_id: ORG_ID,
    })
    const missingOrgResult = await client.rpc('check_org_members_password_policy', {
      org_id: missingOrgId,
    })

    expect(isNoRights(existingOrgResult.error)).toBe(true)
    expect(isNoRights(missingOrgResult.error)).toBe(true)
    expect(existingOrgResult.error?.message).toBe(missingOrgResult.error?.message)
    expect(existingOrgResult.data).toBeNull()
    expect(missingOrgResult.data).toBeNull()
  })

  it.concurrent('keeps invite_user_to_org_rbac callable for authenticated callers', async () => {
    const authHeaders = await getAuthHeadersForCredentials(USER_EMAIL, USER_PASSWORD)
    const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: authHeaders,
      },
      auth: {
        persistSession: false,
      },
    })

    const { data, error } = await client.rpc('invite_user_to_org_rbac', {
      email: `oracle-auth-${randomUUID()}@capgo.app`,
      org_id: ORG_ID,
      role_name: 'org_member',
    })

    expect(error).toBeNull()
    // Unknown email is read-only and proves authenticated execute still works.
    expect(data).toBe('NO_EMAIL')
  })

  it.concurrent('keeps revoked member/org oracle RPCs callable for authenticated callers', async () => {
    const authHeaders = await getAuthHeadersForCredentials(USER_EMAIL, USER_PASSWORD)
    const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: authHeaders,
      },
      auth: {
        persistSession: false,
      },
    })

    const members = await client.rpc('get_org_members_rbac', { p_org_id: ORG_ID })
    expect(isPermissionDenied(members.error)).toBe(false)
    expect(members.error).toBeNull()
    expect(Array.isArray(members.data)).toBe(true)
    expect((members.data ?? []).length).toBeGreaterThan(0)

    const membership = await client.rpc('is_member_of_org', {
      user_id: USER_ID,
      org_id: ORG_ID,
    })
    expect(isPermissionDenied(membership.error)).toBe(false)
    expect(membership.error).toBeNull()
    expect(membership.data).toBe(true)

    // Missing invite/user must not be EXECUTE denial — proves re-grant path.
    const missingUserId = randomUUID()
    const missingInviteEmail = `oracle-missing-invite-${randomUUID()}@capgo.app`
    const orgInviteUpdate = await client.rpc('update_org_invite_role_rbac', {
      p_org_id: ORG_ID,
      p_user_id: missingUserId,
      p_new_role_name: 'org_member',
    })
    const tmpInviteUpdate = await client.rpc('update_tmp_invite_role_rbac', {
      p_org_id: ORG_ID,
      p_email: missingInviteEmail,
      p_new_role_name: 'org_member',
    })

    expect(isPermissionDenied(orgInviteUpdate.error)).toBe(false)
    expect(isPermissionDenied(tmpInviteUpdate.error)).toBe(false)

    const orgInviteOutcome = orgInviteUpdate.error?.message ?? orgInviteUpdate.data
    const tmpInviteOutcome = tmpInviteUpdate.error?.message ?? tmpInviteUpdate.data
    expect(String(orgInviteOutcome)).toMatch(/NO_INVITATION|ROLE_NOT_FOUND/i)
    expect(String(tmpInviteOutcome)).toMatch(/NO_INVITATION|ROLE_NOT_FOUND/i)
  })
})

describe('internal missing-org distinction on org-member helpers', () => {
  it.concurrent('raises ORG_NOT_FOUND for service_role on missing org (2fa)', async () => {
    const client = getSupabaseClient()
    const missingOrgId = randomUUID()

    const missing = await client.rpc('check_org_members_2fa_enabled', {
      org_id: missingOrgId,
    })
    expect(isOrgNotFound(missing.error)).toBe(true)
    expect(missing.data).toBeNull()

    const existing = await client.rpc('check_org_members_2fa_enabled', {
      org_id: ORG_ID,
    })
    expect(existing.error).toBeNull()
    expect(Array.isArray(existing.data)).toBe(true)
  })

  it.concurrent('raises ORG_NOT_FOUND for service_role on missing org (password policy)', async () => {
    const client = getSupabaseClient()
    const missingOrgId = randomUUID()

    const missing = await client.rpc('check_org_members_password_policy', {
      org_id: missingOrgId,
    })
    expect(isOrgNotFound(missing.error)).toBe(true)
    expect(missing.data).toBeNull()

    const existing = await client.rpc('check_org_members_password_policy', {
      org_id: ORG_ID,
    })
    expect(existing.error).toBeNull()
    expect(Array.isArray(existing.data)).toBe(true)
  })

  it.concurrent('keeps authenticated missing-org as NO_RIGHTS (anon oracle closed)', async () => {
    const authHeaders = await getAuthHeadersForCredentials(USER_EMAIL, USER_PASSWORD)
    const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: authHeaders,
      },
      auth: {
        persistSession: false,
      },
    })
    const missingOrgId = randomUUID()

    const twoFa = await client.rpc('check_org_members_2fa_enabled', {
      org_id: missingOrgId,
    })
    const password = await client.rpc('check_org_members_password_policy', {
      org_id: missingOrgId,
    })

    expect(isNoRights(twoFa.error)).toBe(true)
    expect(isNoRights(password.error)).toBe(true)
    expect(isOrgNotFound(twoFa.error)).toBe(false)
    expect(isOrgNotFound(password.error)).toBe(false)
  })
})