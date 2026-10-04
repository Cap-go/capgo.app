import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, getSupabaseClient, POSTGRES_URL, USER_PASSWORD } from './test-utils.ts'

const orgId = randomUUID()
const appId = `com.test.sharedlocking.${randomUUID().replaceAll('-', '')}`
const email = `shared-locking-${randomUUID()}@example.com`
const secret = randomUUID()
let userId: string
let apikeyId: number
let apikeyRbacId: string
let channelId: number

beforeAll(async () => {
  const { data, error } = await getSupabaseClient().auth.admin.createUser({ email, password: USER_PASSWORD, email_confirm: true })
  if (error || !data.user)
    throw error ?? new Error('Failed to create shared locking fixture user')
  userId = data.user.id
  await executeSQL('INSERT INTO public.users(id, email) VALUES ($1, $2) ON CONFLICT(id) DO NOTHING', [userId, email])
  await executeSQL('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1, $2, $3, $4)', [orgId, userId, `Shared locking ${orgId}`, email])
  await executeSQL('INSERT INTO public.apps(app_id, icon_url, user_id, name, owner_org) VALUES ($1, $2, $3, $4, $5)', [appId, '', userId, 'Shared locking app', orgId])
  const [channel] = await executeSQL<{ id: number }>('INSERT INTO public.channels(name, app_id, owner_org, created_by) VALUES ($1, $2, $3, $4) RETURNING id', ['shared-locking', appId, orgId, userId])
  channelId = channel.id
  const [apikey] = await executeSQL<{ id: number, rbac_id: string }>(`
    INSERT INTO public.apikeys(user_id, name, owner_org_id, key_hash)
    VALUES ($1, $2, $3, encode(extensions.digest($4::text, 'sha256'), 'hex'))
    RETURNING id, rbac_id`, [userId, 'Shared locking key', orgId, randomUUID()])
  apikeyId = Number(apikey.id)
  apikeyRbacId = apikey.rbac_id
  await executeSQL(`
    INSERT INTO public.role_bindings(principal_type, principal_id, role_id, scope_type, org_id, granted_by)
    SELECT 'apikey', $1::uuid, id, 'org', $2::uuid, $3::uuid
    FROM public.roles WHERE name='org_admin' AND scope_type='org'`, [apikeyRbacId, orgId, userId])
})

afterAll(async () => {
  // Delete the owned org before its creator, so no shared-key transfer remains.
  await executeSQL('DELETE FROM public.orgs WHERE id=$1', [orgId])
  if (userId)
    await getSupabaseClient().auth.admin.deleteUser(userId)
})

describe('shared secret issuance serialization', () => {
  it('waits for issuance before applying a caller deny and revoking the new secret', async () => {
    const issuer = new Client({ connectionString: POSTGRES_URL })
    const mutation = new Client({ connectionString: POSTGRES_URL })
    await Promise.all([issuer.connect(), mutation.connect()])
    let denial: Promise<unknown> | undefined
    try {
      await issuer.query('BEGIN')
      await issuer.query('SELECT public.lock_rbac_orgs($1::uuid)', [orgId])
      await issuer.query('SELECT public.lock_rbac_apikey_principal($1::uuid)', [apikeyRbacId])
      await issuer.query('SELECT id FROM public.apikeys WHERE id=$1 FOR UPDATE', [apikeyId])
      const { rows: initial } = await issuer.query('SELECT shared_secret_user_id FROM public.apikeys WHERE id=$1', [apikeyId])
      expect(initial[0].shared_secret_user_id).toBeNull()

      const { rows: backend } = await mutation.query('SELECT pg_backend_pid() AS pid')
      denial = mutation.query(`
        INSERT INTO public.channel_permission_overrides(principal_type, principal_id, channel_id, permission_key, is_allowed)
        VALUES ('user', $1::uuid, $2, 'channel.read', false)`, [userId, channelId])
      await expect.poll(async () => {
        const [state] = await executeSQL<{ wait_event_type: string }>('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [backend[0].pid])
        return state?.wait_event_type
      }, { timeout: 2000 }).toBe('Lock')

      await issuer.query(`
        UPDATE public.apikeys
        SET key_hash=encode(extensions.digest($1::text, 'sha256'), 'hex'), shared_secret_user_id=$2
        WHERE id=$3`, [secret, userId, apikeyId])
      await issuer.query('COMMIT')
      await denial

      const [apikey] = await executeSQL<{ shared_secret_user_id: string | null }>('SELECT shared_secret_user_id FROM public.apikeys WHERE id=$1', [apikeyId])
      expect(apikey.shared_secret_user_id).toBeNull()
      const [lookup] = await executeSQL<{ count: number }>('SELECT count(*)::int AS count FROM public.find_apikey_by_value($1)', [secret])
      expect(lookup.count).toBe(0)
    }
    finally {
      await issuer.query('ROLLBACK')
      await denial?.catch(() => {})
      await Promise.all([issuer.end(), mutation.end()])
    }
  })

  it('takes the organization lock before the API-key principal lock during direct binding changes', async () => {
    const issuer = new Client({ connectionString: POSTGRES_URL })
    const mutation = new Client({ connectionString: POSTGRES_URL })
    await Promise.all([issuer.connect(), mutation.connect()])
    let update: Promise<unknown> | undefined
    try {
      await issuer.query('BEGIN')
      await issuer.query('SELECT public.lock_rbac_orgs($1::uuid)', [orgId])
      const { rows: backend } = await mutation.query('SELECT pg_backend_pid() AS pid')
      update = mutation.query(`
        UPDATE public.role_bindings SET reason='Shared locking order regression'
        WHERE principal_type='apikey' AND principal_id=$1::uuid`, [apikeyRbacId])
      await expect.poll(async () => {
        const [state] = await executeSQL<{ wait_event_type: string }>('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [backend[0].pid])
        return state?.wait_event_type
      }, { timeout: 2000 }).toBe('Lock')
      // This would wait on the binding mutation, creating an org/principal
      // deadlock, if its principal trigger ran before its org trigger.
      await issuer.query('SET LOCAL lock_timeout=\'1s\'')
      await issuer.query('SELECT public.lock_rbac_apikey_principal($1::uuid)', [apikeyRbacId])
      await issuer.query('COMMIT')
      await update
    }
    finally {
      await issuer.query('ROLLBACK')
      await update?.catch(() => {})
      await Promise.all([issuer.end(), mutation.end()])
    }
  })
})
