import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
  PRODUCT_ID,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  TEST_EMAIL,
  USER_EMAIL,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

// Unique identifiers per run so parallel/repeat runs never collide.
const testRunId = randomUUID()
const ORG_ID = testRunId
const APP_ID = `com.compat_events.${testRunId.slice(0, 8)}`
const STRIPE_CUSTOMER_ID = `cus_compat_events_${testRunId.slice(0, 8)}`

// The compatibility_events table and acknowledge_compatibility_event RPC are added
// by a migration that postdates the generated Supabase types, so the typed client
// does not know about them yet. Use an untyped view of each client for those calls.
type UntypedClient = SupabaseClient<any, 'public', any>

interface CompatibilityEventRow {
  id: number
  resolved_at: string | null
  resolved_by: string | null
  resolution_kind: string | null
  resolution_note: string | null
}

async function signInClient(email: string, password: string): Promise<UntypedClient> {
  if (!SUPABASE_BASE_URL || !SUPABASE_ANON_KEY)
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for compatibility_events tests')

  const publicClient = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await publicClient.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token)
    throw error ?? new Error(`Unable to sign in as ${email}`)

  return createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
    },
  }) as UntypedClient
}

function compatTable(client: SupabaseClient<any>) {
  return (client as UntypedClient).from('compatibility_events')
}

