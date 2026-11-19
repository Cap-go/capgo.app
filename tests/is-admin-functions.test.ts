import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

describe('is_platform_admin SQL function', () => {
  let pool: Pool
  type QueryFn = <TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ rows: TRow[] }>

  const getAdminUserId = async (query: QueryFn): Promise<string | undefined> => {
    const adminRows = await query<{ id: string }>(`
      WITH admin_secret AS (
        SELECT value::jsonb AS value
        FROM private.settings
        WHERE name = 'admin_users'
        LIMIT 1
      )
      SELECT id
      FROM (
        SELECT jsonb_array_elements_text(value) AS id
        FROM admin_secret
        WHERE jsonb_typeof(value) = 'array'

        UNION ALL

        SELECT key AS id
        FROM admin_secret, jsonb_object_keys(value) AS key
        WHERE jsonb_typeof(value) = 'object'
      ) AS admin_ids
      LIMIT 1
    `)

    return adminRows.rows[0]?.id
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  const withTransaction = async <T>(
    callback: (query: QueryFn) => Promise<T>,
  ): Promise<T> => {
    let client: PoolClient | null = await pool.connect()
    try {
      await client.query('BEGIN')
      return await callback((text, values = []) => client!.query(text, values))
    }
    finally {
      try {
        await client?.query('ROLLBACK')
      }
      catch {
        // Ignore rollback failures to keep tests deterministic.
      }
      finally {
        client?.release()
        client = null
      }
    }
  }

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent('returns platform admin based on admin_users', async () => {
    const nonAdmin = randomUUID()

    await withTransaction(async (query) => {
      const legacyAdmin = await getAdminUserId(query)

      expect(legacyAdmin).toBeTruthy()

      const legacy = await query(
        'SELECT public.is_platform_admin($1::uuid) as is_platform_admin',
        [legacyAdmin],
      )

      const regular = await query(
        'SELECT public.is_platform_admin($1::uuid) as is_platform_admin',
        [nonAdmin],
      )

      expect(legacy.rows[0].is_platform_admin).toBe(true)
      expect(regular.rows[0].is_platform_admin).toBe(false)
    })
  })

  it.concurrent('keeps is_platform_admin tied to admin_users (no RBAC role check)', async () => {
    const rbacUserId = randomUUID()
    const normalUserId = randomUUID()
    const orgId = randomUUID()

    await withTransaction(async (query) => {
      const legacyAdmin = await getAdminUserId(query)
      const actorRows = await query<{ id: string }>(`
        SELECT id::text AS id
        FROM public.users
        ORDER BY created_at
        LIMIT 1
      `)
      const actorUserId = actorRows.rows[0]?.id

      expect(legacyAdmin).toBeTruthy()
      expect(actorUserId).toBeTruthy()

      await query(`
        INSERT INTO public.orgs (id, created_by, name, management_email)
        VALUES ($1::uuid, $2::uuid, 'is_platform_admin test org', $3::text);
      `, [orgId, actorUserId, `is-platform-admin-${orgId}@test.local`])

      await query(`
        INSERT INTO public.role_bindings (
          principal_type,
          principal_id,
          role_id,
          scope_type,
          org_id,
          granted_by
        ) VALUES (
          public.rbac_principal_user(),
          $1::uuid,
          (SELECT id FROM public.roles WHERE name = public.rbac_role_org_super_admin()),
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid
        );
      `, [rbacUserId, orgId, actorUserId])

      const rbacUserResults = await query(
        'SELECT public.is_platform_admin($1::uuid) as is_platform_admin',
        [rbacUserId],
      )

      const regularUserResults = await query(
        'SELECT public.is_platform_admin($1::uuid) as is_platform_admin',
        [normalUserId],
      )

      expect(rbacUserResults.rows[0].is_platform_admin).toBe(false)
      expect(regularUserResults.rows[0].is_platform_admin).toBe(false)
    })
  })
})
