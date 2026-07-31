// Regression test for the "Plan upgrade required for upload" RBAC bug.
//
// Background: old CLI versions call is_allowed_action_org_action(orgid, actions)
// without an appid. Newer callers can pass appid so the plan check can enforce
// app-scoped RBAC bindings when it has the app context. This keeps the old
// two-argument function shape compatible while proving the three-argument
// overload does not widen an app-scoped API key to sibling apps.

import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, getSupabaseClient, normalizeLocalhostUrl, SUPABASE_ANON_KEY } from './test-utils.ts'

const SUPABASE_URL = normalizeLocalhostUrl(env.SUPABASE_URL) ?? ''
const USE_CLOUDFLARE_WORKERS = env.USE_CLOUDFLARE_WORKERS === 'true'

if (!SUPABASE_URL)
  throw new Error('SUPABASE_URL is required for plan-check appid passthrough tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for plan-check appid passthrough tests')

const serviceRoleSupabase = getSupabaseClient()

const SUITE_ID = randomUUID()
const OWNER_EMAIL = `plan-check-owner-${SUITE_ID}@capgo.test`
const CUSTOMER_ID = `cus_plan_check_${SUITE_ID.replace(/-/g, '')}`
const PRIMARY_APP_ID = `com.capgo.test.primary.${SUITE_ID}`
const OTHER_APP_ID = `com.capgo.test.other.${SUITE_ID}`

let ownerUserId: string
let orgId: string
let primaryAppUuid: string
let otherAppUuid: string
let apiKeyPlain: string
let apiKeyRow: { id: number, rbac_id: string }

function createCapgkeyClient(apikey: string) {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        capgkey: apikey,
      },
    },
  })
}

