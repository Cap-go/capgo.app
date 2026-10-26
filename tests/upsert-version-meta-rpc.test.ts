import type { Database } from '~/types/database.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, ORG_ID } from './test-utils.ts'

const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY

if (!SUPABASE_URL)
  throw new Error('SUPABASE_URL is required for version_meta RPC tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for version_meta RPC tests')

const APP_ID = `com.versionmeta.rpc.${randomUUID()}`
const APP_VERSION_NAME = `1.0.0-${randomUUID()}`
let versionId: number

const serviceRoleSupabase = getSupabaseClient()
const anonSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
})

async function createAppVersionTarget(options?: {
  appId?: string
  versionName?: string
}) {
  const appId = options?.appId ?? `com.versionmeta.rpc.${randomUUID()}`
  const versionName = options?.versionName ?? `1.0.0-${randomUUID()}`

  const { error: appError } = await serviceRoleSupabase.from('apps').insert({
    app_id: appId,
    owner_org: ORG_ID,
    name: 'RPC Security Test App',
    icon_url: 'https://example.com/icon.png',
  })
  if (appError)
    throw appError

  const { data: versionRow, error: versionError } = await serviceRoleSupabase
    .from('app_versions')
    .insert({
      app_id: appId,
      owner_org: ORG_ID,
      name: versionName,
    })
    .select('id')
    .single()
  if (versionError)
    throw versionError
  if (!versionRow)
    throw new Error('Failed to create app version for test')

  return {
    appId,
    versionId: versionRow.id,
  }
}

beforeAll(async () => {
  ({ versionId } = await createAppVersionTarget({
    appId: APP_ID,
    versionName: APP_VERSION_NAME,
  }))
})

afterAll(async () => {
  await serviceRoleSupabase.from('version_meta').delete().eq('app_id', APP_ID)
  await serviceRoleSupabase.from('app_versions').delete().eq('app_id', APP_ID)
  await serviceRoleSupabase.from('apps').delete().eq('app_id', APP_ID)
})

describe('upsert_version_meta RPC authorization', () => {
  it('must reject unauthenticated (anon) execution', async () => {
    const { data, error } = await anonSupabase.rpc('upsert_version_meta', {
      p_app_id: APP_ID,
      p_version_id: versionId,
      p_size: 123456,
    })

    expect(data).toBeNull()
    expect(error).toBeTruthy()
    expect(error?.code === '42501' || /permission denied/i.test(error?.message || '')).toBe(true)
  })

  it('returns false for unknown app ids', async () => {
    const { data, error } = await serviceRoleSupabase.rpc('upsert_version_meta', {
      p_app_id: `com.versionmeta.missing.${randomUUID()}`,
      p_version_id: versionId,
      p_size: 123456,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('returns false for unknown version ids', async () => {
    const { data, error } = await serviceRoleSupabase.rpc('upsert_version_meta', {
      p_app_id: APP_ID,
      p_version_id: 999999999,
      p_size: 123456,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('upserts only once per app/version/size sign', async () => {
    const { appId, versionId: isolatedVersionId } = await createAppVersionTarget()

    try {
      const { data, error } = await serviceRoleSupabase.rpc('upsert_version_meta', {
        p_app_id: appId,
        p_version_id: isolatedVersionId,
        p_size: 123456,
      })

      expect(error).toBeNull()
      expect(data).toBe(true)

      const { data: rows, error: readError } = await serviceRoleSupabase
        .from('version_meta')
        .select('app_id,version_id,size')
        .eq('app_id', appId)
        .eq('version_id', isolatedVersionId)
        .limit(2)

      expect(readError).toBeNull()
      expect(rows).toHaveLength(1)
      expect(rows?.[0]).toMatchObject({
        app_id: appId,
        version_id: isolatedVersionId,
        size: 123456,
      })

      const { data: duplicateData, error: duplicateError } = await serviceRoleSupabase.rpc('upsert_version_meta', {
        p_app_id: appId,
        p_version_id: isolatedVersionId,
        p_size: 123456,
      })

      expect(duplicateError).toBeNull()
      expect(duplicateData).toBe(false)
    }
    finally {
      await serviceRoleSupabase.from('version_meta').delete().eq('app_id', appId)
      await serviceRoleSupabase.from('app_versions').delete().eq('app_id', appId)
      await serviceRoleSupabase.from('apps').delete().eq('app_id', appId)
    }
  })
})
