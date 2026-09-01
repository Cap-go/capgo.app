import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDirectApiKeyWithBindings,
  executeSQL,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  ORG_ID_2,
  resetAndSeedAppData,
  resetAppData,
  USER_ID,
} from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.cli.upload.http.${id}`
const OTHER_ORG_ID = ORG_ID_2

let scopedHeaders: Record<string, string>
let scopedApiKeyId: number | undefined
let scopedApiKeyRbacId: string | undefined
const extraApiKeys: Array<{ id: number, rbac_id: string }> = []

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)

  const apiKey = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `cli-upload-http-${id}`,
    orgId: ORG_ID,
    roleName: 'org_member',
    appId: APPNAME,
    appRoleName: 'app_developer',
  })
  if (!apiKey.key)
    throw new Error('Failed to create scoped API key')

  scopedApiKeyId = apiKey.id
  scopedApiKeyRbacId = apiKey.rbac_id
  scopedHeaders = {
    'Content-Type': 'application/json',
    capgkey: apiKey.key,
  }
})

afterAll(async () => {
  const rbacIds = [
    ...extraApiKeys.map(key => key.rbac_id),
    ...(scopedApiKeyRbacId ? [scopedApiKeyRbacId] : []),
  ]
  const apiKeyIds = [
    ...extraApiKeys.map(key => key.id),
    ...(scopedApiKeyId !== undefined ? [scopedApiKeyId] : []),
  ]
  for (const rbacId of rbacIds) {
    try {
      await executeSQL(
        `DELETE FROM public.role_bindings
         WHERE principal_type = public.rbac_principal_apikey()
           AND principal_id = $1::uuid`,
        [rbacId],
      )
    }
    catch (error) {
      console.warn(`Failed to clean up role_binding ${rbacId}:`, error)
    }
  }
  for (const apiKeyId of apiKeyIds) {
    try {
      await executeSQL('DELETE FROM public.apikeys WHERE id = $1', [apiKeyId])
    }
    catch (error) {
      console.warn(`Failed to clean up API key ${apiKeyId}:`, error)
    }
  }
  await resetAppData(APPNAME)
})

describe('private/cli upload helpers', () => {
  it('rejects check-plan-upload for an org the apikey cannot read', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan-upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: OTHER_ORG_ID }),
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(401)
    expect(data.error).toBe('not_authorized')
  })

  it('rejects check-plan-upload when app_id belongs to another org', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan-upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: OTHER_ORG_ID, app_id: APPNAME }),
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(403)
    expect(data.error).toBe('org_mismatch')
  })

  it('rejects warnings for an org the apikey cannot read', async () => {
    const response = await fetch(`${getEndpointUrl('/private/cli/warnings')}?org_id=${encodeURIComponent(OTHER_ORG_ID)}&cli_version=99.0.0-test`, {
      method: 'GET',
      headers: scopedHeaders,
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(401)
    expect(data.error).toBe('not_authorized')
  })

  it('rejects null JSON bodies on POST handlers', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan-upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: 'null',
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_json_body')
  })

  it('allows scoped check-plan-upload for the app org', async () => {
    const { data: app, error } = await getSupabaseClient()
      .from('apps')
      .select('owner_org')
      .eq('app_id', APPNAME)
      .single()
    expect(error).toBeNull()
    expect(app?.owner_org).toBeTruthy()

    const response = await fetch(getEndpointUrl('/private/cli/check-plan-upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: app!.owner_org, app_id: APPNAME }),
    })

    const data = await response.json() as { valid?: boolean }
    expect(response.status).toBe(200)
    expect(typeof data.valid).toBe('boolean')
  })
})

describe('private/cli remaining RPC wrappers', () => {
  it('lists orgs for the apikey user', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/orgs'), {
      method: 'GET',
      headers: scopedHeaders,
    })
    const data = await response.json() as { orgs?: Array<{ gid?: string }> }
    expect(response.status).toBe(200)
    expect(Array.isArray(data.orgs)).toBe(true)
    expect(data.orgs?.some(org => org.gid === ORG_ID)).toBe(true)
  })

  it('rejects check-plan when app_id is an empty string', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: ORG_ID, app_id: '' }),
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_app_id')
  })

  it('rejects check-plan-upload when app_id is an empty string', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan-upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: ORG_ID, app_id: '' }),
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_app_id')
  })

  it('rejects check-plan for an org the apikey cannot read', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-plan'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: OTHER_ORG_ID }),
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(401)
    expect(data.error).toBe('not_authorized')
  })

  it('rejects check-2fa-org for an org the apikey cannot access', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/check-2fa-org'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ org_id: OTHER_ORG_ID }),
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(401)
    expect(data.error).toBe('not_authorized')
  })

  it('rejects check-2fa-app for a billing-only key with no app or channel binding', async () => {
    const apiKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `cli-upload-http-billing-${id}`,
      orgId: ORG_ID,
      roleName: 'org_billing_admin',
    })
    extraApiKeys.push({ id: apiKey.id, rbac_id: apiKey.rbac_id })

    const response = await fetch(getEndpointUrl('/private/cli/check-2fa-app'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        capgkey: apiKey.key!,
      },
      body: JSON.stringify({ app_id: APPNAME }),
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(401)
    expect(data.error).toBe('not_authorized')
  })

  it('allows check-2fa-app for a channel-scoped key bound to that app', async () => {
    const apiKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `cli-upload-http-channel-${id}`,
      orgId: ORG_ID,
      roleName: 'org_billing_admin',
    })
    extraApiKeys.push({ id: apiKey.id, rbac_id: apiKey.rbac_id })

    const [app] = await executeSQL(
      'SELECT id FROM public.apps WHERE app_id = $1 LIMIT 1',
      [APPNAME],
    )
    const [channel] = await executeSQL(
      `SELECT rbac_id FROM public.channels
       WHERE app_id = $1 AND name = 'production'
       LIMIT 1`,
      [APPNAME],
    )
    expect(app?.id).toBeTruthy()
    expect(channel?.rbac_id).toBeTruthy()

    await executeSQL(
      `INSERT INTO public.role_bindings (
         principal_type, principal_id, role_id, scope_type, org_id, app_id, channel_id,
         granted_by, reason, is_direct
       )
       SELECT
         public.rbac_principal_apikey(), $1::uuid, r.id, public.rbac_scope_channel(),
         $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'CLI 2FA channel-scope preflight test', true
       FROM public.roles r
       WHERE r.name = public.rbac_role_channel_reader()
         AND r.scope_type = public.rbac_scope_channel()`,
      [apiKey.rbac_id, ORG_ID, app.id, channel.rbac_id, USER_ID],
    )

    const allowed = await fetch(getEndpointUrl('/private/cli/check-2fa-app'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        capgkey: apiKey.key!,
      },
      body: JSON.stringify({ app_id: APPNAME }),
    })
    const allowedData = await allowed.json() as { reject?: boolean, error?: string }
    expect(allowed.status).toBe(200)
    expect(typeof allowedData.reject).toBe('boolean')

    const denied = await fetch(getEndpointUrl('/private/cli/check-2fa-app'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        capgkey: apiKey.key!,
      },
      body: JSON.stringify({ app_id: `com.cli.upload.http.other.${id}` }),
    })
    const deniedData = await denied.json() as { error?: string }
    expect(denied.status).toBe(401)
    expect(deniedData.error).toBe('not_authorized')
  })

  it('rejects channel-current-bundle without app_id or channel', async () => {
    const response = await fetch(getEndpointUrl('/private/cli/channel-current-bundle'), {
      method: 'GET',
      headers: scopedHeaders,
    })
    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('missing_fields')
  })
})

describe('private/finish_tus_upload validation', () => {
  it('rejects null JSON body without throwing', async () => {
    const response = await fetch(getEndpointUrl('/private/finish_tus_upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: 'null',
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_json_body')
  })

  it('sets r2_path for a prepared r2-direct version', async () => {
    const versionName = `9.9.8-finish-tus-${id.slice(0, 8)}`
    const { data: app, error: appError } = await getSupabaseClient()
      .from('apps')
      .select('owner_org')
      .eq('app_id', APPNAME)
      .single()
    expect(appError).toBeNull()
    expect(app?.owner_org).toBeTruthy()

    const prepareResponse = await fetch(getEndpointUrl('/bundle/prepare'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        app_id: APPNAME,
        name: versionName,
        storage_provider: 'r2-direct',
      }),
    })
    expect(prepareResponse.status).toBe(200)

    const finishResponse = await fetch(getEndpointUrl('/private/finish_tus_upload'), {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        app_id: APPNAME,
        name: versionName,
        owner_org: app!.owner_org,
      }),
    })

    const finishData = await finishResponse.json() as { status?: string, r2_path?: string }
    expect(finishResponse.status).toBe(200)
    expect(finishData.status).toBe('ok')
    expect(finishData.r2_path).toBe(`orgs/${app!.owner_org}/apps/${APPNAME}/${versionName}.zip`)
  })
})
