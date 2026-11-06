import type { Database } from '~/types/database.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCiCdSetupDone, parseCiCdSetupState } from '../src/utils/cicdSetupState.ts'
import {
  APIKEY_TEST_ALL,
  BASE_URL,
  executeSQL,
  headers,
  resetAndSeedAppData,
  resetAppData,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_EMAIL,
  USER_EMAIL_NONMEMBER,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const id = randomUUID().slice(0, 8)
const APP_UPSERT = `com.cicd.upsert.${id}`
const APP_KEY = `com.cicd.key.${id}`
const APP_RPC = `com.cicd.rpc.${id}`

function authClient() {
  return createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function signedIn(email = USER_EMAIL, password = USER_PASSWORD) {
  const client = authClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error)
    throw error
  return client
}

async function cicd(appId: string) {
  const [row] = await executeSQL<{ onboarding: unknown }>('SELECT onboarding FROM public.apps WHERE app_id = $1', [appId])
  return parseCiCdSetupState(row?.onboarding)
}

async function upsertBundle(appId: string, name: string, extraHeaders: Record<string, string> = {}, storageProvider?: string) {
  // Both local test runtimes set CAPGO_PREVENT_BACKGROUND_FUNCTIONS=true, so
  // this response also completes the detection task for this exact request.
  const response = await fetch(`${BASE_URL}/bundle/upsert`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ app_id: appId, name, ...(storageProvider ? { storage_provider: storageProvider } : {}) }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

beforeAll(async () => {
  await Promise.all([APP_UPSERT, APP_KEY, APP_RPC].map(appId => resetAndSeedAppData(appId)))
})

afterAll(async () => {
  await Promise.all([APP_UPSERT, APP_KEY, APP_RPC].map(appId => resetAppData(appId)))
})

describe('CI/CD setup tracking', () => {
  it('marks live updates done when the CLI uploads a bundle from CI', async () => {
    await upsertBundle(APP_UPSERT, '1.0.1-local')
    expect(isCiCdSetupDone((await executeSQL('SELECT onboarding FROM public.apps WHERE app_id = $1', [APP_UPSERT]))[0]?.onboarding)).toBe(false)

    // The initial row exists before transfer starts. An abandoned upload must not complete setup.
    await upsertBundle(APP_UPSERT, '1.0.2-ci', { 'x-cli-ci': 'GitHub Actions' }, 'r2-direct')
    expect((await cicd(APP_UPSERT)).otaDetectedAt).toBeNull()

    // The CLI finalizes storage_provider after the zip and manifest are persisted.
    await upsertBundle(APP_UPSERT, '1.0.2-ci', { 'x-cli-ci': 'GitHub Actions' }, 'r2')
    expect((await cicd(APP_UPSERT)).otaDetectedAt).toBeTruthy()
    const state = await cicd(APP_UPSERT)
    expect(state).toEqual(expect.objectContaining({ detectedVia: 'ci', ciProvider: 'GitHub Actions', builderDetectedAt: null }))

    // Only the first CI upload is recorded.
    await upsertBundle(APP_UPSERT, '1.0.3-ci', { 'x-cli-ci': 'GitLab CI' }, 'r2')
    expect(await cicd(APP_UPSERT)).toEqual(state)

    const [key] = await executeSQL<{ rbac_id: string }>('SELECT rbac_id::text AS rbac_id FROM public.apikeys WHERE key = $1', [APIKEY_TEST_ALL])
    const client = await signedIn()
    const { error } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_UPSERT, p_event: 'key_created', p_apikey_rbac_id: key!.rbac_id })
    expect(error).toBeNull()
    await executeSQL('SELECT public.record_app_cicd_deploy($1, $2, $3, $4)', [APP_UPSERT, 'builder', key!.rbac_id, null])
    expect(await cicd(APP_UPSERT)).toEqual(expect.objectContaining({
      detectedVia: 'ci', ciProvider: 'GitHub Actions', otaDetectedAt: state.otaDetectedAt, builderDetectedAt: expect.any(String),
      otaDetectedVia: 'ci', otaCiProvider: 'GitHub Actions', builderDetectedVia: 'key', builderCiProvider: null,
    }))
  })

  it('marks live updates done when a caller-owned registered key uploads, even without CI detection', async () => {
    const [key] = await executeSQL<{ rbac_id: string }>('SELECT rbac_id::text AS rbac_id FROM public.apikeys WHERE key = $1', [APIKEY_TEST_ALL])
    const client = await signedIn()
    const { data, error } = await client.rpc('record_app_cicd_setup', {
      p_app_id: APP_KEY,
      p_event: 'key_created',
      p_apikey_rbac_id: key!.rbac_id,
      p_selection: { product: 'ota', strategy: 'pull_request', provider: 'gitlab', role: 'ignored', extra: 'x' },
    })
    expect(error).toBeNull()
    const stored = (data as { cicd?: Record<string, unknown> }).cicd
    expect(stored?.keys).toEqual([key!.rbac_id])
    expect(stored?.selection).toEqual({ product: 'ota', strategy: 'pull_request', provider: 'gitlab' })
    expect(stored?.key_created_at).toBeTruthy()

    await upsertBundle(APP_KEY, '1.0.1-guide-key', {}, 'r2')
    expect((await cicd(APP_KEY)).otaDetectedAt).toBeTruthy()
    expect(await cicd(APP_KEY)).toEqual(expect.objectContaining({ detectedVia: 'key', ciProvider: null }))

    await executeSQL('SELECT public.record_app_cicd_deploy($1, $2, $3, $4)', [APP_KEY, 'builder', null, 'GitHub Actions'])
    expect(await cicd(APP_KEY)).toEqual(expect.objectContaining({ detectedVia: 'key', ciProvider: null, builderDetectedAt: expect.any(String), otaDetectedVia: 'key', builderDetectedVia: 'ci', builderCiProvider: 'GitHub Actions' }))
  })

  it('only lets app readers record their own keys and the done state', async () => {
    const { error: anonError } = await authClient().rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'marked_done' })
    expect(anonError).toBeTruthy()

    const outsider = await signedIn(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
    const { error: outsiderError } = await outsider.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'marked_done' })
    expect(outsiderError?.message).toContain('NO_PERMISSION')

    const client = await signedIn()
    const { error: foreignKeyError } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'key_created', p_apikey_rbac_id: randomUUID() })
    expect(foreignKeyError?.message).toContain('NO_PERMISSION')
    const { error: eventError } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'detected' })
    expect(eventError?.message).toContain('INVALID_EVENT')

    // Detection is backend-only: users cannot claim a CI upload.
    const { error: deployError } = await client.rpc('record_app_cicd_deploy', { p_app_id: APP_RPC, p_product: 'ota', p_apikey_rbac_id: randomUUID(), p_ci_provider: 'GitHub Actions' })
    expect(deployError).toBeTruthy()
    expect((await cicd(APP_RPC)).otaDetectedAt).toBeNull()

    const { data, error } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'marked_done' })
    expect(error).toBeNull()
    const markedDoneAt = parseCiCdSetupState(data).markedDoneAt
    expect(markedDoneAt).toBeTruthy()
    expect(isCiCdSetupDone(data)).toBe(true)
    const { data: again } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'marked_done' })
    expect(parseCiCdSetupState(again).markedDoneAt).toBe(markedDoneAt)
  })

  it('keeps the other onboarding fields and caps tracked keys', async () => {
    await executeSQL(`UPDATE public.apps SET onboarding = jsonb_build_object('getting_started_dismissed_at', '2026-10-01T00:00:00.000Z') WHERE app_id = $1`, [APP_RPC])
    const keys = Array.from({ length: 12 }, () => randomUUID())
    const [user] = await executeSQL<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE email = $1', [USER_EMAIL])
    for (const [index, rbacId] of keys.entries())
      await executeSQL(`INSERT INTO public.apikeys (user_id, key, name, rbac_id) VALUES ($1, $2, $3, $4)`, [user!.id, `cicd-${id}-${index}-${randomUUID()}`, `cicd tracking ${index}`, rbacId])
    try {
      const client = await signedIn()
      for (const rbacId of keys) {
        const { error } = await client.rpc('record_app_cicd_setup', { p_app_id: APP_RPC, p_event: 'key_created', p_apikey_rbac_id: rbacId })
        expect(error).toBeNull()
      }
      const [row] = await executeSQL<{ onboarding: { getting_started_dismissed_at?: string, cicd: { keys: string[] } } }>('SELECT onboarding FROM public.apps WHERE app_id = $1', [APP_RPC])
      expect(row!.onboarding.getting_started_dismissed_at).toBe('2026-10-01T00:00:00.000Z')
      expect(row!.onboarding.cicd.keys).toEqual(keys.slice(-10))
    }
    finally {
      await executeSQL('DELETE FROM public.apikeys WHERE rbac_id = ANY($1::uuid[])', [keys])
    }
  })
})
