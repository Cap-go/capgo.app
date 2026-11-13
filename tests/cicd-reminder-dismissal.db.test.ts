import type { Database, Json } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
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
    const email = `cicd-dismissal-${randomUUID()}@example.com`
    const password = 'cicd-dismissal-test-password'
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    expect(created.error).toBeNull()
    users.push(created.data.user!.id)
    expect((await admin.from('users').upsert({ id: created.data.user!.id, email })).error).toBeNull()
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull()
  }
  expect((await admin.from('orgs').insert({ id: orgId, created_by: users[0], name: 'CI/CD dismissal test', management_email: 'cicd-dismissal@example.com' })).error).toBeNull()
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

async function fixture(onboarding: Json) {
  const appId = `com.test.cicd.dismissal.${randomUUID()}`
  apps.push(appId)
  expect((await admin.from('apps').insert({ app_id: appId, owner_org: orgId, name: 'CI/CD dismissal', icon_url: '', need_onboarding: false })).error).toBeNull()
  // App insertion assigns a checklist; set the exact test ledger afterwards.
  expect((await admin.from('apps').update({ onboarding }).eq('app_id', appId)).error).toBeNull()
  return appId
}

async function stored(appId: string) {
  const { data, error } = await admin.from('apps').select('onboarding, need_onboarding').eq('app_id', appId).single()
  expect(error).toBeNull()
  return data
}

describe('CI/CD reminder dismissal', () => {
  it.concurrent('hides and restores idempotently without completing setup or clearing guide progress', async () => {
    const original = {
      getting_started_dismissed_at: at,
      setup: { outcome: 'completed', source: 'cli' },
      features: { ota: { succeeded_at: at } },
      cicd: { key_created_at: at, keys: [randomUUID()], selection: { product: 'ota', provider: 'github', strategy: 'main' } },
    }
    const appId = await fixture(original)
    const dismissed = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'dismissed' })
    expect(dismissed.error).toBeNull()
    expect(dismissed.data).toEqual({ ...original, cicd: { ...original.cicd, dismissed_at: expect.any(String) } })
    expect(await stored(appId)).toEqual({ onboarding: dismissed.data, need_onboarding: false })
    const again = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'dismissed' })
    expect(again.error).toBeNull()
    expect(again.data).toEqual(dismissed.data)
    for (let i = 0; i < 2; i++) {
      const restored = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'restored' })
      expect(restored.error).toBeNull()
      expect(restored.data).toEqual(original)
      expect(await stored(appId)).toEqual({ onboarding: original, need_onboarding: false })
    }
  })

  it.concurrent('preserves existing setup and both products detection when hiding and restoring', async () => {
    const original = {
      setup: { outcome: 'completed' },
      cicd: {
        marked_done_at: at,
        ota_detected_at: at,
        builder_detected_at: at,
        detected_via: 'ci',
        ci_provider: 'GitHub Actions',
        ota_detected_via: 'ci',
        ota_ci_provider: 'GitHub Actions',
        builder_detected_via: 'key',
        builder_ci_provider: null,
      },
    }
    const appId = await fixture(original)
    const dismissed = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'dismissed' })
    expect(dismissed.error).toBeNull()
    expect(dismissed.data).toEqual({ ...original, cicd: { ...original.cicd, dismissed_at: expect.any(String) } })
    const restored = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'restored' })
    expect(restored.error).toBeNull()
    expect(restored.data).toEqual(original)
    expect((await stored(appId))?.onboarding).toEqual(original)
  })

  it.concurrent('allows app readers to manage the reminder without organization membership', async () => {
    const original = { cicd: { selection: { product: 'builder' } } }
    const appId = await fixture(original)
    const app = await admin.from('apps').select('id').eq('app_id', appId).single()
    const role = await admin.from('roles').select('id').eq('name', 'app_reader').eq('scope_type', 'app').single()
    expect(app.error).toBeNull()
    expect(role.error).toBeNull()
    expect((await admin.from('role_bindings').insert({ principal_type: 'user', principal_id: users[1], role_id: role.data!.id, scope_type: 'app', org_id: orgId, app_id: app.data!.id, granted_by: users[0], reason: 'CI/CD reminder reader test', is_direct: true })).error).toBeNull()
    const dismissed = await reader.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'dismissed' })
    expect(dismissed.error).toBeNull()
    expect(dismissed.data).toEqual({ cicd: { ...original.cicd, dismissed_at: expect.any(String) } })
    const restored = await reader.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'restored' })
    expect(restored.error).toBeNull()
    expect(restored.data).toEqual(original)
  })

  it.concurrent.each(['dismissed', 'restored'])('rejects anonymous and unrelated callers for %s without changing the ledger', async (event) => {
    const original = { cicd: { dismissed_at: at }, features: { builder: { succeeded_at: at } } }
    const appId = await fixture(original)
    expect((await anonymous.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: event })).error?.message).toMatch(/NO_PERMISSION|permission denied/i)
    expect((await outsider.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: event })).error?.message).toContain('NO_PERMISSION')
    expect((await stored(appId))?.onboarding).toEqual(original)
  })

  it.concurrent('still records marked_done explicitly after dismissal and rejects unknown events', async () => {
    const original = { cicd: { dismissed_at: at } }
    const appId = await fixture(original)
    const invalid = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'skip_and_complete' })
    expect(invalid.error?.message).toContain('INVALID_EVENT')
    expect((await stored(appId))?.onboarding).toEqual(original)
    const marked = await owner.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'marked_done' })
    expect(marked.error).toBeNull()
    expect(marked.data).toEqual({ cicd: { dismissed_at: at, marked_done_at: expect.any(String) } })
  })
})
