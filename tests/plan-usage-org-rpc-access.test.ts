import type { Database } from '~/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, POSTGRES_URL } from './test-utils.ts'

const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY ?? ''
const USE_CLOUDFLARE_WORKERS = env.USE_CLOUDFLARE_WORKERS === 'true'

if (!SUPABASE_URL)
  throw new Error('SUPABASE_URL is required for plan usage RPC authorization tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for plan usage RPC authorization tests')

const serviceRoleSupabase = getSupabaseClient()
const pgPool = new Pool({ connectionString: POSTGRES_URL })
const anonSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
})

const OWNER_EMAIL = `plan-access-owner-${randomUUID()}@capgo.test`
const ATTACKER_EMAIL = `plan-access-attacker-${randomUUID()}@capgo.test`
const TEST_PASSWORD = `Capgo!${randomUUID()}`
const CUSTOMER_ID = `cus_plan_access_${randomUUID().replace(/-/g, '')}`

let ownerUserId: string
let attackerUserId: string
let orgId: string
let planName: string
let ownerSupabase: Awaited<ReturnType<typeof createAuthenticatedClient>>
let attackerSupabase: Awaited<ReturnType<typeof createAuthenticatedClient>>

async function createAuthenticatedClient(email: string, password: string) {
  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error)
    throw error

  return client
}

