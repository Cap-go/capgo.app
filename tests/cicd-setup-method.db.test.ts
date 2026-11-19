import type { Database, Json } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from './sql-data-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient<Database>(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, options)
const owner = createClient<Database>(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const reader = createClient<Database>(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const outsider = createClient<Database>(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const anonymous = createClient<Database>(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const orgId = randomUUID()
const users: string[] = []
const apps: string[] = []
const at = '2026-11-01T10:00:00.000Z'

beforeAll(async () => {
  for (const client of [owner, reader, outsider]) {
    const email = `cicd-method-${randomUUID()}@example.com`
    const password = 'cicd-method-test-password'
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    expect(created.error).toBeNull()
    if (!created.data.user)
      throw new Error('Test user creation returned no user')
    users.push(created.data.user.id)
    expect((await admin.from('users').upsert({ id: created.data.user.id, email })).error).toBeNull()
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull()
  }
  expect((await admin.from('orgs').insert({ id: orgId, created_by: users[0], name: 'CI/CD method test', management_email: 'cicd-method@example.com' })).error).toBeNull()
})

afterAll(async () => {
  if (apps.length)
    await admin.from('apps').delete().in('app_id', apps)
  await admin.from('orgs').delete().eq('id', orgId)
  for (const id of users) {
    await admin.from('users').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id)
  }
})

async function fixture(onboarding: Json = {}) {
  const appId = `com.test.cicd.method.${randomUUID()}`
  apps.push(appId)
  expect((await admin.from('apps').insert({ app_id: appId, owner_org: orgId, name: 'CI/CD method', icon_url: '', need_onboarding: false })).error).toBeNull()
  // App insertion assigns a checklist; replace only this test's app ledger.
  expect((await admin.from('apps').update({ onboarding }).eq('app_id', appId)).error).toBeNull()
  return appId
}

async function stored(appId: string) {
  const { data, error } = await admin.from('apps').select('onboarding, need_onboarding').eq('app_id', appId).single()
  expect(error).toBeNull()
  if (!data)
    throw new Error('Test app was not found')
  return data
}

async function ownKey() {
  const rbacId = randomUUID()
  expect((await admin.from('apikeys').insert({ user_id: users[0], key: `cicd-method-${randomUUID()}`, name: 'CI/CD method test key', rbac_id: rbacId })).error).toBeNull()
  return rbacId
}

async function selectMethod(appId: string, product: 'ota' | 'builder', setupMethod: 'ai' | 'manual') {
  const result = await owner.rpc('record_app_cicd_setup', {
    p_app_id: appId,
    p_event: 'method_selected',
    p_selection: { product, setup_method: setupMethod },
  })
  expect(result.error).toBeNull()
  return result.data
}

async function detect(appId: string, product: 'ota' | 'builder') {
  const result = await admin.rpc('record_app_cicd_deploy', { p_app_id: appId, p_product: product, p_apikey_rbac_id: randomUUID(), p_ci_provider: 'GitHub Actions' })
  expect(result.error).toBeNull()
  return result.data
}

describe('CI/CD setup method tracking', () => {
  it.concurrent('records a method without completing setup, exposes only allowlisted answers and preserves the ledger', async () => {
    const original = {
      getting_started_dismissed_at: at,
      setup: { outcome: 'completed', source: 'cli' },
      features: { ota: { succeeded_at: at } },
      cicd: { dismissed_at: at, key_created_at: at, keys: [randomUUID()] },
    }
    const appId = await fixture(original)
    const selected = await owner.rpc('record_app_cicd_setup', {
      p_app_id: appId,
      p_event: 'method_selected',
      p_selection: { product: 'ota', setup_method: 'manual', provider: 'github', strategy: 'main', prompt: 'discarded', api_key: 'discarded', other: 'discarded' },
    })
    expect(selected.error).toBeNull()
    expect(selected.data).toEqual({
      ...original,
      cicd: { ...original.cicd, selection: { product: 'ota', setup_method: 'manual', provider: 'github', strategy: 'main' }, setup_methods: { ota: { method: 'manual', selected_at: expect.any(String) } } },
    })
    expect(await stored(appId)).toEqual({ onboarding: selected.data, need_onboarding: false })
    const again = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'method_selected', p_selection: { product: 'ota', setup_method: 'manual', provider: 'github', strategy: 'main' } })
    expect(again.error).toBeNull()
    expect(again.data).toEqual(selected.data)
  })

  it.concurrent('records successful AI prompt copies independently for each product and preserves first timestamps', async () => {
    const appId = await fixture({ cicd: { setup_methods: { ota: { method: 'ai', selected_at: at } } } })
    const copied = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'ai_prompt_copied', p_selection: { product: 'ota', setup_method: 'ai' } })
    expect(copied.error).toBeNull()
    expect(copied.data).toEqual({ cicd: { selection: { product: 'ota', setup_method: 'ai' }, setup_methods: { ota: { method: 'ai', selected_at: at, ai_prompt_copied_at: expect.any(String) } } } })
    const again = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'ai_prompt_copied', p_selection: { product: 'ota', setup_method: 'ai' } })
    expect(again.error).toBeNull()
    expect(again.data).toEqual(copied.data)
    expect(await selectMethod(appId, 'builder', 'manual')).toEqual({ cicd: { selection: { product: 'builder', setup_method: 'manual' }, setup_methods: { ota: { method: 'ai', selected_at: at, ai_prompt_copied_at: expect.any(String) }, builder: { method: 'manual', selected_at: expect.any(String) } } } })
  })

  it.concurrent('updates a changed method while preserving copy evidence and existing detection attribution', async () => {
    const original = { cicd: { ota_detected_at: at, ota_setup_method: 'ai', marked_done_at: at, dismissed_at: at, setup_methods: { ota: { method: 'ai', selected_at: at, ai_prompt_copied_at: at }, builder: { method: 'manual', selected_at: at } } } }
    const appId = await fixture(original)
    expect(await selectMethod(appId, 'ota', 'manual')).toEqual({ cicd: { ...original.cicd, selection: { product: 'ota', setup_method: 'manual' }, setup_methods: { ...original.cicd.setup_methods, ota: { method: 'manual', selected_at: expect.not.stringContaining(at), ai_prompt_copied_at: at } } } })
    expect(await detect(appId, 'ota')).toBe(false)
    expect((await stored(appId)).onboarding).toEqual(expect.objectContaining({ cicd: expect.objectContaining({ ota_setup_method: 'ai', ota_detected_at: at }) }))
  })

  it.concurrent('snapshots the chosen product method at its first detection independently of the latest selection', async () => {
    const appId = await fixture()
    await selectMethod(appId, 'ota', 'ai')
    await selectMethod(appId, 'builder', 'manual')
    expect(await detect(appId, 'ota')).toBe(true)
    expect(await detect(appId, 'builder')).toBe(true)
    const first = (await stored(appId)).onboarding
    expect(first).toEqual({ cicd: {
      selection: { product: 'builder', setup_method: 'manual' },
      setup_methods: { ota: { method: 'ai', selected_at: expect.any(String) }, builder: { method: 'manual', selected_at: expect.any(String) } },
      ota_detected_at: expect.any(String), ota_setup_method: 'ai', ota_detected_via: 'ci', ota_ci_provider: 'GitHub Actions',
      builder_detected_at: expect.any(String), builder_setup_method: 'manual', builder_detected_via: 'ci', builder_ci_provider: 'GitHub Actions',
      detected_via: 'ci', ci_provider: 'GitHub Actions',
    } })
    expect(await detect(appId, 'ota')).toBe(false)
    expect(await detect(appId, 'builder')).toBe(false)
    expect((await stored(appId)).onboarding).toEqual(first)
  })

  it.concurrent('leaves method attribution unknown when no choice existed at detection and after later choices', async () => {
    const appId = await fixture()
    expect(await detect(appId, 'ota')).toBe(true)
    await selectMethod(appId, 'ota', 'ai')
    expect(await detect(appId, 'ota')).toBe(false)
    // The OTA choice cannot attribute a Builder deployment.
    expect(await detect(appId, 'builder')).toBe(true)
    expect((await stored(appId)).onboarding).toEqual({ cicd: {
      selection: { product: 'ota', setup_method: 'ai' }, setup_methods: { ota: { method: 'ai', selected_at: expect.any(String) } },
      ota_detected_at: expect.any(String), ota_detected_via: 'ci', ota_ci_provider: 'GitHub Actions',
      builder_detected_at: expect.any(String), builder_detected_via: 'ci', builder_ci_provider: 'GitHub Actions',
      detected_via: 'ci', ci_provider: 'GitHub Actions',
    } })
  })

  it.concurrent('does not relabel historical detections that predate method tracking', async () => {
    const appId = await fixture({ cicd: { ota_detected_at: at, builder_detected_at: at, detected_via: 'key' } })
    await selectMethod(appId, 'ota', 'manual')
    await selectMethod(appId, 'builder', 'ai')
    expect(await detect(appId, 'ota')).toBe(false)
    expect(await detect(appId, 'builder')).toBe(false)
    expect((await stored(appId)).onboarding).toEqual({ cicd: { ota_detected_at: at, builder_detected_at: at, detected_via: 'key', selection: { product: 'builder', setup_method: 'ai' }, setup_methods: { ota: { method: 'manual', selected_at: expect.any(String) }, builder: { method: 'ai', selected_at: expect.any(String) } } } })
  })

  it.concurrent('preserves key registration compatibility without treating legacy key creation as a method choice', async () => {
    const appId = await fixture()
    const rbacId = await ownKey()
    const result = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'key_created', p_apikey_rbac_id: rbacId, p_selection: { product: 'ota', provider: 'github', strategy: 'main' } })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ cicd: { keys: [rbacId], key_created_at: expect.any(String), selection: { product: 'ota', provider: 'github', strategy: 'main' } } })
    const detected = await admin.rpc('record_app_cicd_deploy', { p_app_id: appId, p_product: 'ota', p_apikey_rbac_id: rbacId, p_ci_provider: '' })
    expect(detected.error).toBeNull()
    expect(detected.data).toBe(true)
    expect((await stored(appId)).onboarding).toEqual({ cicd: { keys: [rbacId], key_created_at: expect.any(String), selection: { product: 'ota', provider: 'github', strategy: 'main' }, ota_detected_at: expect.any(String), ota_detected_via: 'key', detected_via: 'key' } })
  })

  it.concurrent('retains a known method when legacy clients register a key and accepts an explicit valid selection method', async () => {
    const appId = await fixture()
    const rbacId = await ownKey()
    await selectMethod(appId, 'ota', 'ai')
    await selectMethod(appId, 'builder', 'manual')
    const result = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'key_created', p_apikey_rbac_id: rbacId, p_selection: { product: 'ota', provider: 'github' } })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ cicd: { keys: [rbacId], key_created_at: expect.any(String), selection: { product: 'ota', provider: 'github', setup_method: 'ai' }, setup_methods: { ota: { method: 'ai', selected_at: expect.any(String) }, builder: { method: 'manual', selected_at: expect.any(String) } } } })
    const explicit = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'key_created', p_apikey_rbac_id: rbacId, p_selection: { product: 'ota', setup_method: 'manual' } })
    expect(explicit.error).toBeNull()
    expect(explicit.data).toEqual(expect.objectContaining({ cicd: expect.objectContaining({ selection: { product: 'ota', setup_method: 'manual' }, keys: [rbacId], setup_methods: { ota: { method: 'ai', selected_at: expect.any(String) }, builder: { method: 'manual', selected_at: expect.any(String) } } }) }))
  })

  it.concurrent('allows an app reader without organization access to choose and copy a method', async () => {
    const appId = await fixture()
    const app = await admin.from('apps').select('id').eq('app_id', appId).single()
    const role = await admin.from('roles').select('id').eq('name', 'app_reader').eq('scope_type', 'app').single()
    expect(app.error).toBeNull()
    expect(role.error).toBeNull()
    if (!app.data || !role.data)
      throw new Error('App reader fixture was not found')
    expect((await admin.from('role_bindings').insert({ principal_type: 'user', principal_id: users[1], role_id: role.data.id, scope_type: 'app', org_id: orgId, app_id: app.data.id, granted_by: users[0], reason: 'CI/CD method reader test', is_direct: true })).error).toBeNull()
    for (const event of ['method_selected', 'ai_prompt_copied']) {
      const result = await reader.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: event, p_selection: { product: 'builder', setup_method: 'ai' } })
      expect(result.error).toBeNull()
      expect(result.data).toEqual({ cicd: { selection: { product: 'builder', setup_method: 'ai' }, setup_methods: { builder: { method: 'ai', selected_at: expect.any(String), ...(event === 'ai_prompt_copied' ? { ai_prompt_copied_at: expect.any(String) } : {}) } } } })
    }
  })

  it.concurrent.each(['method_selected', 'ai_prompt_copied'])('rejects anonymous and unrelated callers for %s and keeps detection backend-only', async (event) => {
    const original = { cicd: { dismissed_at: at } }
    const appId = await fixture(original)
    for (const client of [anonymous, outsider]) {
      expect((await client.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: event, p_selection: { product: 'ota', setup_method: 'ai' } })).error?.message).toMatch(/NO_PERMISSION|permission denied/i)
      expect((await client.rpc('record_app_cicd_deploy', { p_app_id: appId, p_product: 'ota', p_apikey_rbac_id: randomUUID(), p_ci_provider: 'GitHub Actions' })).error?.code).toBe('42501')
    }
    expect((await owner.rpc('record_app_cicd_deploy', { p_app_id: appId, p_product: 'ota', p_apikey_rbac_id: randomUUID(), p_ci_provider: 'GitHub Actions' })).error?.code).toBe('42501')
    expect((await stored(appId)).onboarding).toEqual(original)
  })

  it.concurrent.each([
    { event: 'method_selected', selection: null },
    { event: 'method_selected', selection: [] },
    { event: 'method_selected', selection: { setup_method: 'ai' } },
    { event: 'method_selected', selection: { product: 'ota' } },
    { event: 'method_selected', selection: { product: 'unknown', setup_method: 'ai' } },
    { event: 'method_selected', selection: { product: 'builder', setup_method: 'unknown' } },
    { event: 'ai_prompt_copied', selection: { product: 'ota', setup_method: 'manual' } },
    { event: 'ai_prompt_copied', selection: { product: 'builder' } },
  ])('rejects invalid method selection $event / $selection without changing state', async ({ event, selection }) => {
    const original = { cicd: { dismissed_at: at } }
    const appId = await fixture(original)
    const result = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: event, p_selection: selection })
    expect(result.error?.message).toContain('INVALID_SELECTION')
    expect((await stored(appId)).onboarding).toEqual(original)
  })
})
