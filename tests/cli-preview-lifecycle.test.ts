import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  appApiKeyBindings,
  BASE_URL,
  createIsolatedSeedAppOptions,
  executeSQL,
  getAuthHeaders,
  resetAndSeedAppData,
  resetAppData,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
} from './test-utils.ts'

vi.mock('../cli/src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/utils')>()
  const { createClient } = await import('@supabase/supabase-js')

  return {
    ...actual,
    createSupabaseClient: async (apikey: string, supaHost?: string, supaAnon?: string) => {
      if (!supaHost || !supaAnon)
        throw new Error('CLI preview lifecycle test requires a local Supabase host and anon key')

      return createClient(supaHost, supaAnon, {
        auth: {
          persistSession: false,
        },
        global: {
          headers: {
            capgkey: apikey,
          },
        },
      })
    },
    checkPlanValid: async () => {},
    checkPlanValidUpload: async () => {},
    checkRemoteCliMessages: async () => {},
    getConfig: async () => ({ config: {} }),
    getRemoteFileConfig: async () => ({
      alertUploadSize: 1_000_000,
      maxChunkSize: 1_000_000,
      maxUploadLength: 1_000_000,
      partialUpload: false,
      partialUploadForced: false,
      TUSUpload: false,
      TUSUploadForced: false,
    }),
    sendEvent: async () => {},
  }
})

vi.mock('../cli/src/api/app', async importOriginal => ({
  ...await importOriginal<typeof import('../cli/src/api/app')>(),
  check2FAComplianceForApp: async () => {},
}))

vi.mock('../cli/src/api/update', async importOriginal => ({
  ...await importOriginal<typeof import('../cli/src/api/update')>(),
  checkAlerts: async () => {},
}))

vi.mock('../cli/src/analytics/track', async importOriginal => ({
  ...await importOriginal<typeof import('../cli/src/analytics/track')>(),
  trackEvent: async () => {},
}))

const { uploadBundleInternal } = await import('../cli/src/bundle/upload.ts')
const { addChannelInternal } = await import('../cli/src/channel/add.ts')
const { deleteChannelInternal } = await import('../cli/src/channel/delete.ts')
const { setChannelInternal } = await import('../cli/src/channel/set.ts')

const id = randomUUID()
const APPNAME = `com.cli.preview.lifecycle.${id}`
const CHANNEL_NAME = `preview-${id.slice(0, 8)}`
const SECOND_CHANNEL_NAME = `preview-other-${id.slice(0, 8)}`
const MAIN_CHANNEL_NAME = `main-${id.slice(0, 8)}`
const BUNDLE_NAME = `1.0.0-preview-${id.slice(0, 8)}`
const LEGACY_CHANNEL_NAME = `preview-legacy-${id.slice(0, 8)}`
const LEGACY_BUNDLE_NAME = `1.0.0-legacy-${id.slice(0, 8)}`
const LEGACY_PARTIAL_CHANNEL_NAME = `preview-legacy-partial-${id.slice(0, 8)}`
const LEGACY_PARTIAL_BUNDLE_NAME = `1.0.0-legacy-partial-${id.slice(0, 8)}`
const seedOptions = createIsolatedSeedAppOptions()

interface ApiKeyResponse {
  id: number
  key: string
  rbac_id: string
}

function requestTrace(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const request = input instanceof Request ? input : undefined
  const url = request?.url ?? (input instanceof URL ? input.href : input)
  return {
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    path: new URL(url).pathname,
  }
}

let authHeaders: Record<string, string>
const apiKeyIds: number[] = []

async function createAppApiKey(name: string, roleName = 'app_preview'): Promise<ApiKeyResponse> {
  const createResponse = await fetch(`${BASE_URL}/apikey`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name,
      bindings: await appApiKeyBindings(APPNAME, roleName),
    }),
  })

  expect(createResponse.status).toBe(200)
  const apiKey = await createResponse.json<ApiKeyResponse>()
  apiKeyIds.push(apiKey.id)
  expect(apiKey.key).toBeTruthy()
  return apiKey
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
  await resetAndSeedAppData(APPNAME, seedOptions)
})

