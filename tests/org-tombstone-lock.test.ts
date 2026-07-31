import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

const creatorId = '6aa76066-55ef-4238-ade6-0b32334a4097'
const pool = new Pool({
  connectionString: POSTGRES_URL,
  max: 4,
  idleTimeoutMillis: 2000,
})

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function insertOrg(client: Pool | PoolClient, id: string, label: string) {
  await client.query(
    `
      INSERT INTO public.orgs (id, created_by, name, management_email)
      VALUES ($1::uuid, $2::uuid, $3, $4)
    `,
    [
      id,
      creatorId,
      `Tombstone lock ${label}`,
      `tombstone-lock-${id}@test.invalid`,
    ],
  )
}

async function rollbackIfOpen(client: PoolClient, open: boolean) {
  if (!open)
    return
  await client.query('ROLLBACK')
}

afterAll(async () => {
  await pool.end()
})

describe('organization tombstone lifecycle lock', () => {
  it('rejects a concurrent id reuse without blocking an unrelated organization', async () => {
    const deletedOrgId = randomUUID()
    const unrelatedOrgId = randomUUID()
    const deleting = await pool.connect()
    const recreating = await pool.connect()
    const unrelated = await pool.connect()
    let deletingTransactionOpen = false
    let recreationSettled = false
    let recreation: Promise<{ ok: boolean, error?: unknown }> | undefined
    let unrelatedInsert: Promise<{ ok: boolean, error?: unknown }> | undefined

    try {
      await insertOrg(pool, deletedOrgId, 'deleted')

      await deleting.query('BEGIN')
      deletingTransactionOpen = true
      await deleting.query('DELETE FROM public.orgs WHERE id = $1::uuid', [
        deletedOrgId,
      ])

      recreation = insertOrg(recreating, deletedOrgId, 'recreated').then(
        () => {
          recreationSettled = true
          return { ok: true }
        },
        (error: unknown) => {
          recreationSettled = true
          return { ok: false, error }
        },
      )

      await delay(100)
      expect(recreationSettled).toBe(false)

      await unrelated.query('SET lock_timeout = \'5s\'')
      unrelatedInsert = insertOrg(unrelated, unrelatedOrgId, 'unrelated').then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
      const unrelatedResult = await unrelatedInsert
      expect(unrelatedResult.ok).toBe(true)
      if (!unrelatedResult.ok)
        throw unrelatedResult.error

      await deleting.query('COMMIT')
      deletingTransactionOpen = false

      const recreationResult = await recreation
      expect(recreationResult.ok).toBe(false)
      if (recreationResult.ok) {
        throw new Error(
          'recreating a deleted organization id unexpectedly succeeded',
        )
      }
      expect(recreationResult.error).toMatchObject({
        code: 'P0001',
        message: 'org_id_reuse_forbidden',
      })

      const { rows } = await pool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM public.org_id_tombstones WHERE org_id = $1::uuid) AS exists',
        [deletedOrgId],
      )
      expect(rows[0]?.exists).toBe(true)
    }
    finally {
      await rollbackIfOpen(deleting, deletingTransactionOpen)
      await Promise.allSettled(
        [recreation, unrelatedInsert].filter(
          (promise): promise is Promise<{ ok: boolean, error?: unknown }> =>
            promise !== undefined,
        ),
      )
      deleting.release()
      recreating.release()
      unrelated.release()
      await pool.query('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [
        [deletedOrgId, unrelatedOrgId],
      ])
    }
  }, 15000)
})
