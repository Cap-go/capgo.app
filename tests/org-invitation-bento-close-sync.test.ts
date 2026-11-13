import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOrgOwnedByUser,
  POSTGRES_URL,
  setServiceRoleClaim,
  USER_ID,
  USER_ID_NONMEMBER,
} from './test-utils.ts'

async function bentoSyncCount(client: PoolClient, email: string) {
  const result = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM pgmq.q_send_email
      WHERE message -> 'payload' -> 'org_invitation_bento_sync' ->> 'email' = $1
        AND message ->> 'function_name' = 'send_email'
        AND message ->> 'function_type' = 'cloudflare'
    `,
    [email.trim().toLowerCase()],
  )
  return Number(result.rows[0]?.count ?? 0)
}

describe('org invitation Bento close sync', () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    try {
      await client.query('ROLLBACK')
    }
    finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('queues field sync when cancelling a sent tmp invite without bento_email', async () => {
    const orgId = await createOrgOwnedByUser(client.query.bind(client), USER_ID, 'Bento cancel sync org')
    const email = `bento-cancel-${randomUUID()}@example.com`
    await setServiceRoleClaim(client.query.bind(client))
    const invite = await client.query<{ id: number }>(
      `
        INSERT INTO public.tmp_users (
          email, org_id, rbac_role_name, first_name, last_name,
          invited_by_user_id, invite_magic_string
        ) VALUES ($1, $2::uuid, 'org_member', 'Cancel', 'Me', $3::uuid, $4)
        RETURNING id
      `,
      [email, orgId, USER_ID, `token-${randomUUID()}`],
    )
    const tmpUserId = invite.rows[0]!.id
    await client.query(
      `
        UPDATE public.org_invitation_email_requests
        SET sent_at = pg_catalog.now(), bento_email = NULL
        WHERE tmp_user_id = $1
      `,
      [tmpUserId],
    )
    await setServiceRoleClaim(client.query.bind(client))
    const before = await bentoSyncCount(client, email)
    await client.query(
      `UPDATE public.tmp_users SET cancelled_at = pg_catalog.now() WHERE id = $1`,
      [tmpUserId],
    )
    const after = await bentoSyncCount(client, email)
    expect(after - before).toBe(1)
  })

  it('accept_tmp_user_invitation does not queue an existing-user invite email request', async () => {
    const orgId = await createOrgOwnedByUser(client.query.bind(client), USER_ID, 'Bento accept tmp org')
    const email = `bento-accept-tmp-${randomUUID()}@example.com`
    const magicString = `magic-${randomUUID()}`
    await setServiceRoleClaim(client.query.bind(client))
    const invite = await client.query<{ id: number }>(
      `
        INSERT INTO public.tmp_users (
          email, org_id, rbac_role_name, first_name, last_name,
          invited_by_user_id, invite_magic_string
        ) VALUES ($1, $2::uuid, 'org_member', 'Accept', 'Tmp', $3::uuid, $4)
        RETURNING id
      `,
      [email, orgId, USER_ID, magicString],
    )
    const tmpUserId = invite.rows[0]!.id
    await client.query(
      `
        UPDATE public.org_invitation_email_requests
        SET sent_at = pg_catalog.now(), bento_email = NULL
        WHERE tmp_user_id = $1
      `,
      [tmpUserId],
    )
    await client.query('SAVEPOINT accept_tmp_invite')
    const accept = await client.query<{ status: string }>(
      `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
      [magicString, USER_ID_NONMEMBER],
    )
    expect(accept.rows[0]?.status).toBe('OK')

    const orgRequest = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM public.org_invitation_email_requests AS request
        JOIN public.org_users AS member
          ON member.id = request.org_user_id
        WHERE member.user_id = $1::uuid
          AND member.org_id = $2::uuid
      `,
      [USER_ID_NONMEMBER, orgId],
    )
    expect(orgRequest.rows[0]?.count).toBe('0')
    await client.query('ROLLBACK TO SAVEPOINT accept_tmp_invite')
  })
})
