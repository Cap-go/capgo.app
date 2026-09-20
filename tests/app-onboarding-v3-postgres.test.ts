import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { persistAppOnboarding } from '../supabase/functions/_backend/public/app/put.ts'
import { lockAppOnboardingForWrite } from '../supabase/functions/_backend/utils/appOnboardingWriteLock.ts'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { executeSQL, getPostgresClient, POSTGRES_URL } from './test-utils.ts'

afterAll(async () => (await getPostgresClient()).end())

describe('v3 checklist SQL security and bounded lookups', () => {
  it('commits caller-RLS settings and progress together, rolling back both if the progress merge fails', async () => {
    const client = await (await getPostgresClient()).connect()
    const orgId = randomUUID()
    const appId = `com.onboarding.atomic.${randomUUID()}`
    let restoreQuery: (() => void) | undefined
    try {
      const userId = (await client.query('SELECT id FROM public.users WHERE email = \'test@capgo.app\'')).rows[0].id
      await client.query('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [orgId, userId, 'Onboarding atomic test', 'test@capgo.app'])
      await client.query(`INSERT INTO public.org_users(org_id, user_id, rbac_role_name, is_invite) VALUES ($1, $2, public.rbac_role_org_super_admin(), false) ON CONFLICT DO NOTHING`, [orgId, userId])
      await client.query(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, r.id, public.rbac_scope_org(), $2::uuid, $1::uuid, 'Onboarding atomic test', true FROM public.roles r WHERE r.name = public.rbac_role_org_super_admin() AND r.scope_type = public.rbac_scope_org() ON CONFLICT DO NOTHING`, [userId, orgId])
      await client.query('INSERT INTO public.apps(app_id, owner_org, name, icon_url, need_onboarding) VALUES ($1, $2, \'Before\', \'\', false)', [appId, orgId])
      const before = (await client.query('SELECT name, onboarding FROM public.apps WHERE app_id = $1', [appId])).rows[0]
      const originalRole = (await client.query('SELECT current_user AS role')).rows[0].role
      const auth = { authType: 'jwt', userId, claims: { sub: userId, role: 'authenticated' } }
      const context = { get: (key: string) => key === 'auth' ? auth : undefined, env: {} } as any
      const apikey = { user_id: userId, key: null } as any
      const patch = { steps: { add_code: { status: 'done' as const } } }
      const originalQuery = client.query.bind(client)
      let injected = false
      const querySpy = vi.spyOn(client, 'query').mockImplementation(((...args: any[]) => {
        const queryText = typeof args[0] === 'string' ? args[0] : args[0]?.text
        if (queryText?.includes('merge_app_onboarding_setup')) {
          injected = true
          return Promise.reject(new Error('Injected progress merge failure'))
        }
        return (originalQuery as any)(...args)
      }) as any)
      restoreQuery = () => querySpy.mockRestore()
      await expect(persistAppOnboarding(context, appId, patch, apikey, client, false, { name: 'After' })).rejects.toMatchObject({ cause: { message: 'Injected progress merge failure' } })
      expect(injected).toBe(true)
      restoreQuery()
      expect((await client.query('SELECT name, onboarding FROM public.apps WHERE app_id = $1', [appId])).rows[0]).toEqual(before)

      const result = await persistAppOnboarding(context, appId, patch, apikey, client, false, { name: 'After' })
      expect(result?.app.name).toBe('After')
      expect((result?.app.onboarding as any).setup.steps.add_code.status).toBe('done')
      const committed = (await client.query('SELECT name, onboarding FROM public.apps WHERE app_id = $1', [appId])).rows[0]
      expect(committed.name).toBe('After')
      expect(committed.onboarding.setup.steps.add_code.status).toBe('done')
      expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe(originalRole)
    }
    finally {
      restoreQuery?.()
      await client.query('ROLLBACK')
      await client.query('DELETE FROM public.apps WHERE app_id = $1', [appId])
      await client.query('DELETE FROM public.orgs WHERE id = $1', [orgId])
      client.release()
    }
  })
  it('serializes onboarding writes with RBAC revocation and reads permission after the revocation commits', async () => {
    // The shared test pool deliberately has max=1; this concurrency check needs
    // two independent connections without changing other tests' pool behavior.
    const pool = new Pool({ connectionString: POSTGRES_URL, max: 2 })
    const revoker = await pool.connect()
    const writer = await pool.connect()
    const orgId = randomUUID()
    const appId = `com.onboarding.lock.${randomUUID()}`
    let pendingWrite: Promise<boolean> | undefined
    try {
      // Reuse only read-only seed identities; every modified resource belongs
      // to this test's new organization.
      const ownerId = (await revoker.query('SELECT id FROM public.users WHERE email = \'test@capgo.app\'')).rows[0].id
      const userId = (await revoker.query('SELECT id FROM public.users WHERE email = \'admin@capgo.app\'')).rows[0].id
      await revoker.query('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [orgId, ownerId, 'Onboarding lock test', 'test@capgo.app'])
      // Keep a separate active owner so revoking the second member respects the
      // database's last-super-admin guard instead of bypassing it.
      for (const memberId of [ownerId, userId]) {
        await revoker.query(`INSERT INTO public.org_users(org_id, user_id, rbac_role_name, is_invite) VALUES ($1, $2, public.rbac_role_org_super_admin(), false) ON CONFLICT DO NOTHING`, [orgId, memberId])
        await revoker.query(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, r.id, public.rbac_scope_org(), $2::uuid, $3::uuid, 'Onboarding lock test', true FROM public.roles r WHERE r.name = public.rbac_role_org_super_admin() AND r.scope_type = public.rbac_scope_org() ON CONFLICT DO NOTHING`, [memberId, orgId, ownerId])
      }
      await revoker.query('INSERT INTO public.apps(app_id, owner_org, name, icon_url) VALUES ($1, $2, \'Onboarding lock test\', \'\')', [appId, orgId])
      const permissionQuery = 'SELECT public.rbac_check_permission_direct(\'org.create_app\', $1::uuid, $2::uuid, NULL::text, NULL::bigint, NULL::text) AS allowed'
      expect((await revoker.query(permissionQuery, [userId, orgId])).rows[0].allowed).toBe(true)
      await revoker.query('BEGIN')
      await revoker.query('SELECT public.lock_rbac_orgs($1::uuid)', [orgId])
      await revoker.query('DELETE FROM public.role_bindings WHERE org_id = $1 AND principal_type = public.rbac_principal_user() AND principal_id = $2', [orgId, userId])
      await writer.query('BEGIN')
      const pid = (await writer.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid
      pendingWrite = (async () => {
        expect(await lockAppOnboardingForWrite(getDrizzleClient(writer, { logger: false }), appId)).toMatchObject({ owner_org: orgId })
        return (await writer.query(permissionQuery, [userId, orgId])).rows[0].allowed as boolean
      })()
      await expect.poll(async () => (await revoker.query('SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wait_event).toBe('advisory')
      await revoker.query('COMMIT')
      expect(await pendingWrite).toBe(false)
    }
    finally {
      await revoker.query('ROLLBACK')
      // Release a blocked writer before cleaning up, including failed assertions.
      await pendingWrite?.catch(() => undefined)
      await writer.query('ROLLBACK')
      await revoker.query('DELETE FROM public.apps WHERE app_id = $1', [appId])
      await revoker.query('DELETE FROM public.orgs WHERE id = $1', [orgId])
      writer.release()
      revoker.release()
      await pool.end()
    }
  })
  it('assigns direct authenticated inserts using the real caller and freezes the version on updates', async () => {
    const client = await (await getPostgresClient()).connect()
    const userId = randomUUID()
    const orgId = randomUUID()
    const appId = `com.onboarding.direct.${randomUUID()}`
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO auth.users(id, email) VALUES ($1, $2)', [userId, `v3-direct-${userId}@example.com`])
      await client.query(`INSERT INTO public.users(id, email, onboarding) VALUES ($1, $2, $3::jsonb)`, [userId, `v3-direct-${userId}@example.com`, JSON.stringify({ intent: 'ota', abtests: { ota_todo_list_v3: { branch: 'A' } } })])
      await client.query('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [orgId, userId, 'Direct v3 test', `v3-direct-${userId}@example.com`])
      await client.query(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, r.id, public.rbac_scope_org(), $2::uuid, $1::uuid, 'Direct v3 test', true FROM public.roles r WHERE r.name = public.rbac_role_org_super_admin() AND r.scope_type = public.rbac_scope_org() ON CONFLICT DO NOTHING`, [userId, orgId])
      await client.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, true), pg_catalog.set_config('request.jwt.claims', $2, true)`, [userId, JSON.stringify({ sub: userId, role: 'authenticated' })])
      await client.query('SET LOCAL ROLE authenticated')
      await client.query(`INSERT INTO public.apps(app_id, owner_org, name, icon_url, onboarding) VALUES ($1, $2, 'Direct v3 test', '', $3::jsonb)`, [appId, orgId, JSON.stringify({ created_by_user_id: randomUUID(), setup: { todo_list_version: 1 } })])
      const inserted = await client.query('SELECT onboarding FROM public.apps WHERE app_id = $1', [appId])
      expect(inserted.rows[0].onboarding).toMatchObject({ created_by_user_id: userId, setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: { add_channel: { status: 'pending' } } } } })
      const updated = await client.query(`UPDATE public.apps SET onboarding = '{"setup":{"todo_list_version":1}}'::jsonb WHERE app_id = $1 RETURNING onboarding`, [appId])
      expect(updated.rows[0].onboarding.setup.todo_list_version).toBe(4)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it.concurrent('keeps the merger and assignment trigger internal with empty search paths', async () => {
    const rows = await executeSQL(`
      SELECT p.proname, p.prosecdef, p.proconfig,
        pg_catalog.pg_get_userbyid(p.proowner) AS owner,
        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('merge_app_onboarding_setup', 'assign_app_onboarding_todo_list_version')
    `)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({ owner: 'postgres', anon: false, authenticated: false, service_role: true })
      expect(row.proconfig).toContain('search_path=""')
    }
    expect(rows.find(row => row.proname === 'assign_app_onboarding_todo_list_version').prosecdef).toBe(true)
  })
  it.concurrent('uses a creator/version partial index for the CLI/MCP login lookup', async () => {
    const index = await executeSQL(`SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apps_onboarding_login_creator'`)
    expect(index).toHaveLength(1)
    expect(index[0].indexdef).toContain('created_by_user_id')
    expect(index[0].indexdef).toContain('\'3\'::text')
    expect(index[0].indexdef).toContain('\'4\'::text')
  })
})
