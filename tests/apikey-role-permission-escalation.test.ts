import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  USER_PASSWORD,
  USER_PASSWORD_HASH,
} from './test-utils.ts'

const TEST_ID = randomUUID()
const ORG_ID = randomUUID()
const APP_UUID = randomUUID()
const PUBLIC_APP_ID = `com.apikey.escalation.${TEST_ID}`
const APIKEY_MANAGER_USER_ID = randomUUID()
const DEPLOY_MANAGER_USER_ID = randomUUID()
const ORG_BOOTSTRAP_USER_ID = randomUUID()
const APIKEY_MANAGER_EMAIL = `apikey-manager-only-${TEST_ID}@capgo.app`
const DEPLOY_MANAGER_EMAIL = `apikey-deploy-manager-${TEST_ID}@capgo.app`
const CHANNEL_NAME = `escalation-channel-${TEST_ID.slice(0, 8)}`

let apikeyManagerHeaders: Record<string, string>
let deployManagerHeaders: Record<string, string>
let channelLegacyId: number

async function createApiKeyWithBindings(
  headers: Record<string, string>,
  name: string,
  bindings: Array<Record<string, unknown>>,
) {
  return fetch(`${BASE_URL}/apikey`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ name, bindings }),
  })
}

beforeAll(async () => {
  const supabase = getSupabaseClient()
  const bootstrapEmail = `apikey-escalation-bootstrap-${TEST_ID}@capgo.app`

  await executeSQL(`
    INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
    VALUES
      ($1::uuid, $4, $7, NOW(), NOW(), NOW(), '{}'::jsonb),
      ($2::uuid, $5, $7, NOW(), NOW(), NOW(), '{}'::jsonb),
      ($3::uuid, $6, $7, NOW(), NOW(), NOW(), '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [
    APIKEY_MANAGER_USER_ID,
    DEPLOY_MANAGER_USER_ID,
    ORG_BOOTSTRAP_USER_ID,
    APIKEY_MANAGER_EMAIL,
    DEPLOY_MANAGER_EMAIL,
    bootstrapEmail,
    USER_PASSWORD_HASH,
  ])

  await executeSQL(`
    INSERT INTO public.users (id, email, first_name, last_name, created_at, updated_at)
    VALUES
      ($1::uuid, $4, 'Apikey', 'Manager', NOW(), NOW()),
      ($2::uuid, $5, 'Deploy', 'Manager', NOW(), NOW()),
      ($3::uuid, $6, 'Org', 'Bootstrap', NOW(), NOW())
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email
  `, [
    APIKEY_MANAGER_USER_ID,
    DEPLOY_MANAGER_USER_ID,
    ORG_BOOTSTRAP_USER_ID,
    APIKEY_MANAGER_EMAIL,
    DEPLOY_MANAGER_EMAIL,
    `apikey-escalation-bootstrap-${TEST_ID}@capgo.app`,
  ])

  await executeSQL(`
    INSERT INTO public.orgs (id, created_by, name, management_email, created_at, updated_at)
    VALUES ($1::uuid, $2::uuid, $3, $4, NOW(), NOW())
  `, [ORG_ID, ORG_BOOTSTRAP_USER_ID, `API Key Escalation Org ${TEST_ID}`, APIKEY_MANAGER_EMAIL])

  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct
    )
    SELECT public.rbac_principal_user(), principal.user_id::uuid, roles.id, public.rbac_scope_org(), $1::uuid, principal.user_id::uuid, 'apikey escalation test binding', true
    FROM (
      VALUES
        ($2::uuid, public.rbac_role_apikey_manager()),
        ($3::uuid, public.rbac_role_apikey_manager())
    ) AS principal(user_id, role_name)
    JOIN public.roles roles
      ON roles.name = principal.role_name
      AND roles.scope_type = public.rbac_scope_org()
  `, [ORG_ID, APIKEY_MANAGER_USER_ID, DEPLOY_MANAGER_USER_ID])

  await supabase.from('apps').insert({
    id: APP_UUID,
    app_id: PUBLIC_APP_ID,
    owner_org: ORG_ID,
    icon_url: 'apikey-escalation-test-icon',
    name: `Escalation App ${TEST_ID}`,
    user_id: APIKEY_MANAGER_USER_ID,
  })

  const versionName = `escalation-version-${TEST_ID.slice(0, 8)}`
  const { data: version, error: versionError } = await supabase
    .from('app_versions')
    .insert({
      app_id: PUBLIC_APP_ID,
      name: versionName,
      owner_org: ORG_ID,
      user_id: APIKEY_MANAGER_USER_ID,
      checksum: `checksum-${TEST_ID}`,
      storage_provider: 'r2',
      r2_path: `orgs/${ORG_ID}/apps/${PUBLIC_APP_ID}/${versionName}.zip`,
      deleted: false,
    })
    .select('id')
    .single()
  if (versionError)
    throw versionError

  const { data: channel, error: channelError } = await supabase
    .from('channels')
    .insert({
      app_id: PUBLIC_APP_ID,
      name: CHANNEL_NAME,
      version: version.id,
      owner_org: ORG_ID,
      created_by: APIKEY_MANAGER_USER_ID,
      public: false,
      allow_emulator: false,
    })
    .select('id, rbac_id')
    .single()
  if (channelError)
    throw channelError

  channelLegacyId = channel.id

  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct
    )
    SELECT public.rbac_principal_user(), $2::uuid, roles.id, public.rbac_scope_app(), $1::uuid, $3::uuid, $2::uuid, 'apikey escalation deploy manager binding', true
    FROM public.roles roles
    WHERE roles.name = public.rbac_role_app_developer()
      AND roles.scope_type = public.rbac_scope_app()
  `, [ORG_ID, DEPLOY_MANAGER_USER_ID, APP_UUID])

  apikeyManagerHeaders = await getAuthHeadersForCredentials(APIKEY_MANAGER_EMAIL, USER_PASSWORD)
  deployManagerHeaders = await getAuthHeadersForCredentials(DEPLOY_MANAGER_EMAIL, USER_PASSWORD)
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  await supabase.from('channels').delete().eq('app_id', PUBLIC_APP_ID)
  await supabase.from('app_versions').delete().eq('app_id', PUBLIC_APP_ID)
  await supabase.from('apps').delete().eq('app_id', PUBLIC_APP_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)
  await supabase.from('users').delete().in('id', [APIKEY_MANAGER_USER_ID, DEPLOY_MANAGER_USER_ID, ORG_BOOTSTRAP_USER_ID])
  await executeSQL(
    `DELETE FROM auth.users WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
    [APIKEY_MANAGER_USER_ID, DEPLOY_MANAGER_USER_ID, ORG_BOOTSTRAP_USER_ID],
  )
})

