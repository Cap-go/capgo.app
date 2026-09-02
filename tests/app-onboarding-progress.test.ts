import type { Database } from '~/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAppOnboardingLedger, shouldShowGettingStartedNav, shouldSkipOnboardingResume } from '../src/utils/appOnboardingProgress.ts'
import {
  executeSQL,
  getSupabaseClient,
  ORG_ID,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_EMAIL,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_ID_NONMEMBER,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const APP_RPC = `ob.rpc.${randomUUID().slice(0, 8)}`
const APP_INSERT = `ob.ins.${randomUUID().slice(0, 8)}`
const APP_TESTFLIGHT = `ob.tf.${randomUUID().slice(0, 8)}`
const APP_STORE = `ob.st.${randomUUID().slice(0, 8)}`
const APP_VERIFY = `ob.vf.${randomUUID().slice(0, 8)}`
const APP_SETUP = `ob.su.${randomUUID().slice(0, 8)}`
const DEVICE_TF = randomUUID().toLowerCase()
const DEVICE_STORE = randomUUID().toLowerCase()

const serviceRoleSupabase = getSupabaseClient()

function createAuthClient() {
  return createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function bindAppReader(appId: string, userId: string) {
  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_user(),
      $1::uuid,
      roles.id,
      public.rbac_scope_app(),
      $2::uuid,
      apps.id,
      $3::uuid,
      'Getting started reader regression',
      true
    FROM public.roles roles
    INNER JOIN public.apps apps ON apps.app_id = $4
    WHERE roles.name = public.rbac_role_app_reader()
      AND roles.scope_type = public.rbac_scope_app()
    ON CONFLICT DO NOTHING
  `, [userId, ORG_ID, USER_ID, appId])
}

async function unbindAppReader(appId: string, userId: string) {
  await executeSQL(`
    DELETE FROM public.role_bindings
    WHERE principal_type = public.rbac_principal_user()
      AND principal_id = $1::uuid
      AND app_id = (SELECT id FROM public.apps WHERE app_id = $2)
  `, [userId, appId])
}

async function createApp(appId: string, needOnboarding = false) {
  const { error } = await serviceRoleSupabase.from('apps').insert({
    app_id: appId,
    owner_org: ORG_ID,
    name: 'Onboarding progress test app',
    icon_url: 'https://example.com/icon.png',
    need_onboarding: needOnboarding,
  })
  if (error)
    throw error
}

async function insertDevice(appId: string, deviceId: string, installSource: string) {
  const { error } = await serviceRoleSupabase.from('devices').insert({
    app_id: appId,
    device_id: deviceId,
    platform: 'ios',
    plugin_version: '7.0.0',
    updated_at: new Date().toISOString(),
    version_name: '1.0.0',
    install_source: installSource,
    is_prod: true,
    is_emulator: false,
  })
  if (error)
    throw error
}

async function refreshUntil(appId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await executeSQL('SELECT public.refresh_app_onboarding_progress(500)')
    const { data, error } = await serviceRoleSupabase
      .from('apps')
      .select('onboarding')
      .eq('app_id', appId)
      .single()
    if (error)
      throw error
    const ledger = parseAppOnboardingLedger(data.onboarding)
    if (ledger.refreshed_at)
      return ledger
  }
  throw new Error(`refresh_app_onboarding_progress never reached ${appId}`)
}

beforeAll(async () => {
  await createApp(APP_RPC)
  await createApp(APP_TESTFLIGHT)
  await createApp(APP_STORE)
  await createApp(APP_VERIFY, true)
  await createApp(APP_SETUP, true)
  await insertDevice(APP_TESTFLIGHT, DEVICE_TF, 'testflight')
  await insertDevice(APP_STORE, DEVICE_STORE, 'app_store')
})

afterAll(async () => {
  await serviceRoleSupabase.from('devices').delete().eq('app_id', APP_TESTFLIGHT)
  await serviceRoleSupabase.from('devices').delete().eq('app_id', APP_STORE)
  await serviceRoleSupabase.from('app_versions').delete().eq('app_id', APP_VERIFY)
  await serviceRoleSupabase.from('apps').delete().in('app_id', [APP_RPC, APP_INSERT, APP_TESTFLIGHT, APP_STORE, APP_VERIFY, APP_SETUP])
})

describe('app onboarding progress RPCs', () => {
  it('must reject unauthenticated mark_onboarding_feature_started', async () => {
    const anon = createAuthClient()
    const { error } = await anon.rpc('mark_onboarding_feature_started', {
      p_app_id: APP_RPC,
      p_feature_key: 'cli_install',
    })
    expect(error).toBeTruthy()
  })

  it('sets started_at and persists it', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { data, error } = await authClient.rpc('mark_onboarding_feature_started', {
      p_app_id: APP_RPC,
      p_feature_key: 'cli_install',
    })
    expect(error).toBeNull()
    const ledger = parseAppOnboardingLedger(data)
    expect(ledger.features?.cli_install?.started_at).toBeTruthy()
    expect(ledger.features?.cli_install?.succeeded_at).toBeFalsy()
    expect(ledger.features?.cli_install?.stage).toBeFalsy()

    const { data: persisted, error: readError } = await serviceRoleSupabase
      .from('apps')
      .select('onboarding')
      .eq('app_id', APP_RPC)
      .single()
    expect(readError).toBeNull()
    const persistedLedger = parseAppOnboardingLedger(persisted?.onboarding)
    expect(persistedLedger.features?.cli_install?.started_at).toBeTruthy()
    expect(persistedLedger.features?.cli_install?.succeeded_at).toBeFalsy()
  })

  it('rejects direct authenticated writes to apps.onboarding', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { error: _updateError } = await authClient
      .from('apps')
      .update({
        onboarding: {
          features: {
            ota: {
              succeeded_at: '2026-01-01T00:00:00.000Z',
              stage: 'store_live',
            },
          },
        },
      })
      .eq('app_id', APP_RPC)

    const { data, error: readError } = await serviceRoleSupabase
      .from('apps')
      .select('onboarding')
      .eq('app_id', APP_RPC)
      .single()
    expect(readError).toBeNull()
    const ledger = parseAppOnboardingLedger(data?.onboarding)
    expect(ledger.features?.ota?.succeeded_at).toBeFalsy()
    expect(ledger.features?.ota?.stage).not.toBe('store_live')
    expect(ledger.features?.cli_install?.started_at).toBeTruthy()
  })

  it('clears forged onboarding on authenticated insert', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { error: insertError } = await authClient.from('apps').insert({
      app_id: APP_INSERT,
      owner_org: ORG_ID,
      user_id: USER_ID,
      name: 'Onboarding insert protection test app',
      icon_url: 'https://example.com/icon.png',
      onboarding: {
        features: {
          ota: {
            succeeded_at: '2026-01-01T00:00:00.000Z',
            stage: 'store_live',
          },
        },
      },
    })
    expect(insertError, JSON.stringify(insertError)).toBeNull()

    const { data, error: readError } = await serviceRoleSupabase
      .from('apps')
      .select('onboarding')
      .eq('app_id', APP_INSERT)
      .single()
    expect(readError).toBeNull()
    expect(data).toBeTruthy()
    const ledger = parseAppOnboardingLedger(data?.onboarding)
    expect(ledger.features?.ota?.succeeded_at).toBeFalsy()
    expect(ledger.features?.ota?.stage).not.toBe('store_live')
  })

  it('keeps TestFlight-only apps off store_live', async () => {
    const defs = await executeSQL<{ def: string }>(
      `SELECT pg_get_functiondef('public.refresh_app_onboarding_progress(integer)'::regprocedure) AS def`,
    )
    expect(defs[0]?.def).toContain('INNER JOIN batch ON batch.app_id')

    const testflight = await refreshUntil(APP_TESTFLIGHT)
    const store = await refreshUntil(APP_STORE)

    expect(testflight.features?.ota?.stage).toBe('testflight')
    expect(testflight.features?.ota?.stage).not.toBe('store_live')
    expect(store.features?.ota?.stage).toBe('store_live')

    const merged = await executeSQL<{ stage: string | null }>(
      `SELECT public.merge_app_onboarding_feature(
         '{"stage":"store_live"}'::jsonb, NULL, NULL, NULL, 'no_device'
       )->>'stage' AS stage`,
    )
    expect(merged[0]?.stage).toBe('store_live')
  })

  it('must reject unauthenticated dismiss_getting_started', async () => {
    const anon = createAuthClient()
    const { error } = await anon.rpc('dismiss_getting_started', {
      p_app_id: APP_RPC,
    })
    expect(error).toBeTruthy()
  })

  it('persists getting started dismiss on the app and survives refresh', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { error: markError } = await authClient.rpc('mark_onboarding_feature_started', {
      p_app_id: APP_RPC,
      p_feature_key: 'cli_install',
    })
    expect(markError).toBeNull()

    const { data, error } = await authClient.rpc('dismiss_getting_started', {
      p_app_id: APP_RPC,
    })
    expect(error).toBeNull()
    const ledger = parseAppOnboardingLedger(data)
    expect(ledger.getting_started_dismissed_at).toBeTruthy()
    expect(shouldShowGettingStartedNav(ledger)).toBe(false)
    expect(ledger.features?.cli_install?.started_at).toBeTruthy()

    const firstDismissedAt = ledger.getting_started_dismissed_at
    const { data: again, error: againError } = await authClient.rpc('dismiss_getting_started', {
      p_app_id: APP_RPC,
    })
    expect(againError).toBeNull()
    expect(parseAppOnboardingLedger(again).getting_started_dismissed_at).toBe(firstDismissedAt)

    const refreshed = await refreshUntil(APP_RPC)
    expect(refreshed.getting_started_dismissed_at).toBe(firstDismissedAt)
    expect(refreshed.features?.cli_install?.started_at).toBeTruthy()
  })

  it('must reject unauthenticated verify_getting_started', async () => {
    const anon = createAuthClient()
    const { error } = await anon.rpc('verify_getting_started', {
      p_app_id: APP_VERIFY,
    })
    expect(error).toBeTruthy()
  })

  it('verifies live bundles onto the getting started ledger and completes pending onboarding', async () => {
    const { error: versionError } = await serviceRoleSupabase.from('app_versions').insert({
      app_id: APP_VERIFY,
      name: '1.0.1',
      owner_org: ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2',
      r2_path: `orgs/${ORG_ID}/apps/${APP_VERIFY}/1.0.1.zip`,
    })
    if (versionError)
      throw versionError

    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { data, error } = await authClient.rpc('verify_getting_started', {
      p_app_id: APP_VERIFY,
    })
    expect(error).toBeNull()
    const ledger = parseAppOnboardingLedger(data)
    expect(ledger.refreshed_at).toBeTruthy()
    expect(ledger.features?.ota?.started_at).toBeTruthy()
    // A stored bundle is first-bundle time, not an install. Skip-resume still
    // needs succeeded_at, dismiss, or CLI/AI setup. Completing need_onboarding
    // is what stops the login splash after Verify.
    expect(ledger.features?.ota?.succeeded_at).toBeFalsy()
    expect(shouldSkipOnboardingResume(data)).toBe(false)

    const { data: app, error: readError } = await serviceRoleSupabase
      .from('apps')
      .select('need_onboarding')
      .eq('app_id', APP_VERIFY)
      .single()
    expect(readError).toBeNull()
    expect(app?.need_onboarding).toBe(false)
  })

  it('completes pending onboarding when CLI/AI setup reports completed', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { data, error } = await authClient.rpc('report_app_onboarding_setup', {
      p_app_id: APP_SETUP,
      p_patch: { outcome: 'completed' },
    })
    expect(error).toBeNull()
    expect(shouldSkipOnboardingResume(data)).toBe(true)

    const { data: app, error: readError } = await serviceRoleSupabase
      .from('apps')
      .select('need_onboarding')
      .eq('app_id', APP_SETUP)
      .single()
    expect(readError).toBeNull()
    expect(app?.need_onboarding).toBe(false)
  })

  it('completes pending onboarding when getting started is hidden', async () => {
    const appId = `ob.hide.${randomUUID().slice(0, 8)}`
    await createApp(appId, true)
    try {
      const authClient = createAuthClient()
      const { error: signInError } = await authClient.auth.signInWithPassword({
        email: USER_EMAIL,
        password: USER_PASSWORD,
      })
      if (signInError)
        throw signInError

      const { error } = await authClient.rpc('dismiss_getting_started', {
        p_app_id: appId,
      })
      expect(error).toBeNull()

      const { data: app, error: readError } = await serviceRoleSupabase
        .from('apps')
        .select('need_onboarding, onboarding')
        .eq('app_id', appId)
        .single()
      expect(readError).toBeNull()
      expect(app?.need_onboarding).toBe(false)
      expect(parseAppOnboardingLedger(app?.onboarding).getting_started_dismissed_at).toBeTruthy()
    }
    finally {
      await serviceRoleSupabase.from('apps').delete().eq('app_id', appId)
    }
  })

  it('lets an app reader hide getting started without completing pending onboarding', async () => {
    const appId = `ob.read.${randomUUID().slice(0, 8)}`
    await createApp(appId, true)
    await bindAppReader(appId, USER_ID_NONMEMBER)
    try {
      const authClient = createAuthClient()
      const { error: signInError } = await authClient.auth.signInWithPassword({
        email: USER_EMAIL_NONMEMBER,
        password: USER_PASSWORD_NONMEMBER,
      })
      if (signInError)
        throw signInError

      const { data, error } = await authClient.rpc('dismiss_getting_started', {
        p_app_id: appId,
      })
      expect(error).toBeNull()
      expect(parseAppOnboardingLedger(data).getting_started_dismissed_at).toBeTruthy()

      const { data: app, error: readError } = await serviceRoleSupabase
        .from('apps')
        .select('need_onboarding')
        .eq('app_id', appId)
        .single()
      expect(readError).toBeNull()
      expect(app?.need_onboarding).toBe(true)
    }
    finally {
      await unbindAppReader(appId, USER_ID_NONMEMBER)
      await serviceRoleSupabase.from('apps').delete().eq('app_id', appId)
    }
  })
})
