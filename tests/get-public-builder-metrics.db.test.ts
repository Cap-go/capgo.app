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

type FailureMetric = { reason: string, share: number }
type PlatformMetric = {
  key: string
  share: number
  success_rate: number | null
  top_failure: { reason: string, share: number } | null
}

async function callPublicMetrics() {
  const { data, error } = await anon.rpc('get_public_builder_metrics')
  expect(error).toBeNull()
  return data as Record<string, unknown>
}

function failureShare(payload: Record<string, unknown>, reason: string) {
  const failures = payload.failures as FailureMetric[]
  return failures.find(row => row.reason === reason)?.share ?? 0
}

function platformMetric(payload: Record<string, unknown>, key: string) {
  const platforms = payload.platforms as PlatformMetric[]
  return platforms.find(row => row.key === key)
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
    const baseline = await callPublicMetrics()
    const baselineScriptShare = failureShare(baseline, 'script_failure')
    const baselineAndroid = platformMetric(baseline, 'android')

    const now = new Date()
    const startedAt = new Date(now.getTime() - 120_000).toISOString()
    const completedAt = new Date(now.getTime() - 60_000).toISOString()
    const terminalRows = [
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
    ]

    const { data: terminalData, error: terminalError } = await admin
      .from('build_requests')
      .insert(terminalRows)
      .select('id')
    if (terminalError)
      throw terminalError
    buildIds.push(...(terminalData ?? []).map(row => row.id))

    const afterTerminal = await callPublicMetrics()
    expect(failureShare(afterTerminal, 'script_failure')).toBeGreaterThan(baselineScriptShare)
    expect(platformMetric(afterTerminal, 'android')?.top_failure?.reason).toBe('script_failure')
    expect(platformMetric(afterTerminal, 'android')?.top_failure?.share).toBeGreaterThanOrEqual(
      baselineAndroid?.top_failure?.share ?? 0,
    )
    ;(afterTerminal.failures as FailureMetric[]).forEach(row => expect(typeof row.share).toBe('number'))

    const beforePending = afterTerminal
    const { data: pendingData, error: pendingError } = await admin
      .from('build_requests')
      .insert({
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
      })
      .select('id')
      .single()
    if (pendingError)
      throw pendingError
    buildIds.push(pendingData.id)

    const afterPending = await callPublicMetrics()
    expect(afterPending.success_rate).toBe(beforePending.success_rate)
    expect(platformMetric(afterPending, 'ios')?.success_rate)
      .toBe(platformMetric(beforePending, 'ios')?.success_rate)
    expect(platformMetric(afterPending, 'android')?.success_rate)
      .toBe(platformMetric(beforePending, 'android')?.success_rate)
    expect(platformMetric(afterPending, 'android')?.top_failure)
      .toEqual(platformMetric(beforePending, 'android')?.top_failure)
  })
})
