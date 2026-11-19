import type { PoolClient } from 'pg'
import type { Database } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, POSTGRES_URL, USER_ID, USER_ID_2, USER_ID_NONMEMBER } from './test-utils'

type Policy = Database['public']['Functions']['get_app_cicd_encryption_policy']['Returns'][number]

const suffix = randomUUID()
const originalOrg = randomUUID()
const destinationOrg = randomUUID()
const apps = {
  uploader: { id: randomUUID(), appId: `com.cicd.policy.uploader.${suffix}` },
  reader: { id: randomUUID(), appId: `com.cicd.policy.reader.${suffix}` },
  transfer: { id: randomUUID(), appId: `com.cicd.policy.transfer.${suffix}` },
}
const pool = new Pool({ connectionString: POSTGRES_URL, max: 4 })

async function asCaller<T>({ userId, run, role = 'authenticated' }: {
  userId: string | null
  run: (client: PoolClient) => Promise<T>
  role?: 'anon' | 'authenticated'
}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, true), pg_catalog.set_config('request.jwt.claims', $2, true)`, [userId ?? '', JSON.stringify({ sub: userId, role })])
    await client.query(role === 'anon' ? 'SET LOCAL ROLE anon' : 'SET LOCAL ROLE authenticated')
    return await run(client)
  }
  finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function readPolicy(userId: string, appId: string) {
  return asCaller({ userId, run: client => client.query<Policy>('SELECT * FROM public.get_app_cicd_encryption_policy($1)', [appId]) })
}

beforeAll(async () => {
  for (const [orgId, enforced] of [[originalOrg, true], [destinationOrg, false]] as const) {
    await executeSQL('INSERT INTO public.orgs(id, created_by, name, management_email, enforce_encrypted_bundles) VALUES ($1, $2, $3, $4, $5)', [orgId, USER_ID, `CI/CD encryption policy ${orgId}`, `cicd-policy-${orgId}@example.com`, enforced])
    await executeSQL(`INSERT INTO public.org_users(org_id, user_id, rbac_role_name, is_invite) VALUES ($1, $2, public.rbac_role_org_super_admin(), false)`, [orgId, USER_ID])
    await executeSQL(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, role.id, public.rbac_scope_org(), $2::uuid, $1::uuid, 'CI/CD encryption policy test', true FROM public.roles role WHERE role.name = public.rbac_role_org_super_admin() AND role.scope_type = public.rbac_scope_org() ON CONFLICT DO NOTHING`, [USER_ID, orgId])
  }
  for (const [kind, app] of Object.entries(apps)) {
    await executeSQL(`INSERT INTO public.apps(id, app_id, owner_org, name, icon_url) VALUES ($1, $2, $3, 'CI/CD policy test', '')`, [app.id, app.appId, originalOrg])
    await executeSQL(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, role.id, public.rbac_scope_app(), $2::uuid, $3::uuid, $4::uuid, 'CI/CD encryption policy test', true FROM public.roles role WHERE role.name = $5 AND role.scope_type = public.rbac_scope_app()`, [USER_ID_2, originalOrg, app.id, USER_ID, kind === 'reader' ? 'app_reader' : 'app_uploader'])
  }
  // Preserve the app-scoped legacy membership shape without an organization binding.
  await executeSQL(`INSERT INTO public.org_users(org_id, user_id, app_id, rbac_role_name, is_invite) VALUES ($1, $2, $3, public.rbac_role_app_uploader(), false)`, [originalOrg, USER_ID_2, apps.uploader.appId])
})

afterAll(async () => {
  await pool.end()
  await executeSQL('DELETE FROM public.apps WHERE app_id = ANY($1::text[])', [Object.values(apps).map(app => app.appId)])
  await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[originalOrg, destinationOrg]])
})

describe('app-readable CI/CD encryption policy', () => {
  it.concurrent.each(['uploader', 'reader'] as const)('lets an app %s read the policy without organization read access', async (kind) => {
    await asCaller({
      userId: USER_ID_2,
      run: async (client) => {
        const organization = await client.query('SELECT id FROM public.orgs WHERE id = $1', [originalOrg])
        expect(organization.rows).toEqual([])
        const permission = await client.query<{ allowed: boolean }>('SELECT public.rbac_check_permission_request(public.rbac_perm_org_read(), $1, NULL, NULL) AS allowed', [originalOrg])
        expect(permission.rows[0]?.allowed).toBe(false)
        const result = await client.query<Policy>('SELECT * FROM public.get_app_cicd_encryption_policy($1)', [apps[kind].appId])
        expect(result.rows).toEqual([{ owner_org: originalOrg, enforce_encrypted_bundles: true }])
      },
    })
  })

  it.concurrent('rejects unauthorized and nonexistent apps identically', async () => {
    for (const appId of [apps.uploader.appId, `com.cicd.policy.missing.${suffix}`])
      await expect(readPolicy(USER_ID_NONMEMBER, appId)).rejects.toMatchObject({ code: '42501', message: 'NO_PERMISSION' })
  })

  it.concurrent('denies anonymous execution while preserving only the intended role grants', async () => {
    const grants = await executeSQL<{ role: string, allowed: boolean }>(`SELECT role, pg_catalog.has_function_privilege(role, 'public.get_app_cicd_encryption_policy(character varying)', 'EXECUTE') AS allowed FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role)`)
    expect(Object.fromEntries(grants.map(row => [row.role, row.allowed]))).toEqual({ anon: false, authenticated: true, service_role: true })
    await expect(asCaller({ userId: null, role: 'anon', run: client => client.query('SELECT * FROM public.get_app_cicd_encryption_policy($1)', [apps.uploader.appId]) })).rejects.toMatchObject({ code: '42501' })
  })

  it.concurrent('reads the new owner policy after transfer and rejects the previous app-scoped grant', async () => {
    expect((await readPolicy(USER_ID_2, apps.transfer.appId)).rows).toEqual([{ owner_org: originalOrg, enforce_encrypted_bundles: true }])
    await asCaller({
      userId: USER_ID,
      run: async (client) => {
        await client.query('SELECT public.transfer_app($1, $2)', [apps.transfer.appId, destinationOrg])
        const result = await client.query<Policy>('SELECT * FROM public.get_app_cicd_encryption_policy($1)', [apps.transfer.appId])
        expect(result.rows).toEqual([{ owner_org: destinationOrg, enforce_encrypted_bundles: false }])
        await client.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, true), pg_catalog.set_config('request.jwt.claims', $2, true)`, [USER_ID_2, JSON.stringify({ sub: USER_ID_2, role: 'authenticated' })])
        await expect(client.query('SELECT * FROM public.get_app_cicd_encryption_policy($1)', [apps.transfer.appId])).rejects.toMatchObject({ code: '42501', message: 'NO_PERMISSION' })
      },
    })
  })
})
