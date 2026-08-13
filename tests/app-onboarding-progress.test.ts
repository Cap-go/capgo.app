import type { Database } from '~/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAppOnboardingLedger } from '../src/utils/appOnboardingProgress.ts'
import {
  executeSQL,
  getSupabaseClient,
  ORG_ID,
  ORG_ID_STATS,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_EMAIL,
  USER_ID,
  USER_PASSWORD,
} from './test-utils.ts'

const APP_RPC = `ob.rpc.${randomUUID().slice(0, 8)}`
const APP_INSERT = `ob.ins.${randomUUID().slice(0, 8)}`
const APP_TESTFLIGHT = `ob.tf.${randomUUID().slice(0, 8)}`
const APP_STORE = `ob.st.${randomUUID().slice(0, 8)}`
const APP_ORG_BF = `ob.org.${randomUUID().slice(0, 8)}`
const DEVICE_TF = randomUUID().toLowerCase()
const DEVICE_STORE = randomUUID().toLowerCase()
const DEVICE_ORG_BF = randomUUID().toLowerCase()

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

async function createApp(appId: string) {
  const { error } = await serviceRoleSupabase.from('apps').insert({
    app_id: appId,
    owner_org: ORG_ID,
    name: 'Onboarding progress test app',
    icon_url: 'https://example.com/icon.png',
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
  await insertDevice(APP_TESTFLIGHT, DEVICE_TF, 'testflight')
  await insertDevice(APP_STORE, DEVICE_STORE, 'app_store')
})

afterAll(async () => {
  await serviceRoleSupabase.from('devices').delete().in('app_id', [APP_TESTFLIGHT, APP_STORE, APP_ORG_BF])
  await serviceRoleSupabase.from('apps').delete().in('app_id', [APP_RPC, APP_INSERT, APP_TESTFLIGHT, APP_STORE, APP_ORG_BF])
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
      `SELECT pg_get_functiondef('public.refresh_app_onboarding_progress(integer, uuid)'::regprocedure) AS def`,
    )
    expect(defs[0]?.def).toContain('INNER JOIN batch ON batch.app_id')
    expect(defs[0]?.def).toContain('p_owner_org')

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

  it('must reject unauthenticated refresh_org_apps_onboarding', async () => {
    const anon = createAuthClient()
    const { error } = await anon.rpc('refresh_org_apps_onboarding', {
      p_org_id: ORG_ID,
    })
    expect(error).toBeTruthy()
  })

  it('denies refresh_org_apps_onboarding for another org', async () => {
    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    const { error } = await authClient.rpc('refresh_org_apps_onboarding', {
      p_org_id: ORG_ID_STATS,
    })
    expect(error).toBeTruthy()
  })

  it('backfills the caller org from existing devices', async () => {
    await createApp(APP_ORG_BF)
    await insertDevice(APP_ORG_BF, DEVICE_ORG_BF, 'testflight')

    const authClient = createAuthClient()
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    if (signInError)
      throw signInError

    let ledger = parseAppOnboardingLedger(null)
    let lastError: unknown = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const { error } = await authClient.rpc('refresh_org_apps_onboarding', {
        p_org_id: ORG_ID,
      })
      lastError = error
      if (error)
        break
      const { data, error: readError } = await serviceRoleSupabase
        .from('apps')
        .select('onboarding')
        .eq('app_id', APP_ORG_BF)
        .single()
      if (readError)
        throw readError
      ledger = parseAppOnboardingLedger(data?.onboarding)
      if (ledger.refreshed_at)
        break
    }
    expect(lastError).toBeNull()
    expect(ledger.refreshed_at).toBeTruthy()
    expect(ledger.features?.ota?.stage).toBe('testflight')
    expect(ledger.features?.cli_install?.succeeded_at).toBeTruthy()
  })
})
