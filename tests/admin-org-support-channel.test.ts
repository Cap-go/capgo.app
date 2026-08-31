import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, fetchTestRequest, getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, USER_ADMIN_EMAIL, USER_ID } from './test-utils.ts'

const TEST_ORG_ID = randomUUID()
const TEST_ORG_NAME = `Enterprise Channel Org ${TEST_ORG_ID.slice(0, 8)}`
const TEST_CUSTOMER_ID = `cus_ent_channel_${TEST_ORG_ID.slice(0, 8)}`
const ENTERPRISE_PRODUCT_ID = 'prod_MH5Jh6ajC9e7ZH'
const ADMIN_PASSWORD = 'adminadmin'
const PAID_AT = '2026-01-15T12:00:00.000Z'

let adminHeaders: Record<string, string>
let nonAdminHeaders: Record<string, string>

beforeAll(async () => {
  adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, ADMIN_PASSWORD)
  nonAdminHeaders = await getAuthHeaders()

  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: TEST_CUSTOMER_ID,
    status: 'succeeded',
    product_id: ENTERPRISE_PRODUCT_ID,
    subscription_id: `sub_${TEST_ORG_ID}`,
    paid_at: PAID_AT,
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: TEST_ORG_ID,
    name: TEST_ORG_NAME,
    management_email: `enterprise-channel-${TEST_ORG_ID.slice(0, 8)}@capgo.app`,
    created_by: USER_ID,
    customer_id: TEST_CUSTOMER_ID,
  })
  if (orgError)
    throw orgError
})

afterAll(async () => {
  await getSupabaseClient().from('role_bindings').delete().eq('org_id', TEST_ORG_ID)
  await getSupabaseClient().from('org_users').delete().eq('org_id', TEST_ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', TEST_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', TEST_CUSTOMER_ID)
})

describe('[POST] /private/admin_org_support_channel', () => {
  it.concurrent('rejects unauthenticated requests', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_org_support_channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        support_channel_type: 'slack',
        support_channel_url: 'https://capgo.slack.com/archives/test',
      }),
    })
    expect(response.status).toBe(401)
  })

  it('rejects non-admin users', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/admin_org_support_channel'), {
      method: 'POST',
      headers: nonAdminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        support_channel_type: 'slack',
        support_channel_url: 'https://capgo.slack.com/archives/test',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('lets a platform admin set and clear a support channel', async () => {
    const setResponse = await fetchTestRequest(getEndpointUrl('/private/admin_org_support_channel'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        support_channel_type: 'slack',
        support_channel_url: 'https://capgo.slack.com/archives/test',
      }),
    })
    expect(setResponse.status).toBe(200)

    const { data: saved } = await getSupabaseClient()
      .from('orgs')
      .select('support_channel_type, support_channel_url, support_channel_set_at')
      .eq('id', TEST_ORG_ID)
      .single()

    expect(saved?.support_channel_type).toBe('slack')
    expect(saved?.support_channel_url).toBe('https://capgo.slack.com/archives/test')
    expect(saved?.support_channel_set_at).toBeTruthy()

    const clearResponse = await fetchTestRequest(getEndpointUrl('/private/admin_org_support_channel'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        support_channel_type: null,
        support_channel_url: null,
      }),
    })
    expect(clearResponse.status).toBe(200)

    const { data: cleared } = await getSupabaseClient()
      .from('orgs')
      .select('support_channel_type, support_channel_url, support_channel_set_at')
      .eq('id', TEST_ORG_ID)
      .single()

    expect(cleared?.support_channel_type).toBeNull()
    expect(cleared?.support_channel_url).toBeNull()
    expect(cleared?.support_channel_set_at).toBeNull()
  })

  it('blocks direct client writes to support channel columns', async () => {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey)
      throw new Error('Missing Supabase env for client write test')

    const { createClient } = await import('@supabase/supabase-js')
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data, error } = await client.auth.signInWithPassword({
      email: 'test@capgo.app',
      password: 'testtest',
    })
    if (error || !data.session)
      throw error ?? new Error('Failed to sign in test user')

    const { error: updateError } = await client
      .from('orgs')
      .update({
        support_channel_type: 'discord',
        support_channel_url: 'https://discord.gg/capgo-test',
      })
      .eq('id', TEST_ORG_ID)

    expect(updateError).toBeTruthy()

    const { data: afterWrite } = await getSupabaseClient()
      .from('orgs')
      .select('support_channel_type, support_channel_url')
      .eq('id', TEST_ORG_ID)
      .single()

    expect(afterWrite?.support_channel_type).toBeNull()
    expect(afterWrite?.support_channel_url).toBeNull()
  })
})

describe('[POST] /private/admin_stats enterprise_adoption', () => {
  it('returns a daily enterprise trend including configured channels', async () => {
    const setResponse = await fetchTestRequest(getEndpointUrl('/private/admin_org_support_channel'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        support_channel_type: 'teams',
        support_channel_url: 'https://teams.microsoft.com/l/channel/test',
      }),
    })
    expect(setResponse.status).toBe(200)

    const endDate = new Date()
    endDate.setUTCHours(23, 59, 59, 0)

    const response = await fetchTestRequest(getEndpointUrl('/private/admin_stats'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'enterprise_adoption',
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: endDate.toISOString(),
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        trend: Array<{ date: string, enterprise_count: number, sso_count: number, channel_count: number }>
      }
    }

    expect(payload.success).toBe(true)
    expect(payload.data.trend.length).toBeGreaterThan(0)
    const latest = payload.data.trend[payload.data.trend.length - 1]
    expect(latest.enterprise_count).toBeGreaterThanOrEqual(1)
    expect(latest.channel_count).toBeGreaterThanOrEqual(1)
    expect(latest.sso_count).toBeGreaterThanOrEqual(0)
  })
})
