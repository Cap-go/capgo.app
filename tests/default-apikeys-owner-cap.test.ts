import type { PoolClient } from 'pg'
/**
 * Default API keys provisioned by createApiKey() must never hold more rights
 * than their owner in any organization or app.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CREATE_DEFAULT_API_KEYS_SQL } from '../supabase/functions/_backend/utils/default_apikeys.ts'
import { ORG_ID, ORG_ID_2, POSTGRES_URL, USER_ID, USER_ID_2 } from './test-utils'

// Seed: ORG_ID owns com.demo.app; USER_ID_2 is org_super_admin of ORG_ID_2
// and only org_member of ORG_ID.
const MEMBER_ORG_APP_ID = 'com.demo.app'
const REMEDIATION_MIGRATION_SQL = readFileSync(
  new URL('../supabase/migrations/20261027013031_cap_default_apikey_bindings_at_owner_rights.sql', import.meta.url),
  'utf8',
)

interface KeyBinding {
  name: string
  role_name: string
  scope_type: string
  org_id: string
  app_id: string | null
}

describe('default API keys are capped at the owner rights', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: unknown[]) => client.query(text, params)

  const bindUser = async (userId: string, roleName: string, orgId: string, appId?: string, expiresAt?: string) => {
    const result = await query(`
      INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, expires_at, granted_by, reason, is_direct)
      SELECT
        public.rbac_principal_user(),
        $1::uuid,
        roles.id,
        roles.scope_type,
        $3::uuid,
        (SELECT apps.id FROM public.apps WHERE apps.app_id = $4::varchar),
        $6::timestamptz,
        $5::uuid,
        'default apikey owner cap test',
        true
      FROM public.roles
      WHERE roles.name = $2
      RETURNING id
    `, [userId, roleName, orgId, appId ?? null, USER_ID, expiresAt ?? null])
    expect(result.rowCount).toBe(1)
  }

  // Only inspect keys created by this provisioning run; seeded keys are left
  // untouched so concurrent tests sharing these users are not blocked.
  let preexistingKeyIds: string[] = []

  const provisionDefaultKeys = async (userId: string) => {
    const before = await query('SELECT id::text AS id FROM public.apikeys WHERE user_id = $1::uuid', [userId])
    preexistingKeyIds = before.rows.map(row => row.id as string)
    await query(CREATE_DEFAULT_API_KEYS_SQL, [userId])
  }

  const keyBindings = async (userId: string, orgId: string) => {
    const result = await query(`
      SELECT apikeys.name, roles.name AS role_name, rb.scope_type, rb.org_id::text AS org_id, apps.app_id
      FROM public.apikeys
      JOIN public.role_bindings rb
        ON rb.principal_type = public.rbac_principal_apikey()
        AND rb.principal_id = apikeys.rbac_id
      JOIN public.roles ON roles.id = rb.role_id
      LEFT JOIN public.apps ON apps.id = rb.app_id
      WHERE apikeys.user_id = $1::uuid
        AND NOT (apikeys.id = ANY($3::bigint[]))
        AND rb.org_id = $2::uuid
      ORDER BY apikeys.name, roles.name, apps.app_id
    `, [userId, orgId, preexistingKeyIds])
    return result.rows as KeyBinding[]
  }

  const keyHasPermission = async (userId: string, keyName: string, permission: string, orgId: string, appId: string | null = null) => {
    const result = await query(`
      SELECT public.rbac_has_permission(
        public.rbac_principal_apikey(),
        apikeys.rbac_id,
        $3,
        $4::uuid,
        $5::varchar,
        NULL::bigint
      ) AS allowed
      FROM public.apikeys
      WHERE apikeys.user_id = $1::uuid
        AND NOT (apikeys.id = ANY($6::bigint[]))
        AND apikeys.name = $2
    `, [userId, keyName, permission, orgId, appId, preexistingKeyIds])
    expect(result.rowCount).toBe(1)
    return result.rows[0].allowed as boolean
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    if (!client)
      return
    await client.query('ROLLBACK')
    client.release()
  })

  afterAll(async () => {
    await pool.end()
  })

  it('does not grant org_admin or app rights in an org where the owner is only org_member', async () => {
    await provisionDefaultKeys(USER_ID_2)

    const memberOrgBindings = await keyBindings(USER_ID_2, ORG_ID)
    expect(memberOrgBindings.some(binding => binding.role_name === 'org_admin' || binding.role_name === 'org_super_admin')).toBe(false)
    expect(memberOrgBindings.filter(binding => binding.scope_type === 'app')).toEqual([])
    expect(memberOrgBindings).toEqual([
      { name: 'default app reader', role_name: 'org_member', scope_type: 'org', org_id: ORG_ID, app_id: null },
      { name: 'default app uploader', role_name: 'org_member', scope_type: 'org', org_id: ORG_ID, app_id: null },
      { name: 'default org admin', role_name: 'org_member', scope_type: 'org', org_id: ORG_ID, app_id: null },
    ])

    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.update_user_roles', ORG_ID)).toBe(false)
    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.manage_apikeys', ORG_ID)).toBe(false)
    expect(await keyHasPermission(USER_ID_2, 'default app uploader', 'app.upload_bundle', ORG_ID, MEMBER_ORG_APP_ID)).toBe(false)
    expect(await keyHasPermission(USER_ID_2, 'default app reader', 'app.read', ORG_ID, MEMBER_ORG_APP_ID)).toBe(false)

    // The org the user administers keeps the expected default admin binding.
    const ownedOrgBindings = await keyBindings(USER_ID_2, ORG_ID_2)
    expect(ownedOrgBindings).toContainEqual({ name: 'default org admin', role_name: 'org_admin', scope_type: 'org', org_id: ORG_ID_2, app_id: null })
    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.update_user_roles', ORG_ID_2)).toBe(true)
  })

  it('grants app roles only on apps where the owner already has those rights', async () => {
    await bindUser(USER_ID_2, 'app_developer', ORG_ID, MEMBER_ORG_APP_ID)

    await provisionDefaultKeys(USER_ID_2)

    const appBindings = (await keyBindings(USER_ID_2, ORG_ID)).filter(binding => binding.scope_type === 'app')
    expect(appBindings).toEqual([
      { name: 'default app reader', role_name: 'app_reader', scope_type: 'app', org_id: ORG_ID, app_id: MEMBER_ORG_APP_ID },
      { name: 'default app uploader', role_name: 'app_uploader', scope_type: 'app', org_id: ORG_ID, app_id: MEMBER_ORG_APP_ID },
    ])
    expect(await keyHasPermission(USER_ID_2, 'default app uploader', 'app.upload_bundle', ORG_ID, MEMBER_ORG_APP_ID)).toBe(true)
    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.update_user_roles', ORG_ID)).toBe(false)
  })

  it('keeps org_admin default bindings for org super admins', async () => {
    await provisionDefaultKeys(USER_ID)

    const bindings = await keyBindings(USER_ID, ORG_ID)
    expect(bindings).toContainEqual({ name: 'default org admin', role_name: 'org_admin', scope_type: 'org', org_id: ORG_ID, app_id: null })
    expect(bindings).toContainEqual({ name: 'default app uploader', role_name: 'app_uploader', scope_type: 'app', org_id: ORG_ID, app_id: MEMBER_ORG_APP_ID })
    expect(bindings).toContainEqual({ name: 'default app reader', role_name: 'app_reader', scope_type: 'app', org_id: ORG_ID, app_id: MEMBER_ORG_APP_ID })
  })

  it('never lets a default key binding outlive the owner access it is derived from', async () => {
    const expiresAt = '2099-01-01T00:00:00.000Z'
    await bindUser(USER_ID_2, 'app_developer', ORG_ID, MEMBER_ORG_APP_ID, expiresAt)

    await provisionDefaultKeys(USER_ID_2)

    const result = await query(`
      SELECT apikeys.name, rb.scope_type, rb.expires_at
      FROM public.apikeys
      JOIN public.role_bindings rb
        ON rb.principal_type = public.rbac_principal_apikey()
        AND rb.principal_id = apikeys.rbac_id
      WHERE apikeys.user_id = $1::uuid
        AND NOT (apikeys.id = ANY($3::bigint[]))
        AND rb.org_id = $2::uuid
      ORDER BY apikeys.name, rb.scope_type
    `, [USER_ID_2, ORG_ID, preexistingKeyIds])
    const rows = result.rows.map(row => ({
      name: row.name as string,
      scope_type: row.scope_type as string,
      expires_at: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    }))
    // org_member is permanent for the owner, while the app rights only come
    // from the expiring app_developer binding.
    expect(rows).toEqual([
      { name: 'default app reader', scope_type: 'app', expires_at: expiresAt },
      { name: 'default app reader', scope_type: 'org', expires_at: null },
      { name: 'default app uploader', scope_type: 'app', expires_at: expiresAt },
      { name: 'default app uploader', scope_type: 'org', expires_at: null },
      { name: 'default org admin', scope_type: 'org', expires_at: null },
    ])
  })

  it('remediates existing default-key bindings that exceed the owner rights', async () => {
    await provisionDefaultKeys(USER_ID_2)
    // Recreate the bindings earlier provisioning produced in an org where the
    // owner is only org_member.
    await query(`
      DELETE FROM public.role_bindings rb
      USING public.apikeys
      WHERE rb.principal_type = public.rbac_principal_apikey()
        AND rb.principal_id = apikeys.rbac_id
        AND apikeys.user_id = $1::uuid
        AND NOT (apikeys.id = ANY($3::bigint[]))
        AND rb.org_id = $2::uuid
    `, [USER_ID_2, ORG_ID, preexistingKeyIds])
    await query(`
      INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct)
      SELECT public.rbac_principal_apikey(), apikeys.rbac_id, roles.id, roles.scope_type, $2::uuid,
        CASE WHEN roles.scope_type = public.rbac_scope_app() THEN (SELECT apps.id FROM public.apps WHERE apps.app_id = $4::varchar) END,
        $1::uuid,
        CASE WHEN roles.scope_type = public.rbac_scope_app() THEN 'Default API key RBAC app binding' ELSE 'Default API key RBAC org binding' END,
        true
      FROM public.apikeys
      JOIN public.roles ON roles.name = CASE apikeys.name
        WHEN 'default org admin' THEN 'org_admin'
        WHEN 'default app uploader' THEN 'app_uploader'
        ELSE 'app_reader'
      END
      WHERE apikeys.user_id = $1::uuid
        AND NOT (apikeys.id = ANY($3::bigint[]))
    `, [USER_ID_2, ORG_ID, preexistingKeyIds, MEMBER_ORG_APP_ID])
    // A renamed key is still identified through its binding reason.
    await query(`UPDATE public.apikeys SET name = 'renamed admin key' WHERE user_id = $1::uuid AND name = 'default org admin' AND NOT (id = ANY($2::bigint[]))`, [USER_ID_2, preexistingKeyIds])
    expect(await keyHasPermission(USER_ID_2, 'renamed admin key', 'org.update_user_roles', ORG_ID)).toBe(true)

    await query(REMEDIATION_MIGRATION_SQL)

    expect(await keyBindings(USER_ID_2, ORG_ID)).toEqual([
      { name: 'renamed admin key', role_name: 'org_member', scope_type: 'org', org_id: ORG_ID, app_id: null },
    ])
    expect(await keyHasPermission(USER_ID_2, 'renamed admin key', 'org.update_user_roles', ORG_ID)).toBe(false)
    expect(await keyHasPermission(USER_ID_2, 'renamed admin key', 'org.read', ORG_ID)).toBe(true)
    // Bindings within the owner's rights are untouched.
    expect(await keyBindings(USER_ID_2, ORG_ID_2)).toContainEqual({ name: 'default app uploader', role_name: 'org_member', scope_type: 'org', org_id: ORG_ID_2, app_id: null })
  })

  it('remediation does not fail when the org now requires API-key expiration', async () => {
    // Test-owned org (rolled back with the transaction) so shared seed orgs are
    // never modified.
    const policyOrgId = randomUUID()
    await query('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [policyOrgId, USER_ID, 'Default key policy test', `default-key-policy-${policyOrgId}@example.com`])
    await query('DELETE FROM public.role_bindings WHERE org_id = $1::uuid AND principal_id = $2::uuid', [policyOrgId, USER_ID_2])
    await bindUser(USER_ID_2, 'org_member', policyOrgId)

    await provisionDefaultKeys(USER_ID_2)
    await query(`
      UPDATE public.role_bindings rb
      SET role_id = (SELECT id FROM public.roles WHERE name = 'org_admin')
      FROM public.apikeys
      WHERE rb.principal_type = public.rbac_principal_apikey()
        AND rb.principal_id = apikeys.rbac_id
        AND apikeys.user_id = $1::uuid
        AND apikeys.name = 'default org admin'
        AND NOT (apikeys.id = ANY($3::bigint[]))
        AND rb.org_id = $2::uuid
    `, [USER_ID_2, policyOrgId, preexistingKeyIds])
    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.update_user_roles', policyOrgId)).toBe(true)
    await query('UPDATE public.orgs SET require_apikey_expiration = true WHERE id = $1::uuid', [policyOrgId])

    await query(REMEDIATION_MIGRATION_SQL)

    expect(await keyHasPermission(USER_ID_2, 'default org admin', 'org.update_user_roles', policyOrgId)).toBe(false)
    expect((await keyBindings(USER_ID_2, policyOrgId)).filter(binding => binding.name === 'default org admin')).toEqual([])
  })
})
