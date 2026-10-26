import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasSupportedOtaTodoList, parseAppOnboarding } from '../src/services/appOnboarding'
import { shouldShowGettingStartedNav, shouldSkipOnboardingResume } from '../src/utils/appOnboardingProgress'
import { hasDualOnboardingChecklists } from '../src/utils/dualOnboardingChecklists'
import { app } from '../supabase/functions/_backend/public/app/index.ts'
import { POSTGRES_URL } from './test-utils.ts'

const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, options)
const owner = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const outsider = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const anonymous = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, options)
const orgId = randomUUID()
const users: string[] = []
const apps: string[] = []
const at = '2026-10-19T10:00:00.000Z'
const otaSteps = { login_cli_mcp: { status: 'done', at, source: 'cli' }, add_channel: { status: 'skipped', at } }

beforeAll(async () => {
  for (const client of [owner, outsider]) {
    const email = `builder-activation-${randomUUID()}@example.com`
    const password = 'builder-activation-test-password'
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    expect(created.error).toBeNull()
    users.push(created.data.user!.id)
    expect((await admin.from('users').upsert({ id: created.data.user!.id, email })).error).toBeNull()
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull()
  }
  expect((await admin.from('orgs').insert({ id: orgId, created_by: users[0], name: 'Builder activation test', management_email: 'builder-activation@example.com' })).error).toBeNull()
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

async function fixture(onboarding: object, needOnboarding = false) {
  const appId = `com.test.builder.activation.${randomUUID()}`
  apps.push(appId)
  expect((await admin.from('apps').insert({ app_id: appId, owner_org: orgId, name: 'Builder activation', icon_url: '', need_onboarding: needOnboarding })).error).toBeNull()
  // Insertion assigns the current experiment format. Explicitly seed older apps afterwards.
  expect((await admin.from('apps').update({ onboarding }).eq('app_id', appId)).error).toBeNull()
  return appId
}

async function requestActivation(appId: string, client = owner, method = 'POST', path = 'builder') {
  const { data: { session } } = await client.auth.getSession()
  // Exercise the registered backend route with real JWT verification, RBAC and
  // PostgreSQL transactions; no edge-worker deployment is needed for this test.
  return app.request(`http://local/${encodeURIComponent(appId)}/onboarding/${path}`, {
    method,
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
  }, { SUPABASE_URL: env.SUPABASE_URL!, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY!, SUPABASE_DB_URL: POSTGRES_URL })
}

async function activate(appId: string) {
  const response = await requestActivation(appId)
  expect(response.status).toBe(200)
  const { onboarding: data } = await response.json() as any
  expect(data.setup).toMatchObject({ todo_list_version: 4, builder_todo_list_version: '1', selected_path: 'builder', outcome: 'in_progress' })
  expect(data).not.toHaveProperty('getting_started_dismissed_at')
  expect(data.setup).not.toHaveProperty('completed_at')
  expect(shouldShowGettingStartedNav(data)).toBe(true)
  expect(shouldSkipOnboardingResume(data)).toBe(false)
  return data
}

describe('explicit Builder checklist activation', () => {
  it.concurrent.each([1, 2])('converts v%s into Builder-only v4 and preserves the feature ledger', async (version) => {
    const features = { ota: { succeeded_at: at, stage: 'store_live' } }
    const appId = await fixture({ features, getting_started_dismissed_at: at, setup: { todo_list_version: version, outcome: 'completed', completed_at: at, source: 'cli', steps: otaSteps } })
    const data = await activate(appId)
    expect(data.setup.paths).toEqual(['builder'])
    expect(data.setup.ota_todo_list_version).toBeUndefined()
    expect(data.features).toEqual(features)
    expect(data.setup.steps.login_cli_mcp).toEqual(otaSteps.login_cli_mcp)
    expect(Object.keys(data.setup.steps.builder.ios)).toHaveLength(6)
    expect(Object.keys(data.setup.steps.builder.android)).toHaveLength(4)
  })

  it.concurrent.each([true, false])('upgrades root or nested v3 without losing OTA records (nested=%s)', async (nested) => {
    const setup = { todo_list_version: 3, source: 'mcp', outcome: 'skipped', completed_at: at, steps: otaSteps }
    const appId = await fixture({ ...(nested ? { setup } : setup), custom: 'keep', getting_started_dismissed_at: at }, true)
    const data = await activate(appId)
    expect(data.setup.paths).toEqual(['ota', 'builder'])
    expect(data.setup.ota_todo_list_version).toBe('1')
    expect(data.setup.steps.ota).toMatchObject(otaSteps)
    expect(Object.keys(data.setup.steps.ota)).toHaveLength(7)
    expect(data.custom).toBe('keep')
    expect((await admin.from('apps').select('need_onboarding').eq('app_id', appId).single()).data!.need_onboarding).toBe(true)
  })

  it.concurrent.each([1, '1', null, undefined].flatMap(subversion => [undefined, [], ['builder'], ['ota']].map(paths => ({ subversion, paths }))))('persists readable v4 OTA progress for accepted metadata %j', async ({ subversion, paths }) => {
    const appId = await fixture({ setup: { todo_list_version: 4, ota_todo_list_version: subversion, paths, steps: { ota: otaSteps } } })
    const data = await activate(appId)
    const persisted = (await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding
    expect(persisted).toEqual(data)
    expect(data.setup.ota_todo_list_version).toBe('1')
    expect(data.setup.steps.ota).toEqual(otaSteps)
    const parsed = parseAppOnboarding(persisted)
    expect(hasSupportedOtaTodoList(parsed)).toBe(true)
    expect(hasDualOnboardingChecklists(data)).toBe(true)
    expect(parsed.steps.login_cli_mcp?.status).toBe('done')
    expect(parsed.steps.add_channel?.status).toBe('skipped')
    expect(await activate(appId)).toEqual(data)
  })

  it.concurrent.each(['ota', 'builder', 'both'])('extends or reuses v4 %s without resetting progress and is idempotent', async (path) => {
    const builderSteps = { ios: { prepare_certificate: { status: 'warning', annotation: 'keep', at } }, android: { prepare_keystore: { status: 'done', at } } }
    const appId = await fixture({ setup: { todo_list_version: 4, ...(path !== 'builder' ? { ota_todo_list_version: '1' } : {}), ...(path !== 'ota' ? { builder_todo_list_version: '1' } : {}), paths: path === 'both' ? ['ota', 'builder'] : [path], selected_path: 'ota', selected_builder_platform: 'android', steps: { ...(path !== 'builder' ? { ota: otaSteps } : {}), ...(path !== 'ota' ? { builder: builderSteps } : {}) } } })
    const data = await activate(appId)
    expect(data.setup.paths).toEqual(path === 'builder' ? ['builder'] : ['ota', 'builder'])
    if (path !== 'builder')
      expect(data.setup.steps.ota).toEqual(otaSteps)
    if (path !== 'ota')
      expect(data.setup.steps.builder).toMatchObject(builderSteps)
    expect(data.setup.selected_builder_platform).toBe('android')
    const beforeRepeat = await admin.from('apps').select('updated_at').eq('app_id', appId).single()
    expect(await activate(appId)).toEqual(data)
    const afterRepeat = await admin.from('apps').select('need_onboarding, updated_at').eq('app_id', appId).single()
    expect(afterRepeat.data).toEqual({ need_onboarding: false, updated_at: beforeRepeat.data!.updated_at })
  })

  it.concurrent('initializes an app with no checklist', async () => {
    const appId = await fixture({ features: { cli_install: { succeeded_at: at } } })
    expect((await activate(appId)).setup.paths).toEqual(['builder'])
  })

  it.concurrent('reports activation access without changing onboarding', async () => {
    const original = { setup: { todo_list_version: 3, steps: otaSteps } }
    const appId = await fixture(original)
    const response = await requestActivation(appId, owner, 'GET')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ canEnable: true })
    expect((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding).toEqual(original)
  })

  it.concurrent('serializes simultaneous activation without losing the existing OTA history', async () => {
    const appId = await fixture({ setup: { todo_list_version: 3, steps: otaSteps } })
    const [first, second] = await Promise.all([activate(appId), activate(appId)])
    expect(first).toEqual(second)
    expect(first.setup.steps.ota).toMatchObject(otaSteps)
    expect((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding).toEqual(first)
  })

  it.concurrent.each([{ todo_list_version: 5 }, { todo_list_version: 4, builder_todo_list_version: '2' }, { todo_list_version: 4, ota_todo_list_version: '2', paths: ['ota'] }, { todo_list_version: [4] }, { todo_list_version: 4, builder_todo_list_version: ['1'] }, { todo_list_version: 4, ota_todo_list_version: ['1'], paths: ['ota'] }])('rejects unsupported versions without changing the app: %j', async (setup) => {
    const original = { setup }
    const appId = await fixture(original)
    expect((await requestActivation(appId)).status).toBe(409)
    expect((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding).toEqual(original)
  })

  it.concurrent('rejects anonymous callers, unrelated users, app readers and app developers', async () => {
    const original = { setup: { todo_list_version: 3, steps: otaSteps } }
    const appId = await fixture(original)
    expect((await requestActivation(appId, anonymous)).status).toBe(401)
    expect((await requestActivation(appId, outsider)).status).toBe(403)
    const { data: app } = await admin.from('apps').select('id').eq('app_id', appId).single()
    for (const roleName of ['app_reader', 'app_developer']) {
      const { data: role } = await admin.from('roles').select('id').eq('name', roleName).eq('scope_type', 'app').single()
      expect((await admin.from('role_bindings').delete().eq('principal_id', users[1]).eq('app_id', app!.id)).error).toBeNull()
      expect((await admin.from('role_bindings').insert({ principal_type: 'user', principal_id: users[1], role_id: role!.id, scope_type: 'app', org_id: orgId, app_id: app!.id, granted_by: users[0], reason: 'Builder activation limited role test', is_direct: true })).error).toBeNull()
      const access = await requestActivation(appId, outsider, 'GET')
      expect(access.status).toBe(200)
      expect(await access.json()).toEqual({ canEnable: false })
      expect((await requestActivation(appId, outsider)).status).toBe(403)
    }
    expect((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding).toEqual(original)
  })
})

describe('explicit OTA checklist activation', () => {
  it.concurrent('persists OTA alongside Builder and accepts subsequent OTA progress without resetting either list', async () => {
    const builder = { ios: { start_setup: { status: 'done', at } }, android: { prepare_keystore: { status: 'warning', annotation: 'keep' } } }
    const original = { custom: 'keep', setup: { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_path: 'builder', steps: { builder } } }
    const appId = await fixture(original)
    const response = await requestActivation(appId, owner, 'POST', 'ota')
    expect(response.status).toBe(200)
    const { onboarding } = await response.json() as any
    expect(onboarding.setup).toMatchObject({ paths: ['builder', 'ota'], selected_path: 'ota', ota_todo_list_version: '1', steps: { builder } })
    expect(onboarding.custom).toBe('keep')
    expect(hasDualOnboardingChecklists(onboarding)).toBe(true)
    const before = await admin.from('apps').select('onboarding, updated_at').eq('app_id', appId).single()
    expect(before.data!.onboarding).toEqual(onboarding)
    expect((await requestActivation(appId, owner, 'POST', 'ota')).status).toBe(200)
    expect((await admin.from('apps').select('onboarding, updated_at').eq('app_id', appId).single()).data).toEqual(before.data)

    const { data: { session } } = await owner.auth.getSession()
    const progress = await app.request(`http://local/${appId}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${session!.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarding: { source: 'cli', steps: { add_code: { status: 'done' } } } }),
    }, { SUPABASE_URL: env.SUPABASE_URL!, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY!, SUPABASE_DB_URL: POSTGRES_URL })
    expect(progress.status).toBe(200)
    const after = (await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding as any
    expect(after.setup.steps.ota.add_code.status).toBe('done')
    expect(after.setup.steps.builder).toEqual(builder)
  })

  it.concurrent('rejects anonymous and unrelated callers without changing the app', async () => {
    const original = { setup: { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], steps: { builder: {} } } }
    const appId = await fixture(original)
    expect((await requestActivation(appId, anonymous, 'POST', 'ota')).status).toBe(401)
    expect((await requestActivation(appId, outsider, 'POST', 'ota')).status).toBe(403)
    expect((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data!.onboarding).toEqual(original)
  })
})
