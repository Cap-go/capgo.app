import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

/**
 * org_admin ("Admin" in the dashboard) must be able to delete channels and
 * bundles. Create-without-delete broke CI preview cleanup for Admin API keys.
 */
describe('org_admin channel and bundle delete permissions', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent('grants channel.delete and bundle.delete to org_admin', async () => {
    const { rows } = await pool.query(`
      SELECT p.key
      FROM public.role_permissions rp
      JOIN public.roles r ON r.id = rp.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE r.name = public.rbac_role_org_admin()
        AND p.key IN (
          public.rbac_perm_channel_delete(),
          public.rbac_perm_bundle_delete()
        )
      ORDER BY p.key
    `)

    expect(rows.map(row => row.key)).toEqual([
      'bundle.delete',
      'channel.delete',
    ])
  })

  it.concurrent('still withholds org.delete and app.delete from org_admin', async () => {
    const { rows } = await pool.query(`
      SELECT p.key
      FROM public.role_permissions rp
      JOIN public.roles r ON r.id = rp.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE r.name = public.rbac_role_org_admin()
        AND p.key IN (
          public.rbac_perm_org_delete(),
          public.rbac_perm_app_delete()
        )
    `)

    expect(rows).toEqual([])
  })
})