afterAll(async () => {
  try {
    for (const apiKeyId of apiKeyIds) {
      const deleteResponse = await fetch(`${BASE_URL}/apikey/${apiKeyId}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      expect(deleteResponse.status).toBe(200)
    }
  }
  finally {
    await resetAppData(APPNAME)
  }
})

describe('cli app preview lifecycle', () => {
  it('creates and exclusively manages its own preview channel and bundle', async () => {
    const [app] = await executeSQL(
      `SELECT owner_org::text AS owner_org, user_id::text AS user_id
       FROM public.apps
       WHERE app_id = $1`,
      [APPNAME],
    )
    expect(app).toEqual(expect.objectContaining({
      owner_org: expect.any(String),
      user_id: expect.any(String),
    }))

    await executeSQL(
      `INSERT INTO public.channels (name, app_id, owner_org, created_by, version, public)
       VALUES ($1, $2, $3::uuid, $4::uuid, NULL, true)`,
      [MAIN_CHANNEL_NAME, APPNAME, app.owner_org, app.user_id],
    )
    const apiKey = await createAppApiKey(`cli-app-preview-${id}`)
    const bindings = await executeSQL(
      `SELECT
         role_bindings.id::text AS id,
         role_bindings.scope_type,
         role_bindings.org_id::text AS org_id,
         role_bindings.app_id::text AS app_id,
         apps.id::text AS expected_app_id,
         roles.name AS role_name
       FROM public.role_bindings
       INNER JOIN public.roles ON roles.id = role_bindings.role_id
       LEFT JOIN public.apps ON apps.id = role_bindings.app_id
       WHERE role_bindings.principal_type = public.rbac_principal_apikey()
         AND role_bindings.principal_id = $1::uuid
       ORDER BY role_bindings.scope_type, roles.name`,
      [apiKey.rbac_id],
    )
    expect(bindings).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        scope_type: 'app',
        org_id: app.owner_org,
        role_name: 'app_preview',
        app_id: expect.any(String),
        expected_app_id: expect.any(String),
      }),
    ])
    expect(bindings[0]?.app_id).toBe(bindings[0]?.expected_app_id)

    const previewPermissionRows = await executeSQL(
      `SELECT permissions.key
       FROM public.role_bindings
       INNER JOIN public.roles ON roles.id = role_bindings.role_id
       INNER JOIN public.role_permissions ON role_permissions.role_id = roles.id
       INNER JOIN public.permissions ON permissions.id = role_permissions.permission_id
       WHERE role_bindings.principal_type = public.rbac_principal_apikey()
         AND role_bindings.principal_id = $1::uuid
         AND roles.name = 'app_preview'
       ORDER BY permissions.key`,
      [apiKey.rbac_id],
    )
    expect(previewPermissionRows.map(permission => permission.key)).toEqual([
      'app.create_channel',
      'app.read',
      'app.read_bundles',
      'app.upload_bundle',
    ])

    const apiKeyClient = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
      global: {
        headers: {
          capgkey: apiKey.key,
        },
      },
    })
    const [
      { data: appExists, error: appExistsError },
      { data: canCreateChannel, error: createChannelPermissionError },
      { data: canPromoteAtAppScope, error: appScopePromotionPermissionError },
    ] = await Promise.all([
      apiKeyClient.rpc('exist_app_v2', { appid: APPNAME }).single(),
      apiKeyClient.rpc('cli_check_permission', {
        apikey: apiKey.key,
        permission_key: 'app.create_channel',
        org_id: null,
        app_id: APPNAME,
        channel_id: null,
      }),
      apiKeyClient.rpc('cli_check_permission', {
        apikey: apiKey.key,
        permission_key: 'channel.promote_bundle',
        org_id: null,
        app_id: APPNAME,
        channel_id: null,
      }),
    ])
    expect(appExistsError).toBeNull()
    expect(appExists).toBe(true)
    expect(createChannelPermissionError).toBeNull()
    expect(canCreateChannel).toBe(true)
    expect(appScopePromotionPermissionError).toBeNull()
    expect(canPromoteAtAppScope).toBe(false)

    const cliOptions = {
      apikey: apiKey.key,
      supaHost: SUPABASE_BASE_URL,
      supaAnon: SUPABASE_ANON_KEY,
    }

    const { upload, requests } = await (async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      try {
        const upload = await uploadBundleInternal(APPNAME, {
          ...cliOptions,
          path: '.',
          bundle: BUNDLE_NAME,
          channel: CHANNEL_NAME,
          external: 'https://example.invalid/preview.zip',
          codeCheck: false,
          ignoreMetadataCheck: true,
          ignoreChecksumCheck: true,
        }, true)
        return {
          upload,
          requests: fetchSpy.mock.calls.map(([input, init]) => requestTrace(input, init)),
        }
      }
      finally {
        fetchSpy.mockRestore()
      }
    })()
    expect(upload).toMatchObject({
      success: true,
      appId: APPNAME,
      bundle: BUNDLE_NAME,
      updatedChannels: [CHANNEL_NAME],
    })
    const channelPostIndex = requests.findIndex(request => request.method === 'POST' && request.path === '/functions/v1/channel')
    expect(channelPostIndex).toBeGreaterThanOrEqual(0)
    expect(requests).not.toContainEqual({ method: 'POST', path: '/rest/v1/rpc/get_app_versions' })
    expect(requests.slice(channelPostIndex + 1)).not.toContainEqual({ method: 'GET', path: '/rest/v1/channels' })

    const [createdChannel] = await executeSQL(
      `SELECT id, rbac_id::text AS rbac_id
       FROM public.channels
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, CHANNEL_NAME],
    )
    expect(createdChannel).toEqual(expect.objectContaining({
      id: expect.any(String),
      rbac_id: expect.any(String),
    }))

    const childBindings = await executeSQL(
      `SELECT
         child_binding.scope_type,
         child_binding.org_id::text AS org_id,
         child_binding.app_id::text AS app_id,
         child_binding.channel_id::text AS channel_id,
         child_binding.parent_binding_id::text AS parent_binding_id,
         child_role.name AS role_name
       FROM public.role_bindings AS child_binding
       INNER JOIN public.roles AS child_role ON child_role.id = child_binding.role_id
       WHERE child_binding.principal_type = public.rbac_principal_apikey()
         AND child_binding.principal_id = $1::uuid
         AND child_binding.channel_id = $2::uuid`,
      [apiKey.rbac_id, createdChannel.rbac_id],
    )
    expect(childBindings).toEqual([
      expect.objectContaining({
        scope_type: 'channel',
        org_id: app.owner_org,
        app_id: bindings[0]?.app_id,
        channel_id: createdChannel.rbac_id,
        parent_binding_id: bindings[0]?.id,
        role_name: 'channel_preview',
      }),
    ])

    await expect(deleteChannelInternal(MAIN_CHANNEL_NAME, APPNAME, {
      ...cliOptions,
      deleteBundle: false,
      successIfNotFound: false,
    }, true)).rejects.toThrow('channel.delete')

    const otherApiKey = await createAppApiKey(`cli-app-preview-other-${id}`)
    const otherCliOptions = {
      apikey: otherApiKey.key,
      supaHost: SUPABASE_BASE_URL,
      supaAnon: SUPABASE_ANON_KEY,
    }
    await expect(addChannelInternal(SECOND_CHANNEL_NAME, APPNAME, otherCliOptions, true))
      .resolves
      .toMatchObject({ name: SECOND_CHANNEL_NAME })
    await expect(deleteChannelInternal(SECOND_CHANNEL_NAME, APPNAME, {
      ...cliOptions,
      deleteBundle: false,
      successIfNotFound: false,
    }, true)).rejects.toThrow('channel.delete')

    const [bundle] = await executeSQL(
      `SELECT id, created_by_apikey_rbac_id::text AS created_by_apikey_rbac_id
       FROM public.app_versions
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, BUNDLE_NAME],
    )
    expect(bundle).toEqual(expect.objectContaining({
      id: expect.anything(),
      created_by_apikey_rbac_id: apiKey.rbac_id,
    }))
    const bundleId = Number(bundle?.id)
    expect(Number.isSafeInteger(bundleId)).toBe(true)

    const [promotedChannel] = await executeSQL(
      `SELECT version
       FROM public.channels
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, CHANNEL_NAME],
    )
    expect(Number(promotedChannel?.version)).toBe(bundleId)

    await expect(deleteChannelInternal(CHANNEL_NAME, APPNAME, {
      ...cliOptions,
      deleteBundle: true,
      successIfNotFound: false,
    }, true)).resolves.toBe(true)

    const remainingChannels = await executeSQL(
      `SELECT COUNT(*)::integer AS count
       FROM public.channels
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, CHANNEL_NAME],
    )
    expect(Number(remainingChannels[0]?.count ?? 0)).toBe(0)

    const [deletedBundle] = await executeSQL(
      `SELECT deleted, created_by_apikey_rbac_id::text AS created_by_apikey_rbac_id
       FROM public.app_versions
       WHERE id = $1`,
      [bundle?.id],
    )
    expect(deletedBundle).toEqual({
      deleted: true,
      created_by_apikey_rbac_id: apiKey.rbac_id,
    })

    const remainingMainChannels = await executeSQL(
      `SELECT COUNT(*)::integer AS count
       FROM public.channels
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, MAIN_CHANNEL_NAME],
    )
    expect(Number(remainingMainChannels[0]?.count ?? 0)).toBe(1)
  }, 60_000)
  it('reads back legacy channel creation responses without metadata', async () => {
    const apiKey = await createAppApiKey(`cli-app-preview-legacy-${id}`)
    const cliOptions = {
      apikey: apiKey.key,
      supaHost: SUPABASE_BASE_URL,
      supaAnon: SUPABASE_ANON_KEY,
    }
    const originalFetch = globalThis.fetch

    const { upload, requests } = await (async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const response = await originalFetch(input, init)
        const request = requestTrace(input, init)
        if (response.ok && request.method === 'POST' && request.path === '/functions/v1/channel') {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        return response
      })
      try {
        const upload = await uploadBundleInternal(APPNAME, {
          ...cliOptions,
          path: '.',
          bundle: LEGACY_BUNDLE_NAME,
          channel: LEGACY_CHANNEL_NAME,
          bundleUrl: true,
          external: 'https://example.invalid/legacy-preview.zip',
          codeCheck: false,
          ignoreMetadataCheck: true,
          ignoreChecksumCheck: true,
        }, true)
        return {
          upload,
          requests: fetchSpy.mock.calls.map(([input, init]) => requestTrace(input, init)),
        }
      }
      finally {
        fetchSpy.mockRestore()
      }
    })()

    expect(upload).toMatchObject({
      success: true,
      appId: APPNAME,
      bundle: LEGACY_BUNDLE_NAME,
      updatedChannels: [LEGACY_CHANNEL_NAME],
    })
    const channelPostIndex = requests.findIndex(request => request.method === 'POST' && request.path === '/functions/v1/channel')
    expect(channelPostIndex).toBeGreaterThanOrEqual(0)
    expect(requests).not.toContainEqual({ method: 'POST', path: '/rest/v1/rpc/get_app_versions' })
    expect(requests.slice(channelPostIndex + 1)).toContainEqual({ method: 'GET', path: '/rest/v1/channels' })

    await expect(deleteChannelInternal(LEGACY_CHANNEL_NAME, APPNAME, {
      ...cliOptions,
      deleteBundle: true,
      successIfNotFound: false,
    }, true)).resolves.toBe(true)
  }, 60_000)
  it('retains a legacy channel ID when public metadata and readback are unavailable', async () => {
    const apiKey = await createAppApiKey(`cli-app-preview-legacy-partial-${id}`)
    const cliOptions = {
      apikey: apiKey.key,
      supaHost: SUPABASE_BASE_URL,
      supaAnon: SUPABASE_ANON_KEY,
    }
    const { log } = await import(new URL('../cli/node_modules/@clack/prompts', import.meta.url).href)
    const logInfo = vi.spyOn(log, 'info')
    const originalFetch = globalThis.fetch
    let createdChannelId: number | undefined

    try {
      const { upload, requests } = await (async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const request = requestTrace(input, init)
          if (createdChannelId != null && request.method === 'GET' && request.path === '/rest/v1/channels') {
            return new Response(JSON.stringify({ message: 'Readback unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          }

          const response = await originalFetch(input, init)
          if (response.ok && request.method === 'POST' && request.path === '/functions/v1/channel') {
            const createdChannel = await response.clone().json() as { id?: unknown }
            createdChannelId = Number(createdChannel.id)
            return new Response(JSON.stringify({ id: createdChannelId }), {
              status: response.status,
              headers: { 'content-type': 'application/json' },
            })
          }
          return response
        })
        try {
          const upload = await uploadBundleInternal(APPNAME, {
            ...cliOptions,
            path: '.',
            bundle: LEGACY_PARTIAL_BUNDLE_NAME,
            channel: LEGACY_PARTIAL_CHANNEL_NAME,
            bundleUrl: true,
            external: 'https://example.invalid/legacy-partial-preview.zip',
            codeCheck: false,
            ignoreMetadataCheck: true,
            ignoreChecksumCheck: true,
          }, true)
          return {
            upload,
            requests: fetchSpy.mock.calls.map(([input, init]) => requestTrace(input, init)),
          }
        }
        finally {
          fetchSpy.mockRestore()
        }
      })()

      expect(Number.isSafeInteger(createdChannelId)).toBe(true)
      expect(upload).toMatchObject({
        success: true,
        appId: APPNAME,
        bundle: LEGACY_PARTIAL_BUNDLE_NAME,
        updatedChannels: [LEGACY_PARTIAL_CHANNEL_NAME],
      })
      expect(requests).toContainEqual({ method: 'GET', path: '/rest/v1/channels' })
      expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`Link device to this bundle to try it: `))
      expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`/app/${APPNAME}/channel/${createdChannelId}`))
    }
    finally {
      logInfo.mockRestore()
    }

    await expect(deleteChannelInternal(LEGACY_PARTIAL_CHANNEL_NAME, APPNAME, {
      ...cliOptions,
      deleteBundle: true,
      successIfNotFound: false,
    }, true)).resolves.toBe(true)
  }, 60_000)
  it('keeps generic app-admin bundle cleanup behavior unchanged', async () => {
    const genericChannelName = `admin-${id.slice(0, 8)}`
    const genericBundleName = `1.0.0-admin-${id.slice(0, 8)}`
    const [app] = await executeSQL(
      `SELECT owner_org::text AS owner_org
       FROM public.apps
       WHERE app_id = $1`,
      [APPNAME],
    )

    const apiKey = await createAppApiKey(`cli-app-admin-${id}`, 'app_admin')
    const apiKeyClient = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { capgkey: apiKey.key } },
    })
    const cliOptions = {
      apikey: apiKey.key,
      supaHost: SUPABASE_BASE_URL,
      supaAnon: SUPABASE_ANON_KEY,
    }

    const { data: canDeleteBundle, error: canDeleteBundleError } = await apiKeyClient.rpc('cli_check_permission', {
      apikey: apiKey.key,
      permission_key: 'bundle.delete',
      org_id: null,
      app_id: APPNAME,
      channel_id: null,
    })
    expect(canDeleteBundleError).toBeNull()
    expect(canDeleteBundle).toBe(true)

    await expect(addChannelInternal(genericChannelName, APPNAME, cliOptions, true))
      .resolves
      .toMatchObject({ name: genericChannelName })

    const { data: uploaderUserId, error: uploaderUserError } = await apiKeyClient
      .rpc('get_user_id', { apikey: apiKey.key })
      .single()
    expect(uploaderUserError).toBeNull()
    expect(uploaderUserId).toEqual(expect.any(String))

    const { data: bundle, error: bundleError } = await apiKeyClient
      .from('app_versions')
      .insert({
        app_id: APPNAME,
        checksum: `admin-checksum-${id}`,
        name: genericBundleName,
        native_packages: [],
        owner_org: app.owner_org,
        storage_provider: 'r2-direct',
        user_id: uploaderUserId,
      })
      .select('id')
      .single()
    expect(bundleError).toBeNull()
    expect(bundle).toEqual(expect.objectContaining({ id: expect.any(Number) }))

    await expect(setChannelInternal(genericChannelName, APPNAME, {
      ...cliOptions,
      bundle: genericBundleName,
      ignoreMetadataCheck: true,
    }, true)).resolves.toBe(true)

    await expect(deleteChannelInternal(genericChannelName, APPNAME, {
      ...cliOptions,
      deleteBundle: true,
      successIfNotFound: false,
    }, true)).resolves.toBe(true)

    const [deletedBundle] = await executeSQL(
      `SELECT deleted
       FROM public.app_versions
       WHERE id = $1`,
      [bundle?.id],
    )
    expect(deletedBundle).toEqual({ deleted: true })

    const remainingChannels = await executeSQL(
      `SELECT COUNT(*)::integer AS count
       FROM public.channels
       WHERE app_id = $1 AND name = $2`,
      [APPNAME, genericChannelName],
    )
    expect(Number(remainingChannels[0]?.count ?? 0)).toBe(0)
  }, 60_000)
})
