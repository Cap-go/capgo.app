import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_V3_STEP_IDS, APP_ONBOARDING_V4_OTA_STEP_IDS, parseAppOnboarding } from '../supabase/functions/_backend/utils/appOnboarding.ts'

const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })

describe('persisted app checklist v3', () => {
  it.concurrent.each([
    ['ota', 'A', true, 4], ['ota', 'B', true, 2], ['both', 'A', true, 2], ['builder', 'A', true, 2], ['ota', 'A', false, 2],
  ])('assigns %s/%s with creator-owned org=%s to version %s only at insert', async (intent, branch, ownOrg, expectedVersion) => {
    const email = `onboarding-v3-${randomUUID()}@example.com`
    const created = await admin.auth.admin.createUser({ email, password: 'v3test-password', email_confirm: true })
    expect(created.error).toBeNull()
    const userId = created.data.user!.id
    let otherUserId: string | undefined
    const appIds: string[] = []
    const orgIds: string[] = []
    try {
      expect((await admin.from('users').upsert({ id: userId, email, onboarding: { intent, abtests: { ota_todo_list_v3: { branch, assigned_at: new Date().toISOString() } } } })).error).toBeNull()
      if (!ownOrg) {
        const other = await admin.auth.admin.createUser({ email: `onboarding-v3-other-${randomUUID()}@example.com`, password: 'v3test-password', email_confirm: true })
        expect(other.error).toBeNull()
        otherUserId = other.data.user!.id
        expect((await admin.from('users').upsert({ id: otherUserId, email: other.data.user!.email })).error).toBeNull()
      }
      // Two separate organizations ensure the assignment is not limited to the wizard's first org.
      for (let n = 0; n < 2; n++) {
        const org = await admin.from('orgs').insert({ created_by: otherUserId ?? userId, name: `Checklist v3 ${randomUUID()}`, management_email: email }).select('id').single()
        expect(org.error).toBeNull()
        orgIds.push(org.data!.id)
        const appId = `com.onboarding.v3.${randomUUID()}`
        appIds.push(appId)
        const app = await admin.from('apps').insert({ app_id: appId, owner_org: org.data!.id, name: 'Checklist v3', icon_url: '', onboarding: { created_by_user_id: userId, setup: { todo_list_version: 2, steps: {} } } }).select('onboarding').single()
        expect(app.error).toBeNull()
        expect(parseAppOnboarding(app.data!.onboarding).todo_list_version).toBe(expectedVersion)
        if (expectedVersion === 4) {
          const setup = (app.data!.onboarding as any).setup
          expect(setup.paths).toEqual(['ota'])
          expect(setup.selected_path).toBe('ota')
          expect(Object.keys(setup.steps)).toEqual(['ota'])
          expect(Object.keys(setup.steps.ota).sort()).toEqual([...APP_ONBOARDING_V4_OTA_STEP_IDS].sort())
          expect(Object.values(setup.steps.ota)).toEqual(Array.from({ length: 7 }, () => ({ status: 'pending' })))
        }
      }
      expect((await admin.from('users').update({ onboarding: { intent: 'builder', abtests: {} } }).eq('id', userId)).error).toBeNull()
      expect((await admin.from('apps').update({ name: 'Renamed' }).in('app_id', appIds)).error).toBeNull()
      const apps = await admin.from('apps').select('onboarding').in('app_id', appIds)
      expect(apps.error).toBeNull()
      expect(apps.data!.map(app => parseAppOnboarding(app.onboarding).todo_list_version)).toEqual([expectedVersion, expectedVersion])
    }
    finally {
      await admin.from('apps').delete().in('app_id', appIds)
      await admin.from('orgs').delete().in('id', orgIds)
      await admin.from('users').delete().eq('id', userId)
      await admin.auth.admin.deleteUser(userId)
      if (otherUserId) {
        await admin.from('users').delete().eq('id', otherUserId)
        await admin.auth.admin.deleteUser(otherUserId)
      }
    }
  })

  it.concurrent('SQL merge requires all seven v3 milestones and preserves legacy v2 completion', async () => {
    const current = { setup: { todo_list_version: 3, steps: {} }, features: { ota: { stage: 'local_only' } } }
    const premature = await admin.rpc('merge_app_onboarding_setup', { p_existing: current, p_patch: { outcome: 'completed', steps: { completion: { status: 'done' } } } })
    expect(premature.error).toBeNull()
    expect(parseAppOnboarding(premature.data)).toMatchObject({ todo_list_version: 3, outcome: 'in_progress', steps: {} })
    const completed = await admin.rpc('merge_app_onboarding_setup', { p_existing: current, p_patch: { steps: Object.fromEntries(APP_ONBOARDING_V3_STEP_IDS.map(id => [id, { status: 'done' }])) } })
    expect(completed.error).toBeNull()
    expect(parseAppOnboarding(completed.data).outcome).toBe('completed')
    expect(completed.data.features).toEqual(current.features)
    const control = await admin.rpc('merge_app_onboarding_setup', { p_existing: { setup: { todo_list_version: 2 } }, p_patch: { outcome: 'completed' } })
    expect(control.error).toBeNull()
    expect(parseAppOnboarding(control.data).outcome).toBe('completed')
  })

  it.concurrent('SQL merge keeps all v4 OTA steps and preserves future path data', async () => {
    const current = { setup: { todo_list_version: 4, paths: ['ota'], selected_path: 'ota', steps: { ota: Object.fromEntries(APP_ONBOARDING_V4_OTA_STEP_IDS.map(id => [id, { status: 'pending' }])), builder: { placeholder: { status: 'pending' } } } }, features: { ota: { stage: 'local_only' } } }
    const premature = await admin.rpc('merge_app_onboarding_setup', { p_existing: current, p_patch: { outcome: 'completed', steps: { ota: { add_code: { status: 'done' } } } } })
    expect(premature.error).toBeNull()
    expect(premature.data.setup.outcome).toBe('in_progress')
    expect(premature.data.setup.steps.ota.add_code.status).toBe('done')
    expect(premature.data.setup.steps.ota.add_channel).toEqual({ status: 'pending' })
    expect(premature.data.setup.steps.builder).toEqual(current.setup.steps.builder)
    expect(premature.data.features).toEqual(current.features)
    const completed = await admin.rpc('merge_app_onboarding_setup', { p_existing: current, p_patch: { steps: Object.fromEntries(APP_ONBOARDING_V4_OTA_STEP_IDS.map(id => [id, { status: 'done' }])) } })
    expect(completed.error).toBeNull()
    expect(parseAppOnboarding(completed.data).outcome).toBe('completed')
  })
})
