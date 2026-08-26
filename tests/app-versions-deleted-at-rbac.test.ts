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
const otherAppId = `${appId}.other`

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

    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
       VALUES ($1, '', $2::uuid, $3, $4::uuid)
       ON CONFLICT (app_id) DO NOTHING`,
      [otherAppId, USER_ID, otherAppId, orgId],
    )

    const [otherApp] = await executeSQL<{ id: string }>(
      'SELECT id::text FROM public.apps WHERE app_id = $1 LIMIT 1',
      [otherAppId],
    )
    if (!otherApp?.id)
      throw new Error(`Unable to resolve app ${otherAppId}`)

    const [otherAppAdminRole] = await executeSQL<{ id: string }>(
      `SELECT id::text FROM public.roles
       WHERE name = 'app_admin' AND scope_type = 'app'
       LIMIT 1`,
    )
    if (!otherAppAdminRole?.id)
      throw new Error('Unable to resolve app_admin role')

    await executeSQL(
      `INSERT INTO public.role_bindings (
         principal_type, principal_id, role_id, scope_type, org_id, app_id,
         granted_by, reason, is_direct
       ) VALUES (
         'apikey', $1::uuid, $2::uuid, 'app', $3::uuid, $4::uuid,
         $5::uuid, 'Scope regression: bundle.delete on destination app only', true
       )`,
      [uploader.rbac_id, otherAppAdminRole.id, orgId, otherApp.id, USER_ID],
    )

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
    const keyIds = [uploaderKeyId, deleterKeyId].filter((id): id is number => id != null)
    if (keyIds.length > 0)
      await executeSQL('DELETE FROM public.apikeys WHERE id = ANY($1::bigint[])', [keyIds])
    await executeSQL('SELECT public.reset_app_data($1)', [appId])
    await executeSQL('DELETE FROM public.deleted_apps WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [otherAppId])
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
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE/)

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
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE/)

    const row = await readVersion(versionId)
    expect(row?.deleted).toBe(false)
    expect(row?.deleted_at).toBeNull()
  })

  it.concurrent('keeps an upload-scoped API key from mixing deleted_at into a benign update', async () => {
    const versionId = await insertVersion(`upload-mixed-delete-${randomUUID()}`)
    const comment = `mixed-comment-${randomUUID()}`

    await expect(withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      await client.query(
        'UPDATE public.app_versions SET comment = $2, deleted_at = now() WHERE id = $1',
        [versionId, comment],
      )
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE/)

    const row = await readVersion(versionId)
    expect(row?.comment).toBeNull()
    expect(row?.deleted_at).toBeNull()
    expect(row?.deleted).toBe(false)
  })

  it.concurrent('keeps an upload-scoped API key from clearing deleted_at', async () => {
    const versionId = await insertVersion(`upload-clear-deleted-at-${randomUUID()}`)

    await executeSQL(
      'UPDATE public.app_versions SET deleted_at = now() WHERE id = $1',
      [versionId],
    )

    await expect(withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      await client.query(
        'UPDATE public.app_versions SET deleted_at = NULL WHERE id = $1',
        [versionId],
      )
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE/)

    const row = await readVersion(versionId)
    expect(row?.deleted_at).toBeTruthy()
  })

  it.concurrent('checks bundle.delete against the original app scope when app_id changes', async () => {
    const versionId = await insertVersion(`scope-move-delete-${randomUUID()}`)

    await expect(withAnonymousCapgkey(pool, uploaderKey, async (client) => {
      await client.query(
        'UPDATE public.app_versions SET app_id = $2, deleted_at = now() WHERE id = $1',
        [versionId, otherAppId],
      )
    })).rejects.toThrow(/PERMISSION_DENIED_BUNDLE_DELETE/)

    const rows = await executeSQL<{ app_id: string, deleted_at: string | null, deleted: boolean }>(
      'SELECT app_id, deleted_at, deleted FROM public.app_versions WHERE id = $1',
      [versionId],
    )
    expect(rows[0]?.app_id).toBe(appId)
    expect(rows[0]?.deleted_at).toBeNull()
    expect(rows[0]?.deleted).toBe(false)
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

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.jwt.claim.role', 'service_role'],
      )
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['request.jwt.claims', JSON.stringify({ role: 'service_role' })],
      )
      await client.query('SET LOCAL ROLE service_role')
      const result = await client.query<{ id: number, deleted_at: string | null }>(
        'UPDATE public.app_versions SET deleted_at = now() WHERE id = $1 RETURNING id, deleted_at',
        [versionId],
      )
      await client.query('COMMIT')

      expect(result.rowCount).toBe(1)
      expect(result.rows[0]?.deleted_at).toBeTruthy()
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    finally {
      client.release()
    }
  })
})
