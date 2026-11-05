import type { Database } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getPostgresClient,
  getSupabaseClient,
  ORG_ID,
  ORG_ID_2,
  USER_EMAIL,
  USER_ID,
  USER_ID_2,
  USER_PASSWORD,
} from './test-utils'

const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace('localhost', '127.0.0.1').replace(/\/$/, '')
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY ?? ''
const USE_CLOUDFLARE_WORKERS = env.USE_CLOUDFLARE_WORKERS === 'true'

const APP_ID = 'com.demo.app'
const ORG_ADMIN_USER_ID = 'c591b04e-cf29-4945-b9a0-776d0672061a'
const USER_EMAIL_2 = 'test2@capgo.app'
const OUTSIDER_EMAIL = `rbac-direct-outsider-${randomUUID()}@capgo.test`
const OUTSIDER_PASSWORD = `Capgo!${randomUUID()}`

type DirectCheckArgs = Database['public']['Functions']['rbac_check_permission_direct']['Args']
type DirectCheckFn = 'rbac_check_permission_direct' | 'rbac_check_permission_direct_no_password_policy'

const serviceRoleSupabase = getSupabaseClient()
let outsiderUserId: string

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

function isPermissionDenied(error: { code?: string, message?: string } | null) {
  return error?.code === '42501' || /permission denied/i.test(error?.message ?? '')
}

async function directCheck(
  client: Awaited<ReturnType<typeof createAuthenticatedClient>>,
  fn: DirectCheckFn,
  permission: string,
  userId: string,
  scope: { orgId?: string | null, appId?: string | null },
) {
  const { data, error } = await client.rpc(fn, {
    p_permission_key: permission,
    p_user_id: userId,
    p_org_id: scope.orgId ?? null,
    p_app_id: scope.appId ?? null,
    p_channel_id: null,
  } as unknown as DirectCheckArgs)
  expect(error).toBeNull()
  return data
}

