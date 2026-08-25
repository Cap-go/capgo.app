import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ORG_SUPER_ADMIN,
  getAuthHeadersForCredentials,
  ORG_ID,
  USER_EMAIL,
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

  it.concurrent('blocks get_user_id for anonymous callers without distinguishable outcomes', async () => {
    const client = createAnonymousClient()

    const validKeyResult = await client.rpc('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
    })
    const invalidKeyResult = await client.rpc('get_user_id', {
      apikey: '00000000-0000-0000-0000-000000000000',
    })

    expect(isPermissionDenied(validKeyResult.error)).toBe(true)
    expect(isPermissionDenied(invalidKeyResult.error)).toBe(true)
    expect(validKeyResult.data).toBeNull()
    expect(invalidKeyResult.data).toBeNull()
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
})
