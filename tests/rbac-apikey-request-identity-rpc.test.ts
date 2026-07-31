import type { Database } from '../src/types/supabase.types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_APP_UPLOADER, APIKEY_TEST_ORG_SUPER_ADMIN, getAuthHeadersForCredentials, getSupabaseClient, ORG_ID, USER_EMAIL, USER_ID, USER_PASSWORD } from './test-utils'

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
const SUPABASE_SERVICE_KEY = (env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY) as string
const APIKEY_TEST_APP_READER = '67eeaff4-ae4c-49a6-8eb1-0875f5369de0'
const APP_ID = 'com.demo.app'

function isRetryableRpcTransportError(error: { message?: string } | null) {
  return error?.message?.includes('fetch failed') === true
}

async function requestActorUserId(client: SupabaseClient<Database>) {
  let result: Awaited<ReturnType<typeof client.rpc<'request_actor_user_id'>>>

  for (let attempt = 0; attempt < 3; attempt++) {
    result = await client.rpc('request_actor_user_id')
    if (!isRetryableRpcTransportError(result.error) || attempt === 2)
      return result

    await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
  }

  return result!
}

async function createAuthenticatedClient() {
  const authHeaders = await getAuthHeadersForCredentials(USER_EMAIL, USER_PASSWORD)

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        ...authHeaders,
        capgkey: APIKEY_TEST_ORG_SUPER_ADMIN,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

function createApiKeyClient(apikey: string) {
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

describe('request_actor_user_id RPC permissions', () => {
  it.concurrent('allows anonymous API-key request identity resolution', async () => {
    const supabaseAnon = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { capgkey: APIKEY_TEST_ORG_SUPER_ADMIN } },
    })

    const { data, error } = await requestActorUserId(supabaseAnon)

    expect(error).toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent('allows service role API-key request identity resolution', async () => {
    const supabaseServiceRole = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      global: { headers: { capgkey: APIKEY_TEST_ORG_SUPER_ADMIN } },
    })

    const { data, error } = await requestActorUserId(supabaseServiceRole)

    expect(error).toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent('prefers the JWT actor when both JWT and API key headers are present', async () => {
    const supabaseAuthenticated = await createAuthenticatedClient()

    const { data, error } = await requestActorUserId(supabaseAuthenticated)

    expect(error).toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent('returns null for invalid API key on service role', async () => {
    const supabaseServiceRole = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      global: { headers: { capgkey: '00000000-0000-0000-0000-000000000000' } },
    })

    const { data, error } = await requestActorUserId(supabaseServiceRole)

    expect(error).toBeNull()
    expect(data).toBeNull()
  })
})

describe('legacy CLI RBAC compatibility RPCs', () => {
  it.concurrent('keeps old API-key mode checks backed by RBAC bindings only', async () => {
    const uploaderClient = createApiKeyClient(APIKEY_TEST_APP_UPLOADER)

    const { data: uploadAllowed, error: uploadAllowedError } = await (uploaderClient.rpc as any)('is_allowed_capgkey', {
      apikey: APIKEY_TEST_APP_UPLOADER,
      keymode: ['upload'],
    }).single()
    const { data: writeAllowed, error: writeAllowedError } = await (uploaderClient.rpc as any)('is_allowed_capgkey', {
      apikey: APIKEY_TEST_APP_UPLOADER,
      keymode: ['write', 'all'],
    }).single()

    expect(uploadAllowedError).toBeNull()
    expect(uploadAllowed).toBe(true)
    expect(writeAllowedError).toBeNull()
    expect(writeAllowed).toBe(false)
  })

  it.concurrent('keeps app-scoped old mode checks on the RBAC permission graph', async () => {
    const readerClient = createApiKeyClient(APIKEY_TEST_APP_READER)

    const { data: readAllowed, error: readAllowedError } = await (readerClient.rpc as any)('is_allowed_capgkey', {
      apikey: APIKEY_TEST_APP_READER,
      keymode: ['read'],
      appid: APP_ID,
    }).single()
    const { data: uploadAllowed, error: uploadAllowedError } = await (readerClient.rpc as any)('is_allowed_capgkey', {
      apikey: APIKEY_TEST_APP_READER,
      keymode: ['upload', 'write', 'all'],
      appid: APP_ID,
    }).single()

    expect(readAllowedError).toBeNull()
    expect(readAllowed).toBe(true)
    expect(uploadAllowedError).toBeNull()
    expect(uploadAllowed).toBe(false)
  })

  it.concurrent('keeps old permission rank RPCs without restoring old right columns', async () => {
    const uploaderClient = createApiKeyClient(APIKEY_TEST_APP_UPLOADER)
    const readerClient = createApiKeyClient(APIKEY_TEST_APP_READER)
    const ownerClient = createApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const { data: uploaderPerm, error: uploaderError } = await (uploaderClient.rpc as any)('get_org_perm_for_apikey', {
      apikey: APIKEY_TEST_APP_UPLOADER,
      app_id: APP_ID,
    }).single()
    const { data: readerPerm, error: readerError } = await (readerClient.rpc as any)('get_org_perm_for_apikey_v2', {
      apikey: APIKEY_TEST_APP_READER,
      app_id: APP_ID,
    }).single()
    const { data: ownerPerm, error: ownerError } = await (ownerClient.rpc as any)('get_org_perm_for_apikey', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
      app_id: APP_ID,
    }).single()

    expect(uploaderError).toBeNull()
    expect(uploaderPerm).toBe('perm_upload')
    expect(readerError).toBeNull()
    expect(readerPerm).toBe('perm_read')
    expect(ownerError).toBeNull()
    expect(ownerPerm).toBe('perm_owner')
  })

  it.concurrent('keeps get_user_id callable for old anon CLI clients', async () => {
    const client = createApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const { data, error } = await (client.rpc as any)('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
    }).single()

    expect(error).toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent('keeps old app existence RPC authorized by RBAC', async () => {
    const readerClient = createApiKeyClient(APIKEY_TEST_APP_READER)
    const anonymousClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })

    const { data: allowed, error: allowedError } = await (readerClient.rpc as any)('exist_app', {
      appid: APP_ID,
    }).single()
    const { data: denied, error: deniedError } = await (anonymousClient.rpc as any)('exist_app', {
      appid: APP_ID,
    }).single()

    expect(allowedError).toBeNull()
    expect(allowed).toBe(true)
    expect(deniedError).toBeNull()
    expect(denied).toBe(false)
  })
})