describe.skipIf(USE_CLOUDFLARE_WORKERS)('plan usage org RPC authorization', () => {
  beforeAll(async () => {
    const { data: ownerAuth, error: ownerAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: OWNER_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (ownerAuthError)
      throw ownerAuthError

    const { data: attackerAuth, error: attackerAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: ATTACKER_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (attackerAuthError)
      throw attackerAuthError

    ownerUserId = ownerAuth.user.id
    attackerUserId = attackerAuth.user.id

    const { error: usersError } = await serviceRoleSupabase.from('users').insert([
      {
        id: ownerUserId,
        email: OWNER_EMAIL,
      },
      {
        id: attackerUserId,
        email: ATTACKER_EMAIL,
      },
    ])
    if (usersError)
      throw usersError

    const { data: planRow, error: planError } = await serviceRoleSupabase
      .from('plans')
      .select('name,stripe_id')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    if (planError)
      throw planError
    planName = planRow.name

    const { error: stripeError } = await serviceRoleSupabase.from('stripe_info').insert({
      customer_id: CUSTOMER_ID,
      product_id: planRow.stripe_id,
      status: 'succeeded',
      subscription_anchor_start: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_anchor_end: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    })
    if (stripeError)
      throw stripeError

    const { data: orgRow, error: orgError } = await serviceRoleSupabase
      .from('orgs')
      .insert({
        created_by: ownerUserId,
        name: 'Plan Access Test Org',
        management_email: OWNER_EMAIL,
        customer_id: CUSTOMER_ID,
      })
      .select('id')
      .single()
    if (orgError)
      throw orgError
    orgId = orgRow.id

    const { error: orgUserError } = await serviceRoleSupabase.from('org_users').insert({
      org_id: orgId,
      user_id: ownerUserId,
      rbac_role_name: 'org_super_admin',
    })
    if (orgUserError)
      throw orgUserError

    ownerSupabase = await createAuthenticatedClient(OWNER_EMAIL, TEST_PASSWORD)
    attackerSupabase = await createAuthenticatedClient(ATTACKER_EMAIL, TEST_PASSWORD)

    const { data: cycleData, error: cycleError } = await ownerSupabase.rpc('get_cycle_info_org', {
      orgid: orgId,
    })
    if (cycleError)
      throw cycleError
    if (!cycleData?.[0]?.subscription_anchor_start || !cycleData[0]?.subscription_anchor_end)
      throw new Error('Expected get_cycle_info_org to return a billing cycle for the test org')

    const cycleStart = cycleData[0].subscription_anchor_start.slice(0, 10)
    const cycleEnd = cycleData[0].subscription_anchor_end.slice(0, 10)

    const { error: cacheError } = await serviceRoleSupabase.from('app_metrics_cache').insert({
      org_id: orgId,
      start_date: cycleStart,
      end_date: cycleEnd,
      response: [],
      cached_at: new Date().toISOString(),
    })
    if (cacheError)
      throw cacheError
  })

  afterAll(async () => {
    if (orgId)
      await serviceRoleSupabase.from('app_metrics_cache').delete().eq('org_id', orgId)

    if (orgId) {
      await serviceRoleSupabase.from('org_users').delete().eq('org_id', orgId)
      await serviceRoleSupabase.from('orgs').delete().eq('id', orgId)
    }

    await serviceRoleSupabase.from('stripe_info').delete().eq('customer_id', CUSTOMER_ID)

    if (ownerUserId)
      await serviceRoleSupabase.from('users').delete().eq('id', ownerUserId)
    if (attackerUserId)
      await serviceRoleSupabase.from('users').delete().eq('id', attackerUserId)

    if (ownerUserId)
      await serviceRoleSupabase.auth.admin.deleteUser(ownerUserId)
    if (attackerUserId)
      await serviceRoleSupabase.auth.admin.deleteUser(attackerUserId)

    await pgPool.end()
  })

  it.concurrent('allows authorized org members to read plan usage RPCs', async () => {
    const { data: planNameData, error: planNameError } = await ownerSupabase.rpc('get_current_plan_name_org', {
      orgid: orgId,
    })
    expect(planNameError).toBeNull()
    expect(planNameData).toBe(planName)

    const { data: cycleData, error: cycleError } = await ownerSupabase.rpc('get_cycle_info_org', {
      orgid: orgId,
    })
    expect(cycleError).toBeNull()
    expect(cycleData).toHaveLength(1)
    expect(cycleData?.[0]?.subscription_anchor_start).toBeTruthy()
    expect(cycleData?.[0]?.subscription_anchor_end).toBeTruthy()

    const { data: usageData, error: usageError } = await ownerSupabase.rpc('get_plan_usage_percent_detailed', {
      orgid: orgId,
    })
    expect(usageError).toBeNull()
    expect(usageData).toHaveLength(1)
  })

  it.concurrent('returns no cross-tenant data to unauthorized authenticated users', async () => {
    const { data: planNameData, error: planNameError } = await attackerSupabase.rpc('get_current_plan_name_org', {
      orgid: orgId,
    })
    expect(planNameError).toBeNull()
    expect(planNameData).toBeNull()

    const { data: cycleData, error: cycleError } = await attackerSupabase.rpc('get_cycle_info_org', {
      orgid: orgId,
    })
    expect(cycleError).toBeNull()
    expect(cycleData).toEqual([])

    const { data: usageData, error: usageError } = await attackerSupabase.rpc('get_plan_usage_percent_detailed', {
      orgid: orgId,
    })
    expect(usageError).toBeNull()
    expect(usageData).toEqual([])
  })

  it.concurrent('rejects anonymous execution of the hardened RPCs', async () => {
    const { data: planNameData, error: planNameError } = await anonSupabase.rpc('get_current_plan_name_org', {
      orgid: orgId,
    })
    expect(planNameData).toBeNull()
    expect(planNameError).toBeTruthy()
    expect(planNameError?.code === '42501' || /permission denied/i.test(planNameError?.message || '')).toBe(true)

    const { data: cycleData, error: cycleError } = await anonSupabase.rpc('get_cycle_info_org', {
      orgid: orgId,
    })
    expect(cycleData).toBeNull()
    expect(cycleError).toBeTruthy()
    expect(cycleError?.code === '42501' || /permission denied/i.test(cycleError?.message || '')).toBe(true)

    const { data: usageData, error: usageError } = await anonSupabase.rpc('get_plan_usage_percent_detailed', {
      orgid: orgId,
    })
    expect(usageData).toBeNull()
    expect(usageError).toBeTruthy()
    expect(usageError?.code === '42501' || /permission denied/i.test(usageError?.message || '')).toBe(true)
  })
})
