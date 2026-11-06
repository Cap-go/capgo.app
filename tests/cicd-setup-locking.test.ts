import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getPostgresClient,
  POSTGRES_URL,
  USER_ID,
  USER_ID_2,
  USER_ID_NONMEMBER,
} from './test-utils.ts'

const suffix = randomUUID()
const ownerOrg = randomUUID()
const transferredOrg = randomUUID()
const lockedApp = `com.cicd.lock.${suffix}`
const transferredApp = `com.cicd.transfer.${suffix}`

async function beginCaller(client: PoolClient, userId: string, lockTimeout: string) {
  await client.query('BEGIN')
  await client.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, true), pg_catalog.set_config('request.jwt.claims', $2, true)`, [userId, JSON.stringify({ sub: userId, role: 'authenticated' })])
  await client.query('SET LOCAL ROLE authenticated')
  await client.query(`SELECT pg_catalog.set_config('lock_timeout', $1, true), pg_catalog.set_config('statement_timeout', '5s', true)`, [lockTimeout])
}

beforeAll(async () => {
  for (const [orgId, userId] of [[ownerOrg, USER_ID], [transferredOrg, USER_ID_2]])
    await executeSQL('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [orgId, userId, `CI/CD locking ${suffix}`, `cicd-lock-${orgId}@example.com`])
  for (const [orgId, userId] of [[ownerOrg, USER_ID], [ownerOrg, USER_ID_2], [transferredOrg, USER_ID_2]]) {
    await executeSQL(`INSERT INTO public.org_users(org_id, user_id, rbac_role_name, is_invite) VALUES ($1, $2, public.rbac_role_org_super_admin(), false) ON CONFLICT DO NOTHING`, [orgId, userId])
    await executeSQL(`INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct) SELECT public.rbac_principal_user(), $1::uuid, r.id, public.rbac_scope_org(), $2::uuid, $1::uuid, 'CI/CD locking test', true FROM public.roles r WHERE r.name = public.rbac_role_org_super_admin() AND r.scope_type = public.rbac_scope_org() ON CONFLICT DO NOTHING`, [userId, orgId])
  }
  for (const appId of [lockedApp, transferredApp])
    await executeSQL(`INSERT INTO public.apps(app_id, owner_org, name, icon_url) VALUES ($1, $2, 'CI/CD locking test', '')`, [appId, ownerOrg])
})

afterAll(async () => {
  await executeSQL('DELETE FROM public.apps WHERE app_id = ANY($1::text[])', [[lockedApp, transferredApp]])
  await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[ownerOrg, transferredOrg]])
})

describe('CI/CD setup row locking', () => {
  it.concurrent('rejects outsiders before a locked app row while authorized writers still serialize', async () => {
    await getPostgresClient()
    const pool = new Pool({ connectionString: POSTGRES_URL, max: 2 })
    const holder = await pool.connect()
    const caller = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT app_id FROM public.apps WHERE app_id = $1 FOR UPDATE', [lockedApp])

      await beginCaller(caller, USER_ID_NONMEMBER, '250ms')
      await expect(caller.query('SELECT public.record_app_cicd_setup($1, $2)', [lockedApp, 'marked_done'])).rejects.toMatchObject({ code: 'P0001', message: 'NO_PERMISSION' })
      await caller.query('ROLLBACK')

      await beginCaller(caller, USER_ID, '250ms')
      await expect(caller.query('SELECT public.record_app_cicd_setup($1, $2)', [lockedApp, 'marked_done'])).rejects.toMatchObject({ code: '55P03' })
      await caller.query('ROLLBACK')
      await holder.query('ROLLBACK')

      await beginCaller(caller, USER_ID, '250ms')
      const result = await caller.query<{ onboarding: { cicd: { marked_done_at: string } } }>('SELECT public.record_app_cicd_setup($1, $2) AS onboarding', [lockedApp, 'marked_done'])
      expect(result.rows[0]?.onboarding.cicd.marked_done_at).toEqual(expect.any(String))
    }
    finally {
      await holder.query('ROLLBACK')
      await caller.query('ROLLBACK')
      holder.release()
      caller.release()
      await pool.end()
    }
  })

  it.concurrent('rechecks the current owner after waiting for an app transfer', async () => {
    await getPostgresClient()
    const pool = new Pool({ connectionString: POSTGRES_URL, max: 2 })
    const holder = await pool.connect()
    const caller = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await beginCaller(holder, USER_ID_2, '5s')
      await holder.query('SELECT public.transfer_app($1, $2)', [transferredApp, transferredOrg])
      await beginCaller(caller, USER_ID, '5s')
      const pidResult = await caller.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')
      const pid = pidResult.rows[0]?.pid
      if (pid === undefined)
        throw new Error('Expected a caller backend PID')
      pending = caller.query('SELECT public.record_app_cicd_setup($1, $2)', [transferredApp, 'marked_done']).then(result => result, (error: unknown) => error)
      await expect.poll(async () => {
        const result = await holder.query<{ blocked: boolean }>('SELECT pg_catalog.pg_backend_pid() = ANY(pg_catalog.pg_blocking_pids($1)) AS blocked', [pid])
        return result.rows[0]?.blocked
      }, { timeout: 2000 }).toBe(true)
      await holder.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'P0001', message: 'NO_PERMISSION' })
      const state = await holder.query<{ onboarding: { cicd?: { marked_done_at?: string } } }>('SELECT onboarding FROM public.apps WHERE app_id = $1', [transferredApp])
      expect(state.rows[0]?.onboarding.cicd?.marked_done_at).toBeUndefined()
    }
    finally {
      await holder.query('ROLLBACK')
      await pending
      await caller.query('ROLLBACK')
      holder.release()
      caller.release()
      await pool.end()
    }
  })
})
