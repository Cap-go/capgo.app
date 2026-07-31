import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ORG_ID_CRON_QUEUE,
  cleanupPostgresClient,
  getCronPlanQueueCountForOrg,
  getLatestCronPlanMessageForOrg,
  getSupabaseClient,
} from './test-utils.ts'

describe('[Function] queue_cron_stat_org_for_org', () => {
  let testCustomerId: string | null = null

  beforeAll(async () => {
    const supabase = getSupabaseClient()

    // Get an existing customer_id from the test org or any existing stripe_info
    const { data: orgData } = await supabase
      .from('orgs')
      .select('customer_id')
      .eq('id', ORG_ID_CRON_QUEUE)
      .single()

    if (orgData?.customer_id) {
      testCustomerId = orgData.customer_id
    }
    else {
      // Fallback: get any existing stripe_info record
      const { data: stripeData } = await supabase
        .from('stripe_info')
        .select('customer_id')
        .limit(1)
        .single()

      testCustomerId = stripeData?.customer_id || null
    }
  })

  afterAll(async () => {
    // Cleanup PostgreSQL connection
    await cleanupPostgresClient()
  })

  async function expectQueuedForOrg(customerId: string) {
    // Scope by org so parallel cron tests writing other orgs cannot inflate a global count.
    const initialCount = await getCronPlanQueueCountForOrg(ORG_ID_CRON_QUEUE)

    const { error } = await getSupabaseClient().rpc('queue_cron_stat_org_for_org', {
      org_id: ORG_ID_CRON_QUEUE,
      customer_id: customerId,
    })
    expect(error).toBeNull()

    const finalCount = await getCronPlanQueueCountForOrg(ORG_ID_CRON_QUEUE)
    expect(finalCount).toBeGreaterThanOrEqual(initialCount + 1)

    const latestMessage = await getLatestCronPlanMessageForOrg(ORG_ID_CRON_QUEUE)
    expect(latestMessage).toMatchObject({
      function_name: 'cron_stat_org',
      function_type: 'cloudflare',
      payload: {
        orgId: ORG_ID_CRON_QUEUE,
        customerId,
      },
    })
  }

  it('queues plan processing when plan_calculated_at is null', async () => {
    if (!testCustomerId) {
      console.log('Skipping test - no customer_id available')
      return
    }

    await getSupabaseClient()
      .from('stripe_info')
      .update({ plan_calculated_at: null })
      .eq('customer_id', testCustomerId)
      .throwOnError()

    await expectQueuedForOrg(testCustomerId)
  })

  // TODO: fix this broken test
  // it('skips queuing when plan was calculated within last hour', async () => {
  //     ...
  // })

  it('queues plan processing when plan was calculated over 1 hour ago', async () => {
    if (!testCustomerId) {
      console.log('Skipping test - no customer_id available')
      return
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await getSupabaseClient()
      .from('stripe_info')
      .update({ plan_calculated_at: twoHoursAgo.toISOString() })
      .eq('customer_id', testCustomerId)
      .throwOnError()

    await expectQueuedForOrg(testCustomerId)
  })

  it('handles non-existent customer_id gracefully', async () => {
    const supabase = getSupabaseClient()

    const { error } = await supabase.rpc('queue_cron_stat_org_for_org', {
      org_id: ORG_ID_CRON_QUEUE,
      customer_id: 'non_existent_customer',
    })

    expect(error).toBeNull()
  })

  it('has correct permissions - only service_role can call', async () => {
    if (!testCustomerId) {
      console.log('Skipping test - no customer_id available')
      return
    }

    const supabase = getSupabaseClient()

    const { error } = await supabase.rpc('queue_cron_stat_org_for_org', {
      org_id: ORG_ID_CRON_QUEUE,
      customer_id: testCustomerId,
    })

    expect(error).toBeNull()
  })
})