describe.skipIf(USE_CLOUDFLARE_WORKERS)('plan-check appid passthrough (RBAC bindings)', () => {
  beforeAll(async () => {
    // 1. User. public.users has a FK to auth.users, so we provision via
    //    auth admin first. The CLI authenticates by capgkey header, not by
    //    a Supabase JWT, but the FK still needs satisfying.
    const { data: authUser, error: authUserError } = await serviceRoleSupabase.auth.admin.createUser({
      email: OWNER_EMAIL,
      password: `Capgo!${SUITE_ID}`,
      email_confirm: true,
    })
    if (authUserError)
      throw authUserError
    ownerUserId = authUser.user.id

    const { error: userError } = await serviceRoleSupabase.from('users').insert({
      id: ownerUserId,
      email: OWNER_EMAIL,
    })
    if (userError)
      throw userError

    // 2. Active stripe_info. status = 'succeeded', no *_exceeded flags,
    //    so is_paying_and_good_plan_org_action's billing branch returns true
    //    once auth passes.
    const { data: planRow, error: planError } = await serviceRoleSupabase
      .from('plans')
      .select('stripe_id')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    if (planError)
      throw planError

    const { error: stripeError } = await serviceRoleSupabase.from('stripe_info').insert({
      customer_id: CUSTOMER_ID,
      product_id: planRow.stripe_id,
      status: 'succeeded',
      subscription_anchor_start: new Date(Date.now() - 10 * 86400_000).toISOString(),
      subscription_anchor_end: new Date(Date.now() + 20 * 86400_000).toISOString(),
    })
    if (stripeError)
      throw stripeError

    // 3. Org whose permission checks route through rbac_check_permission_direct.
    const { data: orgRow, error: orgError } = await serviceRoleSupabase
      .from('orgs')
      .insert({
        created_by: ownerUserId,
        name: `Plan Check Test Org ${SUITE_ID}`,
        management_email: OWNER_EMAIL,
        customer_id: CUSTOMER_ID,
      })
      .select('id')
      .single()
    if (orgError)
      throw orgError
    orgId = orgRow.id

    // 4. Two apps in the same org - one the key is allowed for, one it isn't.
    //    Same-org apps prove the rejection comes from app RBAC bindings, not
    //    from the cross-org RBAC check.
    const { data: primaryAppRow, error: primaryAppError } = await serviceRoleSupabase
      .from('apps')
      .insert({
        app_id: PRIMARY_APP_ID,
        name: 'Plan Check Primary App',
        icon_url: 'https://example.test/icon.png',
        user_id: ownerUserId,
        owner_org: orgId,
      })
      .select('id')
      .single()
    if (primaryAppError)
      throw primaryAppError
    if (!primaryAppRow.id)
      throw new Error('Expected primary app insert to return an id')
    primaryAppUuid = primaryAppRow.id

    const { data: otherAppRow, error: otherAppError } = await serviceRoleSupabase
      .from('apps')
      .insert({
        app_id: OTHER_APP_ID,
        name: 'Plan Check Other App',
        icon_url: 'https://example.test/icon.png',
        user_id: ownerUserId,
        owner_org: orgId,
      })
      .select('id')
      .single()
    if (otherAppError)
      throw otherAppError
    if (!otherAppRow.id)
      throw new Error('Expected other app insert to return an id')
    otherAppUuid = otherAppRow.id

    // 5. RBAC-managed API key with org read compatibility and upload access
    //    only for the primary app. This mirrors the V2 key shape after the
    //    old scope columns have been removed.
    const apikeyRow = await createDirectApiKeyWithBindings({
      userId: ownerUserId,
      key: randomUUID(),
      name: `plan-check-rbac-${SUITE_ID}`,
      orgId,
      roleName: 'org_member',
      appId: PRIMARY_APP_ID,
      appRoleName: 'app_uploader',
    })
    if (!apikeyRow.rbac_id)
      throw new Error('Expected apikey insert to return rbac_id')
    if (!apikeyRow.key)
      throw new Error('Expected plaintext key in apikey insert RETURNING row')
    apiKeyRow = { id: apikeyRow.id, rbac_id: apikeyRow.rbac_id }
    apiKeyPlain = apikeyRow.key
  })

  afterAll(async () => {
    if (apiKeyRow?.id)
      await serviceRoleSupabase.from('role_bindings').delete().eq('principal_id', apiKeyRow.rbac_id)
    if (apiKeyRow?.id)
      await serviceRoleSupabase.from('apikeys').delete().eq('id', apiKeyRow.id)
    if (primaryAppUuid)
      await serviceRoleSupabase.from('apps').delete().eq('id', primaryAppUuid)
    if (otherAppUuid)
      await serviceRoleSupabase.from('apps').delete().eq('id', otherAppUuid)
    if (orgId)
      await serviceRoleSupabase.from('orgs').delete().eq('id', orgId)
    await serviceRoleSupabase.from('stripe_info').delete().eq('customer_id', CUSTOMER_ID)
    if (ownerUserId) {
      await serviceRoleSupabase.from('users').delete().eq('id', ownerUserId)
      await serviceRoleSupabase.auth.admin.deleteUser(ownerUserId)
    }
  })

  it('allows the 2-arg call for old CLI compatibility', async () => {
    const client = createCapgkeyClient(apiKeyPlain)
    const { data, error } = await client.rpc('is_allowed_action_org_action', {
      orgid: orgId,
      actions: ['storage'],
    })
    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('allows the 3-arg call when appid matches an app binding', async () => {
    const client = createCapgkeyClient(apiKeyPlain)
    const args = {
      orgid: orgId,
      actions: ['storage'],
      appid: PRIMARY_APP_ID,
    } as never
    const { data, error } = await client.rpc('is_allowed_action_org_action', args)
    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('still denies the 3-arg call when appid does not match an app binding', async () => {
    const client = createCapgkeyClient(apiKeyPlain)
    const args = {
      orgid: orgId,
      actions: ['storage'],
      appid: OTHER_APP_ID,
    } as never
    const { data, error } = await client.rpc('is_allowed_action_org_action', args)
    expect(error).toBeNull()
    // The API key only has an app binding for PRIMARY_APP_ID, so an upload-plan
    // check for OTHER_APP_ID must still be rejected even though both apps are
    // in the same org.
    expect(data).toBe(false)
  })
})