describe.skipIf(USE_CLOUDFLARE_WORKERS)('direct RBAC checks are bound to the caller', () => {
  beforeAll(async () => {
    const { data, error } = await serviceRoleSupabase.auth.admin.createUser({
      email: OUTSIDER_EMAIL,
      password: OUTSIDER_PASSWORD,
      email_confirm: true,
    })
    if (error)
      throw error
    outsiderUserId = data.user.id
  })

  afterAll(async () => {
    if (outsiderUserId)
      await serviceRoleSupabase.auth.admin.deleteUser(outsiderUserId)
  })

  it('returns false when an outsider checks another org\'s users', async () => {
    const outsider = await createAuthenticatedClient(OUTSIDER_EMAIL, OUTSIDER_PASSWORD)

    for (const fn of ['rbac_check_permission_direct', 'rbac_check_permission_direct_no_password_policy'] as const) {
      expect(await directCheck(outsider, fn, 'org.read', USER_ID, { orgId: ORG_ID })).toBe(false)
      expect(await directCheck(outsider, fn, 'org.delete', USER_ID, { orgId: ORG_ID })).toBe(false)
      expect(await directCheck(outsider, fn, 'app.read', USER_ID, { appId: APP_ID })).toBe(false)
      expect(await directCheck(outsider, fn, 'app.upload_bundle', USER_ID, { orgId: ORG_ID, appId: APP_ID })).toBe(false)
      expect(await directCheck(outsider, fn, 'org.read', USER_ID_2, { orgId: ORG_ID_2 })).toBe(false)
      // Org-less scopes never resolve another user's permissions.
      expect(await directCheck(outsider, fn, 'org.read', USER_ID, {})).toBe(false)
    }
  })

  it('keeps self checks working for the caller', async () => {
    const owner = await createAuthenticatedClient(USER_EMAIL, USER_PASSWORD)
    const outsider = await createAuthenticatedClient(OUTSIDER_EMAIL, OUTSIDER_PASSWORD)

    expect(await directCheck(owner, 'rbac_check_permission_direct', 'org.read', USER_ID, { orgId: ORG_ID })).toBe(true)
    expect(await directCheck(owner, 'rbac_check_permission_direct', 'app.read', USER_ID, { appId: APP_ID })).toBe(true)
    expect(await directCheck(outsider, 'rbac_check_permission_direct', 'org.read', outsiderUserId, { orgId: ORG_ID })).toBe(false)
  })

  it('lets org members resolve other members of the same org (console path)', async () => {
    const owner = await createAuthenticatedClient(USER_EMAIL, USER_PASSWORD)
    const member = await createAuthenticatedClient(USER_EMAIL_2, USER_PASSWORD)

    // Owner checks a plain member.
    expect(await directCheck(owner, 'rbac_check_permission_direct', 'org.read', USER_ID_2, { orgId: ORG_ID })).toBe(true)
    expect(await directCheck(owner, 'rbac_check_permission_direct', 'org.update_user_roles', USER_ID_2, { orgId: ORG_ID })).toBe(false)

    // A blocked member looks up who can grant access (RbacPermissionOnlyModal).
    expect(await directCheck(member, 'rbac_check_permission_direct', 'org.update_user_roles', ORG_ADMIN_USER_ID, { orgId: ORG_ID })).toBe(true)
    expect(await directCheck(member, 'rbac_check_permission_direct_no_password_policy', 'org.update_user_roles', USER_ID, { orgId: ORG_ID })).toBe(true)
  })

  it('keeps the no-password-policy variant ungated by the caller\'s password policy', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const orgId = randomUUID()
    const claims = JSON.stringify({ sub: USER_ID, role: 'authenticated' })

    try {
      await client.query('BEGIN')
      // The org creator (USER_ID) gets org_super_admin but has no password
      // compliance record, so they fail this org's password policy.
      await client.query(
        `INSERT INTO public.orgs (id, name, management_email, created_by, password_policy_config)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb)`,
        [orgId, `rbac-direct-pp-${orgId}`, USER_EMAIL, USER_ID, JSON.stringify({
          enabled: true,
          min_length: 10,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        })],
      )
      await client.query(
        `INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
         SELECT public.rbac_principal_user(), $1::uuid, r.id, public.rbac_scope_org(), $2::uuid, $3::uuid
         FROM public.roles r
         WHERE r.name = 'org_member'`,
        [ORG_ADMIN_USER_ID, orgId, USER_ID],
      )
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true),
                set_config('request.jwt.claim.sub', $2, true),
                set_config('request.jwt.claim.role', 'authenticated', true)`,
        [claims, USER_ID],
      )
      await client.query('SET LOCAL ROLE authenticated')

      const { rows } = await client.query(
        `SELECT
           public.rbac_check_permission_direct('org.read', $1::uuid, $2::uuid, NULL, NULL) AS gated,
           public.rbac_check_permission_direct_no_password_policy('org.read', $1::uuid, $2::uuid, NULL, NULL) AS ungated`,
        [ORG_ADMIN_USER_ID, orgId],
      )
      expect(rows[0].gated).toBe(false)
      expect(rows[0].ungated).toBe(true)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('does not expose arbitrary-user admin probes to signed-in users', async () => {
    const outsider = await createAuthenticatedClient(OUTSIDER_EMAIL, OUTSIDER_PASSWORD)

    const { data: app, error: appError } = await serviceRoleSupabase
      .from('apps')
      .select('id')
      .eq('app_id', APP_ID)
      .single()
    expect(appError).toBeNull()
    const appUuid = app?.id
    expect(appUuid).toBeTruthy()

    const orgAdmin = await outsider.rpc('is_user_org_admin', { p_user_id: USER_ID, p_org_id: ORG_ID })
    const appAdmin = await outsider.rpc('is_user_app_admin', { p_user_id: USER_ID, p_app_id: appUuid as string })

    expect(isPermissionDenied(orgAdmin.error)).toBe(true)
    expect(orgAdmin.data).toBeNull()
    expect(isPermissionDenied(appAdmin.error)).toBe(true)
    expect(appAdmin.data).toBeNull()

    // Internal callers keep access.
    const internal = await serviceRoleSupabase.rpc('is_user_org_admin', { p_user_id: USER_ID, p_org_id: ORG_ID })
    expect(internal.error).toBeNull()
    expect(internal.data).toBe(true)
  })
})
