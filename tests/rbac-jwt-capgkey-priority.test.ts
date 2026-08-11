import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORG_ID, POSTGRES_URL, USER_ID } from './test-utils.ts'

const INVALID_CAPGKEY = '00000000-0000-0000-0000-000000000000'

let pool: Pool

async function withAuthenticatedUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' }),
    ])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    try {
      await client.query('ROLLBACK')
    }
    catch {
      // Ignore rollback failures for clearer root error handling.
    }
    throw error
  }
  finally {
    client.release()
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: POSTGRES_URL })
})

afterAll(async () => {
  await pool.end()
})

describe('rbac JWT priority over capgkey', () => {
  it('uses JWT user permissions when an invalid capgkey header is present', async () => {
    const allowed = await withAuthenticatedUser(USER_ID, async (client) => {
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
      `, [ORG_ID])

      return result.rows[0]?.allowed as boolean
    })

    expect(allowed).toBe(true)
  })

  it('allows org super admins to insert groups when capgkey header is invalid', async () => {
    const groupId = randomUUID()

    await withAuthenticatedUser(USER_ID, async (client) => {
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.headers', JSON.stringify({ capgkey: INVALID_CAPGKEY })],
      )

      const result = await client.query(`
        INSERT INTO public.groups (id, org_id, name, description, created_by)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
        RETURNING id
      `, [groupId, ORG_ID, `JWT priority group ${groupId}`, 'Regression test', USER_ID])

      expect(result.rows).toHaveLength(1)
    })

    const client = await pool.connect()
    try {
      await client.query('DELETE FROM public.groups WHERE id = $1::uuid', [groupId])
    }
    finally {
      client.release()
    }
  })
})