describe('app_versions RBAC update policy', () => {
  it.concurrent('lets upload-only API keys update bundle metadata but not mark bundles deleted', async () => {
    const adminClient = getSupabaseClient()
    const uploaderClient = createApiKeyClient(APIKEY_TEST_APP_UPLOADER)
    const versionName = `rls-upload-only-${randomUUID()}`

    const { data: version, error: insertError } = await adminClient
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: versionName,
        owner_org: ORG_ID,
        user_id: USER_ID,
        deleted: false,
        storage_provider: 'r2',
      })
      .select('id')
      .single()

    expect(insertError).toBeNull()
    expect(version?.id).toBeTypeOf('number')

    try {
      const { data: metadataUpdate, error: metadataError } = await uploaderClient
        .from('app_versions')
        .update({ comment: 'upload-only metadata update' })
        .eq('id', version!.id)
        .select('id, comment, deleted')

      expect(metadataError).toBeNull()
      expect(metadataUpdate).toEqual([{
        id: version!.id,
        comment: 'upload-only metadata update',
        deleted: false,
      }])

      const { data: deletedUpdate, error: deletedError } = await uploaderClient
        .from('app_versions')
        .update({ deleted: true })
        .eq('id', version!.id)
        .select('id, deleted')

      if (deletedError) {
        expect(deletedError.message.toLowerCase()).toContain('row')
      }
      else {
        expect(deletedUpdate).toEqual([])
      }

      const { data: persisted, error: persistedError } = await adminClient
        .from('app_versions')
        .select('comment, deleted')
        .eq('id', version!.id)
        .single()

      expect(persistedError).toBeNull()
      expect(persisted).toEqual({
        comment: 'upload-only metadata update',
        deleted: false,
      })
    }
    finally {
      await adminClient.from('app_versions').delete().eq('id', version!.id)
    }
  })
})
