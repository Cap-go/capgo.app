import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDirectApiKeyWithBindings,
  executeSQL,
  POSTGRES_URL,
  USER_ID,
  withAnonymousCapgkey,
} from './test-utils.ts'

const scopeId = randomUUID().replaceAll('-', '')
const orgId = randomUUID()
const stripeCustomerId = `cus_deleted_at_rbac_${scopeId}`
const appId = `com.deletedat.rbac.${scopeId}`

let pool: Pool
let uploaderKey: string
let deleterKey: string
let uploaderKeyId: number
let deleterKeyId: number

async function insertVersion(name: string): Promise<number> {
  const rows = await executeSQL<{ id: number }>(
    `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, deleted)
     VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct', false)
     RETURNING id`,
    [appId, name, orgId, USER_ID],
  )
  const id = rows[0]?.id
  if (id == null)
    throw new Error(`Failed to insert app_version ${name}`)
  return Number(id)
}

async function readVersion(id: number) {
  const rows = await executeSQL<{ deleted: boolean, deleted_at: string | null, comment: string | null }>(
    'SELECT deleted, deleted_at, comment FROM public.app_versions WHERE id = $1',
    [id],
  )
  return rows[0]
}

describe('app_versions deleted_at requires bundle.delete', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL })

    await executeSQL(
      'SELECT public.reset_and_seed_app_data($1, $2::uuid, NULL, NULL, $3, NULL)',
      [appId, orgId, stripeCustomerId],
    )

    const uploader = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `uploader-${appId}`,
      orgId,
      roleName: 'org_member',
      appId,
      appRoleName: 'app_uploader',
    })
    if (!uploader.key)
      throw new Error('Uploader API key was not created')
    uploaderKey = uploader.key
    uploaderKeyId = uploader.id

    const deleter = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `deleter-${appId}`,
      orgId,
      roleName: 'org_member',
      appId,
      appRoleName: 'app_admin',
    })
    if (!deleter.key)
      throw new Error('Deleter API key was not created')
    deleterKey = deleter.key
    deleterKeyId = deleter.id
  }, 60_000)

  afterAll(async () => {
    await executeSQL('DELETE FROM public.apikeys WHERE id = ANY($1::bigint[])', [[uploaderKeyId, deleterKeyId]])
    await executeSQL('SELECT public.reset_app_data($1)', [appId])
    await executeSQL('DELETE FROM public.deleted_apps WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [stripeCustomerId])
    await pool.end()
  }, 60_000)

  it.concurrent('keeps an upload-scoped API key from setting deleted_at', async () => {
    const versionId = await insertVersion(`upload-deleted-at-${randomUUID()}`)

    await expect(withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      await client.query(
        'UPDATE public.app_versions SET deleted_at = now() WHERE id = $1',
        [versionId],
      )
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE|row-level security/i)

    const row = await readVersion(versionId)
    expect(row?.deleted_at).toBeNull()
    expect(row?.deleted).toBe(false)
  })

  it.concurrent('keeps an upload-scoped API key from setting deleted=true', async () => {
    const versionId = await insertVersion(`upload-deleted-flag-${randomUUID()}`)

    await expect(withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      await client.query(
        'UPDATE public.app_versions SET deleted = true WHERE id = $1',
        [versionId],
      )
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE|row-level security/i)

    const row = await readVersion(versionId)
    expect(row?.deleted).toBe(false)
    expect(row?.deleted_at).toBeNull()
  })

  it.concurrent('still lets an upload-scoped API key update non-deletion fields', async () => {
    const versionId = await insertVersion(`upload-comment-${randomUUID()}`)
    const comment = `uploader-comment-${randomUUID()}`

    const result = await withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      return client.query(
        'UPDATE public.app_versions SET comment = $2 WHERE id = $1 RETURNING id, comment',
        [versionId, comment],
      )
    })

    expect(result.rowCount).toBe(1)
    expect(result.rows[0]?.comment).toBe(comment)

    const row = await readVersion(versionId)
    expect(row?.comment).toBe(comment)
    expect(row?.deleted_at).toBeNull()
  })

  it.concurrent('lets an API key with bundle.delete set deleted_at', async () => {
    const versionId = await insertVersion(`admin-deleted-at-${randomUUID()}`)

    const result = await withAnonymousCapgkey(pool, deleterKey, async (client) => {
      return client.query(
        'UPDATE public.app_versions SET deleted_at = now() WHERE id = $1 RETURNING id, deleted_at',
        [versionId],
      )
    })

    expect(result.rowCount).toBe(1)
    expect(result.rows[0]?.deleted_at).toBeTruthy()

    const row = await readVersion(versionId)
    expect(row?.deleted_at).toBeTruthy()
  })

  it.concurrent('lets service_role set deleted_at without a user-context grant', async () => {
    const versionId = await insertVersion(`service-deleted-at-${randomUUID()}`)

    const rows = await executeSQL<{ id: number, deleted_at: string | null }>(
      'UPDATE public.app_versions SET deleted_at = now() WHERE id = $1 RETURNING id, deleted_at',
      [versionId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.deleted_at).toBeTruthy()
  })
})
