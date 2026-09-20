import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, ORG_ID, USER_ID } from './test-utils.ts'

const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY

if (!SUPABASE_URL)
  throw new Error('SUPABASE_URL is required for get_public_builder_metrics tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for get_public_builder_metrics tests')

const admin = getSupabaseClient()
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

const testId = randomUUID()
const appId = `com.public.builder.metrics.${testId}`
const uploadSessionKey = `public-builder-metrics-${testId}`
const buildIds: string[] = []

async function callPublicMetrics() {
  const { data, error } = await anon.rpc('get_public_builder_metrics')
  expect(error).toBeNull()
  return data as Record<string, unknown>
}

beforeAll(async () => {
  const { error: appError } = await admin.from('apps').insert({
    app_id: appId,
    owner_org: ORG_ID,
    name: 'Public builder metrics test app',
    icon_url: 'https://example.com/icon.png',
  })
  if (appError)
    throw appError

  const now = new Date()
  const startedAt = new Date(now.getTime() - 120_000).toISOString()
  const completedAt = new Date(now.getTime() - 60_000).toISOString()
  const rows = [
    {
      app_id: appId,
      owner_org: ORG_ID,
      requested_by: USER_ID,
      platform: 'ios',
      status: 'succeeded',
      upload_session_key: `${uploadSessionKey}-ios-success`,
      upload_path: 'builds/public-metrics/ios',
      upload_url: 'https://example.com/ios',
      upload_expires_at: completedAt,
      created_at: now.toISOString(),
      started_at: startedAt,
      completed_at: completedAt,
      runner_wait_seconds: 10,
    },
    {
      app_id: appId,
      owner_org: ORG_ID,
      requested_by: USER_ID,
      platform: 'android',
      status: 'failed',
      upload_session_key: `${uploadSessionKey}-android-failed`,
      upload_path: 'builds/public-metrics/android',
      upload_url: 'https://example.com/android',
      upload_expires_at: completedAt,
      created_at: now.toISOString(),
      started_at: startedAt,
      completed_at: completedAt,
      runner_wait_seconds: 20,
      last_error: 'script_failure: compile step failed',
    },
    {
      app_id: appId,
      owner_org: ORG_ID,
      requested_by: USER_ID,
      platform: 'ios',
      status: 'pending',
      upload_session_key: `${uploadSessionKey}-ios-pending`,
      upload_path: 'builds/public-metrics/ios-pending',
      upload_url: 'https://example.com/ios-pending',
      upload_expires_at: completedAt,
      created_at: now.toISOString(),
      runner_wait_seconds: 0,
    },
  ]

  const { data, error } = await admin.from('build_requests').insert(rows).select('id')
  if (error)
    throw error
  buildIds.push(...(data ?? []).map(row => row.id))
})

afterAll(async () => {
  if (buildIds.length)
    await admin.from('build_requests').delete().in('id', buildIds)
  await admin.from('apps').delete().eq('app_id', appId)
})

describe('get_public_builder_metrics RPC', () => {
  it('allows anon callers and returns the public contract shape', async () => {
    const payload = await callPublicMetrics()

    expect(payload.period_days).toBe(30)
    expect(typeof payload.success_rate).toBe('number')
    expect(typeof payload.updated_at).toBe('string')
    expect(Array.isArray(payload.daily_platforms)).toBe(true)
    expect(Array.isArray(payload.failures)).toBe(true)
    expect(Array.isArray(payload.platforms)).toBe(true)
    expect(payload).not.toHaveProperty('last_error')
    expect(JSON.stringify(payload)).not.toMatch(/owner_org|app_id|requested_by/)
  })

  it('aggregates terminal ios/android outcomes without exposing raw errors', async () => {
    const payload = await callPublicMetrics()
    const failures = payload.failures as Array<{ reason: string, share: number }>
    const platforms = payload.platforms as Array<{
      key: string
      share: number
      success_rate: number | null
      top_failure: { reason: string, share: number } | null
    }>

    expect(failures.some(row => row.reason === 'script_failure')).toBe(true)
    expect(failures.every(row => typeof row.share === 'number')).toBe(true)

    const ios = platforms.find(row => row.key === 'ios')
    const android = platforms.find(row => row.key === 'android')
    expect(ios?.success_rate).toBe(100)
    expect(android?.success_rate).toBe(0)
    expect(android?.top_failure?.reason).toBe('script_failure')
    expect(android?.top_failure?.share).toBe(100)
  })
})
