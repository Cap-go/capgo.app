import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
const anonymous = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })

const IOS_STEPS = [
  'start_setup', 'choose_destination', 'connect_app_store',
  'prepare_certificate', 'prepare_profile', 'successful_cloud_build',
]
const ANDROID_STEPS = [
  'start_setup', 'prepare_keystore', 'connect_google_play', 'successful_cloud_build',
]

describe('Builder checklist v4 database initialization', () => {
  it.concurrent('keeps the initializer unavailable to anonymous callers', async () => {
    const { data, error } = await anonymous.rpc('new_builder_onboarding_setup_v1')
    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it.concurrent('defines the exact pending Builder-only setup without selecting a platform', async () => {
    const { data: setup, error } = await admin.rpc('new_builder_onboarding_setup_v1')
    expect(error).toBeNull()
    expect(setup).toMatchObject({
      todo_list_version: 4,
      builder_todo_list_version: '1',
      paths: ['builder'],
      selected_path: 'builder',
      outcome: 'in_progress',
    })
    expect(setup).not.toHaveProperty('ota_todo_list_version')
    expect(setup).not.toHaveProperty('selected_builder_platform')
    expect(Object.keys(setup.steps)).toEqual(['builder'])
    for (const [platform, expectedSteps] of Object.entries({ ios: IOS_STEPS, android: ANDROID_STEPS })) {
      expect(Object.keys(setup.steps.builder[platform]).sort()).toEqual([...expectedSteps].sort())
      expect(Object.values(setup.steps.builder[platform])).toEqual(expectedSteps.map(() => ({ status: 'pending' })))
    }

    const merged = await admin.rpc('merge_app_onboarding_setup', {
      p_existing: { setup, features: { builder: { stage: 'new' } } },
      p_patch: { source: 'cli', steps: { login_cli_mcp: { status: 'done' } } },
    })
    expect(merged.error).toBeNull()
    expect(merged.data.setup.steps).toEqual(setup.steps)
    expect(merged.data.setup.paths).toEqual(['builder'])
    expect(merged.data.setup.outcome).toBe('in_progress')
    expect(merged.data.features).toEqual({ builder: { stage: 'new' } })
  })

  it.concurrent.each([
    ['builder', 'builder_todo_list_v4', 2],
    ['ota', 'ota_todo_list_v3', 4],
  ] as const)('keeps the %s assignment behavior at app insert', async (intent, testName, expectedVersion) => {
    const email = `builder-v4-${randomUUID()}@example.com`
    const orgId = randomUUID()
    const appId = `com.test.builder.v4.${randomUUID()}`
    let userId: string | undefined
    try {
      const created = await admin.auth.admin.createUser({ email, password: 'builder-v4-test-password', email_confirm: true })
      expect(created.error).toBeNull()
      userId = created.data.user!.id
      expect((await admin.from('users').upsert({
        id: userId,
        email,
        onboarding: { intent, abtests: { [testName]: { branch: 'A', assigned_at: new Date().toISOString() } } },
      })).error).toBeNull()
      expect((await admin.from('orgs').insert({ id: orgId, created_by: userId, name: 'Builder checklist test', management_email: email })).error).toBeNull()
      const app = await admin.from('apps').insert({
        app_id: appId,
        owner_org: orgId,
        name: 'Builder checklist test',
        icon_url: '',
        onboarding: { created_by_user_id: userId, setup: { todo_list_version: 2, source: 'manual', outcome: 'in_progress', steps: {} } },
      }).select('onboarding').single()
      expect(app.error).toBeNull()
      const setup = (app.data!.onboarding as any).setup
      expect(setup.todo_list_version).toBe(expectedVersion)
      if (intent === 'builder') {
        expect(setup.steps?.builder).toBeUndefined()
        expect(setup.builder_todo_list_version).toBeUndefined()
      }
      else {
        expect(setup.ota_todo_list_version).toBe('1')
        expect(setup.paths).toEqual(['ota'])
        expect(setup.steps.ota.add_channel).toEqual({ status: 'pending' })
        expect(setup.steps.builder).toBeUndefined()
      }
    }
    finally {
      await admin.from('apps').delete().eq('app_id', appId)
      await admin.from('orgs').delete().eq('id', orgId)
      if (userId) {
        await admin.from('users').delete().eq('id', userId)
        await admin.auth.admin.deleteUser(userId)
      }
    }
  })
})