async function createUserOrgBinding(orgId: string, userId: string, roleName: string) {
  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_user(),
      $1::uuid,
      roles.id,
      public.rbac_scope_org(),
      $2::uuid,
      $1::uuid,
      'Compatibility events test binding',
      true
    FROM public.roles roles
    WHERE roles.name = $3
      AND roles.scope_type = public.rbac_scope_org()
    ON CONFLICT DO NOTHING
  `, [userId, orgId, roleName])
}

// The uq_compatibility_events_dedup index covers
// (app_id, channel_id, platform, current_version_id, previous_version_id) with
// NULLS NOT DISTINCT, so a synthetic distinct channel_id per row keeps every
// inserted test event unique even when the other columns repeat.
let nextChannelId = 1

async function insertEvent(values: {
  platform: string
  channelName?: string
  currentVersionName?: string
  previousVersionName?: string
  source?: string
}): Promise<number> {
  const { data, error } = await compatTable(getSupabaseClient())
    .insert({
      org_id: ORG_ID,
      app_id: APP_ID,
      source: values.source ?? 'default_channel_version_changed',
      platform: values.platform,
      channel_id: nextChannelId++,
      channel_name: values.channelName ?? 'production',
      current_version_name: values.currentVersionName ?? '2.0.0',
      previous_version_name: values.previousVersionName ?? '1.0.0',
    })
    .select('id')
    .single()
  if (error || !data)
    throw error ?? new Error('Failed to insert compatibility_event')
  return (data as { id: number }).id
}

async function getEventById(id: number): Promise<CompatibilityEventRow> {
  const { data, error } = await compatTable(getSupabaseClient())
    .select('id, resolved_at, resolved_by, resolution_kind, resolution_note')
    .eq('id', id)
    .single()
  if (error || !data)
    throw error ?? new Error(`Compatibility event ${id} not found`)
  return data as CompatibilityEventRow
}

let memberClient: UntypedClient
let nonMemberClient: UntypedClient

beforeAll(async () => {
  const supabase = getSupabaseClient()

  // Clean any leftovers from a previous aborted run (best effort).
  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
  await supabase.from('role_bindings').delete().eq('org_id', ORG_ID)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)

  const { error: stripeError } = await supabase.from('stripe_info').insert({
    subscription_id: `sub_compat_events_${testRunId.slice(0, 8)}`,
    customer_id: STRIPE_CUSTOMER_ID,
    status: 'succeeded' as const,
    product_id: PRODUCT_ID,
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await supabase.from('orgs').insert({
    id: ORG_ID,
    customer_id: STRIPE_CUSTOMER_ID,
    name: `Compatibility Events Test Org ${testRunId.slice(0, 8)}`,
    created_by: USER_ID,
    management_email: TEST_EMAIL,
  })
  if (orgError)
    throw orgError

  const { error: orgUserError } = await supabase.from('org_users').insert({
    org_id: ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin',
  })
  if (orgUserError)
    throw orgUserError
  await createUserOrgBinding(ORG_ID, USER_ID, 'org_super_admin')

  const { error: appError } = await supabase.from('apps').insert({
    owner_org: ORG_ID,
    app_id: APP_ID,
    name: 'Compatibility Events Test App',
    icon_url: 'https://example.com/icon.png',
  })
  if (appError)
    throw appError

  memberClient = await signInClient(USER_EMAIL, USER_PASSWORD)
  nonMemberClient = await signInClient(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
}, 120000)

afterAll(async () => {
  const supabase = getSupabaseClient()
  // app delete cascades compatibility_events, but delete explicitly to be safe.
  await supabase.from('compatibility_events' as any).delete().eq('app_id', APP_ID)
  await supabase.from('apps').delete().eq('app_id', APP_ID)
  await supabase.from('role_bindings').delete().eq('org_id', ORG_ID)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)
  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
}, 120000)

describe('compatibility_events RLS read access', () => {
  it('lets an org member read their app\'s compatibility events but hides them from non-members', async () => {
    const eventId = await insertEvent({ platform: 'ios' })

    const { data: memberRows, error: memberError } = await compatTable(memberClient)
      .select('id, resolved_at')
      .eq('app_id', APP_ID)
    expect(memberError).toBeNull()
    expect(memberRows).not.toBeNull()
    expect((memberRows as { id: number }[]).some(row => row.id === eventId)).toBe(true)

    const { data: nonMemberRows, error: nonMemberError } = await compatTable(nonMemberClient)
      .select('id')
      .eq('app_id', APP_ID)
    expect(nonMemberError).toBeNull()
    expect(nonMemberRows).toEqual([])
  })
})

describe('acknowledge_compatibility_event RPC', () => {
  it('lets an authorized member accept an unresolved event with a note', async () => {
    const eventId = await insertEvent({ platform: 'android' })
    const note = 'Reviewed and confirmed compatible'

    const { error } = await memberClient.rpc('acknowledge_compatibility_event', {
      event_id: eventId,
      note,
    })
    expect(error).toBeNull()

    const row = await getEventById(eventId)
    expect(row.resolved_at).not.toBeNull()
    expect(row.resolved_by).toBe(USER_ID)
    expect(row.resolution_kind).toBe('accepted')
    expect(row.resolution_note).toBe(note)
  })

  it('rejects an empty/whitespace note and leaves the event unresolved', async () => {
    const eventId = await insertEvent({ platform: 'electron' })

    const { error } = await memberClient.rpc('acknowledge_compatibility_event', {
      event_id: eventId,
      note: '   ',
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('reason_required')

    const row = await getEventById(eventId)
    expect(row.resolved_at).toBeNull()
    expect(row.resolution_kind).toBeNull()
  })

  it('is a silent no-op when a non-member tries to accept an event', async () => {
    const eventId = await insertEvent({ platform: 'ios', channelName: 'beta' })

    const { error } = await nonMemberClient.rpc('acknowledge_compatibility_event', {
      event_id: eventId,
      note: 'Not allowed to do this',
    })
    // No existence oracle: unauthorized callers get no error, just a no-op.
    expect(error).toBeNull()

    const row = await getEventById(eventId)
    expect(row.resolved_at).toBeNull()
    expect(row.resolved_by).toBeNull()
  })

  it('is a silent no-op for an unknown event id', async () => {
    const { error } = await memberClient.rpc('acknowledge_compatibility_event', {
      event_id: 9_999_999_999,
      note: 'Does not exist',
    })
    expect(error).toBeNull()
  })
})

describe('compatibility_events cascade', () => {
  it('removes compatibility events when their app is deleted', async () => {
    const supabase = getSupabaseClient()
    await insertEvent({ platform: 'android', channelName: 'cascade' })

    const { data: before } = await compatTable(supabase).select('id').eq('app_id', APP_ID)
    expect((before as unknown[]).length).toBeGreaterThan(0)

    await supabase.from('apps').delete().eq('app_id', APP_ID).throwOnError()

    const { data: after, error } = await compatTable(supabase).select('id').eq('app_id', APP_ID)
    expect(error).toBeNull()
    expect(after).toEqual([])
  })
})
