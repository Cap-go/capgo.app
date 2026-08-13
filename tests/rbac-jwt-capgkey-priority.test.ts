import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  POSTGRES_URL,
  USER_ID,
  USER_ID_2,
  withAnonymousCapgkey,
  withAuthenticatedUser,
} from './test-utils.ts'

const INVALID_CAPGKEY = '00000000-0000-0000-0000-000000000000'
const fixtureId = randomUUID()
const orgId = randomUUID()
const validApiKey = randomUUID()

let pool: Pool

beforeAll(async () => {
  pool = new Pool({ connectionString: POSTGRES_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Org insert triggers grant USER_ID the user-principal org_super_admin binding
    // (generate_org_user_on_org_create / generate_org_user_stripe_info_on_org_create).
    await client.query(`
      INSERT INTO public.orgs (id, created_by, name, management_email)
      VALUES ($1::uuid, $2::uuid, $3, $4)
    `, [orgId, USER_ID, `JWT capgkey priority ${fixtureId}`, `jwt-capgkey-${fixtureId}@capgo.app`])

    await client.query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES ($1::uuid, $2::uuid, public.rbac_role_org_member(), false)
    `, [orgId, USER_ID_2])

    const apiKeyResult = await client.query(`
      INSERT INTO public.apikeys (user_id, key, name)
      VALUES ($1::uuid, $2, $3)
      RETURNING rbac_id
    `, [USER_ID, validApiKey, `JWT capgkey priority ${fixtureId}`])
    const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id as string
    expect(apiKeyRbacId).toBeTruthy()

    // Separate apikey-principal binding: anon capgkey path + JWT-vs-key isolation cases.
    await client.query(`
      INSERT INTO public.role_bindings (
        principal_type, principal_id, role_id, scope_type, org_id, granted_by, is_direct
      )
      SELECT
        public.rbac_principal_apikey(),
        $1::uuid,
        roles.id,
        public.rbac_scope_org(),
        $2::uuid,
        $3::uuid,
        true
      FROM public.roles
      WHERE roles.name = public.rbac_role_org_super_admin()
        AND roles.scope_type = public.rbac_scope_org()
    `, [apiKeyRbacId, orgId, USER_ID])

    await client.query('COMMIT')
  }
  catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  finally {
    client.release()
  }
})

afterAll(async () => {
  const client = await pool.connect()
  try {
    await client.query('DELETE FROM public.apikeys WHERE key = $1', [validApiKey])
    await client.query('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
  }
  finally {
    client.release()
    await pool.end()
  }
})

describe('rbac JWT priority over capgkey', () => {
  it.concurrent('uses JWT user permissions when an invalid capgkey header is present', async () => {
    const allowed = await withAuthenticatedUser(pool, USER_ID, async (client) => {
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.headers', JSON.stringify({ capgkey: INVALID_CAPGKEY })],
      )

      const result = await client.query(`
        SELECT public.rbac_check_permission_request(
          public.rbac_perm_org_update_user_roles(),
          $1::uuid,
          NULL::character varying,
          NULL::bigint
        ) AS allowed
      `, [orgId])

      return result.rows[0]?.allowed as boolean
    })

    expect(allowed).toBe(true)
  })

  it.concurrent('denies JWT users without the permission even when a valid capgkey is present', async () => {
    const allowed = await withAuthenticatedUser(pool, USER_ID_2, async (client) => {
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.headers', JSON.stringify({ capgkey: validApiKey })],
      )

      const result = await client.query(`
        SELECT public.rbac_check_permission_request(
          public.rbac_perm_org_update_user_roles(),
          $1::uuid,
          NULL::character varying,
          NULL::bigint
        ) AS allowed
      `, [orgId])

      return result.rows[0]?.allowed as boolean
    })

    expect(allowed).toBe(false)
  })

  it.concurrent('allows org super admins to insert groups when capgkey header is invalid', async () => {
    const groupId = randomUUID()

    await withAuthenticatedUser(pool, USER_ID, async (client) => {
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.headers', JSON.stringify({ capgkey: INVALID_CAPGKEY })],
      )

      const result = await client.query(`
        INSERT INTO public.groups (id, org_id, name, description, created_by)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
      `, [groupId, orgId, `JWT priority group ${groupId}`, 'Regression test', USER_ID])

      expect(result.rowCount).toBe(1)
    })
  })

  it.concurrent('authorizes anonymous requests with a valid capgkey', async () => {
    const allowed = await withAnonymousCapgkey(pool, validApiKey, async (client) => {
      const result = await client.query(`
        SELECT public.rbac_check_permission_request(
          public.rbac_perm_org_update_user_roles(),
          $1::uuid,
          NULL::character varying,
          NULL::bigint
        ) AS allowed
      `, [orgId])

      return result.rows[0]?.allowed as boolean
    })

    expect(allowed).toBe(true)
  })

  it.concurrent('denies anonymous requests with an invalid capgkey', async () => {
    const allowed = await withAnonymousCapgkey(pool, INVALID_CAPGKEY, async (client) => {
      const result = await client.query(`
        SELECT public.rbac_check_permission_request(
          public.rbac_perm_org_update_user_roles(),
          $1::uuid,
          NULL::character varying,
          NULL::bigint
        ) AS allowed
      `, [orgId])

      return result.rows[0]?.allowed as boolean
    })

    expect(allowed).toBe(false)
  })

  it.concurrent('prefers JWT over header-sourced apikey in direct checks', async () => {
    const allowed = await withAuthenticatedUser(pool, USER_ID, async (client) => {
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.headers', JSON.stringify({ capgkey: INVALID_CAPGKEY })],
      )

      const result = await client.query(`
        SELECT
          public.rbac_check_permission_direct(
            public.rbac_perm_org_update_user_roles(),
            $1::uuid,
            $2::uuid,
            NULL::character varying,
            NULL::bigint,
            $3
          ) AS with_password_policy,
          public.rbac_check_permission_direct_no_password_policy(
            public.rbac_perm_org_update_user_roles(),
            $1::uuid,
            $2::uuid,
            NULL::character varying,
            NULL::bigint,
            $3
          ) AS without_password_policy
      `, [USER_ID, orgId, INVALID_CAPGKEY])

      return result.rows[0] as {
        with_password_policy: boolean
        without_password_policy: boolean
      }
    })

    expect(allowed.with_password_policy).toBe(true)
    expect(allowed.without_password_policy).toBe(true)
  })
})
