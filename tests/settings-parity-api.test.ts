import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, USER_PASSWORD_HASH } from './test-utils.ts'

// Settings that the web console exposes and the public API, CLI and MCP servers must also expose.
const suiteId = randomUUID()
const ownerId = randomUUID()
const ownerEmail = `settings-parity-owner-${suiteId}@example.com`
const memberId = randomUUID()
const memberEmail = `settings-parity-member-${suiteId}@example.com`
const orgId = randomUUID()
const customerId = `cus_settings_parity_${suiteId}`
const appId = `com.settings.parity.${suiteId.replaceAll('-', '')}`
let apikeyId = 0
let headers: Record<string, string>

async function createUser(id: string, email: string) {
  await executeSQL(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
     VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
    [id, email, USER_PASSWORD_HASH],
  )
  await executeSQL(
    `INSERT INTO public.users (id, email, first_name, last_name)
     VALUES ($1, $2, 'Before', 'Parity')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [id, email],
  )
}

async function bindOrgRole(userId: string, roleName: string) {
  await executeSQL(
    `INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct)
     SELECT 'user', $1::uuid, roles.id, 'org', $2::uuid, $3::uuid, 'settings parity test', true
     FROM public.roles roles WHERE roles.name = $4 AND roles.scope_type = 'org'
     ON CONFLICT DO NOTHING`,
    [userId, orgId, ownerId, roleName],
  )
}

async function api(path: string, method: string, body?: unknown) {
  const response = await fetchTestRequest(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data: any = text
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {}
  return { status: response.status, data }
}

beforeAll(async () => {
  await createUser(ownerId, ownerEmail)
  await createUser(memberId, memberEmail)
  const trialAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
  await executeSQL(
    `INSERT INTO public.stripe_info (customer_id, status, product_id, subscription_id, trial_at, is_good_plan)
     VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', $2, $3::timestamptz, true)`,
    [customerId, `sub_${suiteId}`, trialAt],
  )
  await executeSQL(
    `INSERT INTO public.orgs (id, name, management_email, created_by, customer_id)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5)`,
    [orgId, `Settings parity ${suiteId}`, ownerEmail, ownerId, customerId],
  )
  await bindOrgRole(ownerId, 'org_super_admin')
  await bindOrgRole(memberId, 'org_member')
  await executeSQL(
    `INSERT INTO public.apps (app_id, owner_org, name, icon_url, need_onboarding) VALUES ($1, $2::uuid, 'Settings parity', '', false)`,
    [appId, orgId],
  )
  const key = await createDirectApiKeyWithBindings({
    userId: ownerId,
    key: randomUUID(),
    name: `Settings parity ${suiteId}`,
    orgId,
    roleName: 'org_super_admin',
  })
  if (!key?.key || typeof key.id !== 'number')
    throw new Error('Failed to seed settings parity API key')
  apikeyId = key.id
  headers = { 'Content-Type': 'application/json', 'capgkey': key.key }
})

afterAll(async () => {
  await executeSQL('DELETE FROM public.channels WHERE app_id = $1', [appId])
  await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [appId])
  if (apikeyId)
    await executeSQL('DELETE FROM public.apikeys WHERE id = $1', [apikeyId])
  await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
  await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  for (const id of [ownerId, memberId]) {
    await executeSQL('DELETE FROM public.users WHERE id = $1', [id])
    await executeSQL('DELETE FROM auth.users WHERE id = $1', [id])
  }
})

describe('app settings parity', () => {
  it('updates preview, build timeout and default upload channel', async () => {
    const created = await api('/channel', 'POST', { app_id: appId, channel: 'beta' })
    expect(created.status, JSON.stringify(created.data)).toBe(200)

    const updated = await api(`/app/${appId}`, 'PUT', { allow_preview: true, build_timeout_seconds: 900, default_upload_channel: 'beta' })
    expect(updated.status, JSON.stringify(updated.data)).toBe(200)
    expect(updated.data).toMatchObject({ allow_preview: true, build_timeout_seconds: 900, default_upload_channel: 'beta' })
  })

  it('rejects build timeouts outside 300..21600 seconds', async () => {
    const response = await api(`/app/${appId}`, 'PUT', { build_timeout_seconds: 60 })
    expect(response.status).toBe(400)
    expect(response.data.error).toBe('invalid_build_timeout_seconds')
  })

  it('rejects a default upload channel that does not exist', async () => {
    const response = await api(`/app/${appId}`, 'PUT', { default_upload_channel: 'missing-channel' })
    expect(response.status).toBe(400)
    expect(response.data.error).toBe('channel_not_found')
  })
})