describe('apikey role binding permission escalation guard', () => {
  const deployAppRoles = ['app_uploader', 'app_developer'] as const
  const deployChannelRoles = ['channel_uploader', 'channel_developer'] as const

  for (const roleName of deployAppRoles) {
    it.concurrent(`apikey_manager cannot mint ${roleName} API keys`, async () => {
      const response = await createApiKeyWithBindings(apikeyManagerHeaders, `blocked-${roleName}-${TEST_ID}`, [{
        role_name: roleName,
        scope_type: 'app',
        org_id: ORG_ID,
        app_id: APP_UUID,
      }])

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: 'binding_failed',
        message: 'Cannot assign a role whose permissions exceed your own',
      })
    })
  }

  for (const roleName of deployChannelRoles) {
    it.concurrent(`apikey_manager cannot mint ${roleName} API keys`, async () => {
      const response = await createApiKeyWithBindings(apikeyManagerHeaders, `blocked-${roleName}-${TEST_ID}`, [{
        role_name: roleName,
        scope_type: 'channel',
        org_id: ORG_ID,
        app_id: APP_UUID,
        channel_id: channelLegacyId,
      }])

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: 'binding_failed',
        message: 'Cannot assign a role whose permissions exceed your own',
      })
    })
  }

  it.concurrent('deploy-capable caller can still mint app_developer API keys', async () => {
    const response = await createApiKeyWithBindings(deployManagerHeaders, `allowed-app-developer-${TEST_ID}`, [{
      role_name: 'app_developer',
      scope_type: 'app',
      org_id: ORG_ID,
      app_id: APP_UUID,
    }])

    expect(response.status).toBe(200)
    const body = await response.json() as { id: number }
    expect(body.id).toBeGreaterThan(0)

    await fetch(`${BASE_URL}/apikey/${body.id}`, {
      method: 'DELETE',
      headers: deployManagerHeaders,
    })
  })

  it.concurrent('apikey_manager is still blocked from minting app_admin by the deny-list', async () => {
    const response = await createApiKeyWithBindings(apikeyManagerHeaders, `blocked-app-admin-${TEST_ID}`, [{
      role_name: 'app_admin',
      scope_type: 'app',
      org_id: ORG_ID,
      app_id: APP_UUID,
    }])

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden_binding',
    })
  })

  it.concurrent('apikey_manager can still mint org_member API keys', async () => {
    const response = await createApiKeyWithBindings(apikeyManagerHeaders, `allowed-org-member-${TEST_ID}`, [{
      role_name: 'org_member',
      scope_type: 'org',
      org_id: ORG_ID,
    }])

    expect(response.status).toBe(200)
    const body = await response.json() as { id: number }
    expect(body.id).toBeGreaterThan(0)

    await fetch(`${BASE_URL}/apikey/${body.id}`, {
      method: 'DELETE',
      headers: apikeyManagerHeaders,
    })
  })
})
