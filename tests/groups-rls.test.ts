import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_ID, USER_ID_2 } from './test-utils.ts'

const fixtureId = randomUUID()
const orgId = randomUUID()
const memberGroupName = `Group RLS Member ${fixtureId}`
const adminGroupName = `Group RLS Admin ${fixtureId}`

let pool: Pool
let memberGroupId: string
let adminOnlyGroupId: string

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
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(`
      INSERT INTO public.orgs (id, created_by, name, management_email)
      VALUES ($1::uuid, $2::uuid, $3, $4)
    `, [orgId, USER_ID, `Group RLS Org ${fixtureId}`, `group-rls-${fixtureId}@capgo.app`])

    await client.query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES ($1::uuid, $2::uuid, public.rbac_role_org_member(), false)
    `, [orgId, USER_ID_2])

    const memberGroupResult = await client.query(`
      INSERT INTO public.groups (org_id, name, description, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
      RETURNING id
    `, [orgId, memberGroupName, 'Member-only group for RLS regression', USER_ID])
    memberGroupId = memberGroupResult.rows[0].id

    await client.query(`
      INSERT INTO public.group_members (group_id, user_id, added_by)
      VALUES ($1::uuid, $2::uuid, $2::uuid)
    `, [memberGroupId, USER_ID])

    const adminGroupResult = await client.query(`
      INSERT INTO public.groups (org_id, name, description, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
      RETURNING id
    `, [orgId, adminGroupName, 'Admin visibility group with no admin membership', USER_ID])
    adminOnlyGroupId = adminGroupResult.rows[0].id

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
    await client.query('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
  }
  finally {
    client.release()
    await pool.end()
  }
})

describe('groups RLS', () => {
  it('denies org members from listing groups they do not belong to', async () => {
    const rows = await withAuthenticatedUser(USER_ID_2, async (client) => {
      const result = await client.query(`
        SELECT id, org_id, name, description, created_at
        FROM public.groups
        WHERE org_id = $1::uuid
        ORDER BY name ASC
      `, [orgId])
      return result.rows
    })

    expect(rows).toEqual([])
  })

  it('denies org members from reading group metadata by id', async () => {
    const rows = await withAuthenticatedUser(USER_ID_2, async (client) => {
      const result = await client.query(`
        SELECT id, org_id, name, description, created_at
        FROM public.groups
        WHERE id = $1::uuid
      `, [memberGroupId])
      return result.rows
    })

    expect(rows).toEqual([])
  })

  it('denies org members from reading group membership lists', async () => {
    const rows = await withAuthenticatedUser(USER_ID_2, async (client) => {
      const result = await client.query(`
        SELECT user_id
        FROM public.group_members
        WHERE group_id = $1::uuid
      `, [memberGroupId])
      return result.rows
    })

    expect(rows).toEqual([])
  })

  it('allows org admins to list groups in their org without group membership', async () => {
    const rows = await withAuthenticatedUser(USER_ID, async (client) => {
      const result = await client.query(`
        SELECT id
        FROM public.groups
        WHERE id = $1::uuid
      `, [adminOnlyGroupId])
      return result.rows
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(adminOnlyGroupId)
  })

  it('allows org admins to read group membership lists without group membership', async () => {
    const client = await pool.connect()
    try {
      await client.query(`
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `, [adminOnlyGroupId, USER_ID_2, USER_ID])

      const rows = await withAuthenticatedUser(USER_ID, async (queryClient) => {
        const result = await queryClient.query(`
          SELECT user_id
          FROM public.group_members
          WHERE group_id = $1::uuid
        `, [adminOnlyGroupId])
        return result.rows
      })

      expect(rows.some(row => row.user_id === USER_ID_2)).toBe(true)
      expect(rows.some(row => row.user_id === USER_ID)).toBe(false)
    }
    finally {
      try {
        await client.query(`
          DELETE FROM public.group_members
          WHERE group_id = $1::uuid AND user_id = $2::uuid
        `, [adminOnlyGroupId, USER_ID_2])
      }
      finally {
        client.release()
      }
    }
  })

  it('allows group members to read their group metadata and members after joining', async () => {
    const client = await pool.connect()
    try {
      await client.query(`
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `, [memberGroupId, USER_ID_2, USER_ID])

      const groupRows = await withAuthenticatedUser(USER_ID_2, async (queryClient) => {
        const result = await queryClient.query(`
          SELECT id
          FROM public.groups
          WHERE id = $1::uuid
        `, [memberGroupId])
        return result.rows
      })
      expect(groupRows).toHaveLength(1)
      expect(groupRows[0]?.id).toBe(memberGroupId)

      const memberRows = await withAuthenticatedUser(USER_ID_2, async (queryClient) => {
        const result = await queryClient.query(`
          SELECT user_id
          FROM public.group_members
          WHERE group_id = $1::uuid
        `, [memberGroupId])
        return result.rows
      })
      expect(memberRows.some(row => row.user_id === USER_ID_2)).toBe(true)
    }
    finally {
      try {
        await client.query(`
          DELETE FROM public.group_members
          WHERE group_id = $1::uuid AND user_id = $2::uuid
        `, [memberGroupId, USER_ID_2])
      }
      finally {
        client.release()
      }
    }
  })
})