describe('channel pause parity', () => {
  it('pauses and resumes a channel, keeping the first pause timestamp', async () => {
    const paused = await api('/channel', 'POST', { app_id: appId, channel: 'beta', paused: true })
    expect(paused.status, JSON.stringify(paused.data)).toBe(200)
    const [first] = await executeSQL<{ paused_at: string | null }>('SELECT paused_at FROM public.channels WHERE app_id = $1 AND name = $2', [appId, 'beta'])
    expect(first?.paused_at).not.toBeNull()

    expect((await api('/channel', 'POST', { app_id: appId, channel: 'beta', paused: true })).status).toBe(200)
    const [second] = await executeSQL<{ paused_at: string | null }>('SELECT paused_at FROM public.channels WHERE app_id = $1 AND name = $2', [appId, 'beta'])
    expect(new Date(second!.paused_at!).getTime()).toBe(new Date(first!.paused_at!).getTime())

    expect((await api('/channel', 'POST', { app_id: appId, channel: 'beta', paused: false })).status).toBe(200)
    const [resumed] = await executeSQL<{ paused_at: string | null }>('SELECT paused_at FROM public.channels WHERE app_id = $1 AND name = $2', [appId, 'beta'])
    expect(resumed?.paused_at).toBeNull()
  })
})

describe('organization settings parity', () => {
  it('merges org email preferences instead of replacing them', async () => {
    expect((await api('/organization', 'PUT', { orgId, email_preferences: { weekly_stats: false } })).status).toBe(200)
    const second = await api('/organization', 'PUT', { orgId, email_preferences: { monthly_stats: false } })
    expect(second.status, JSON.stringify(second.data)).toBe(200)
    const [org] = await executeSQL<{ email_preferences: Record<string, boolean> }>('SELECT email_preferences FROM public.orgs WHERE id = $1::uuid', [orgId])
    expect(org?.email_preferences).toMatchObject({ weekly_stats: false, monthly_stats: false })
  })

  it('rejects unknown org email preference keys', async () => {
    const response = await api('/organization', 'PUT', { orgId, email_preferences: { not_a_preference: false } })
    expect(response.status).toBe(400)
  })

  it('changes an existing member role', async () => {
    const response = await api('/organization/members', 'PUT', { orgId, email: memberEmail, role: 'org_admin' })
    expect(response.status, JSON.stringify(response.data)).toBe(200)
    const [binding] = await executeSQL<{ name: string }>(
      `SELECT roles.name FROM public.role_bindings rb JOIN public.roles roles ON roles.id = rb.role_id
       WHERE rb.principal_type = 'user' AND rb.principal_id = $1::uuid AND rb.org_id = $2::uuid AND rb.scope_type = 'org'`,
      [memberId, orgId],
    )
    expect(binding?.name).toBe('org_admin')
  })

  it('refuses to change the caller own role', async () => {
    const response = await api('/organization/members', 'PUT', { orgId, email: ownerEmail, role: 'org_member' })
    expect(response.status).toBe(400)
    expect(response.data.error).toBe('cannot_change_own_role')
  })

  it('rejects unknown roles', async () => {
    const response = await api('/organization/members', 'PUT', { orgId, email: memberEmail, role: 'root' })
    expect(response.status).toBe(400)
  })
})

describe('account settings parity', () => {
  it('reads the caller profile', async () => {
    const response = await api('/user', 'GET')
    expect(response.status, JSON.stringify(response.data)).toBe(200)
    expect(response.data).toMatchObject({ id: ownerId, email: ownerEmail, first_name: 'Before' })
  })

  it('updates profile fields and merges personal email preferences', async () => {
    expect((await api('/user', 'PUT', { email_preferences: { weekly_stats: false } })).status).toBe(200)
    const response = await api('/user', 'PUT', { first_name: 'After', format_locale: 'fr-FR', email_preferences: { cli_realtime_feed: false } })
    expect(response.status, JSON.stringify(response.data)).toBe(200)
    expect(response.data).toMatchObject({ first_name: 'After', format_locale: 'fr-FR' })
    expect(response.data.email_preferences).toMatchObject({ weekly_stats: false, cli_realtime_feed: false })
  })

  it('never lets the API change the account email', async () => {
    const response = await api('/user', 'PUT', { email: `hijack-${suiteId}@example.com` })
    expect(response.status).toBe(400)
    const [user] = await executeSQL<{ email: string }>('SELECT email FROM public.users WHERE id = $1', [ownerId])
    expect(user?.email).toBe(ownerEmail)
  })

  it('rejects unknown personal email preference keys', async () => {
    const response = await api('/user', 'PUT', { email_preferences: { not_a_preference: true } })
    expect(response.status).toBe(400)
  })
})
