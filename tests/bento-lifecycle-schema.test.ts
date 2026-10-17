import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { cleanupPostgresClient, getPostgresClient, USER_PASSWORD_HASH } from './test-utils.ts'

const createdAt = '2026-10-17T15:00:00.000Z'
const assignedAt = '2026-10-17T15:01:00.000Z'
const assignment = {
  intent: 'ota',
  abtests_enrolled: ['new_emails_v2'],
  abtests: { new_emails_v2: { branch: 'A', assigned_at: assignedAt } },
}

afterAll(cleanupPostgresClient)

async function transaction(run: (client: PoolClient) => Promise<void>) {
  const client = await (await getPostgresClient()).connect()
  try {
    await client.query('BEGIN')
    await run(client)
  }
  finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function seedUser(client: PoolClient, onboarding: unknown = {}, invited = false) {
  const id = randomUUID()
  const email = `lifecycle-schema-${id}@example.com`
  await client.query(`INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_user_meta_data)
    VALUES ($1,$2,$3,$4,$4,$4,'{}'::jsonb)`, [id, email, USER_PASSWORD_HASH, createdAt])
  await client.query(`INSERT INTO public.users(id,email,created_at,onboarding,created_via_invite) VALUES ($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(id) DO UPDATE SET created_at = EXCLUDED.created_at, onboarding = EXCLUDED.onboarding,
      created_via_invite = EXCLUDED.created_via_invite`, [id, email, createdAt, JSON.stringify(onboarding), invited])
  return id
}

async function seedOrg(client: PoolClient, creator: string, intent = 'ota') {
  const id = randomUUID()
  await client.query(`INSERT INTO public.orgs(id,name,management_email,created_by,onboarding)
    VALUES ($1,'Lifecycle schema fixture','lifecycle-schema@example.com',$2,$3::jsonb)`, [id, creator, JSON.stringify({ intent })])
  return id
}

async function assign(client: PoolClient, userId: string) {
  await client.query('UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1', [userId, JSON.stringify(assignment)])
}

function completedChecklist() {
  return { setup: {
    todo_list_version: 4,
    ota_todo_list_version: '1',
    paths: ['ota'],
    selected_path: 'ota',
    steps: { ota: Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(step => [step, { status: 'done', at: assignedAt }])) },
  } }
}

describe('lifecycle schema on full PostgreSQL', () => {
  it.concurrent('excludes an invited original creator even with a stale treatment marker', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client, {}, true)
      const orgId = await seedOrg(client, creator, 'both')
      await assign(client, creator)
      expect((await client.query('SELECT product FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows).toEqual([])
      expect((await client.query(`SELECT public.lifecycle_v2_user_eligible(onboarding,created_at,created_via_invite) AS eligible
        FROM public.users WHERE id=$1`, [creator])).rows).toEqual([{ eligible: false }])
    })
  })

  it.concurrent('keeps prospective creator provenance immutable to users and restricts every lifecycle table', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client)
      const orgId = await seedOrg(client, creator)
      const { rows: policies } = await client.query(`SELECT c.relname,c.relrowsecurity,
        pg_catalog.has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon_allowed,
        pg_catalog.has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS user_allowed,
        EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS has_policy
        FROM pg_catalog.pg_class c WHERE c.oid IN
        ('public.org_lifecycle_creators'::regclass,'public.bento_lifecycle_journeys'::regclass,'public.bento_lifecycle_app_observations'::regclass)`)
      expect(policies).toHaveLength(3)
      expect(policies.every(row => row.relrowsecurity && row.has_policy && !row.anon_allowed && !row.user_allowed)).toBe(true)
      await client.query('SAVEPOINT user_write')
      await client.query('SET LOCAL ROLE authenticated')
      await expect(client.query('UPDATE public.org_lifecycle_creators SET original_creator_id = $2 WHERE org_id = $1', [orgId, randomUUID()])).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT user_write')
      const { rows } = await client.query('SELECT original_creator_id FROM public.org_lifecycle_creators WHERE org_id = $1', [orgId])
      expect(rows).toEqual([{ original_creator_id: creator }])
    })
  })

  it.concurrent('bootstraps the org created before A/B allocation and preserves operational holds and consumed state', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client)
      const orgId = await seedOrg(client, creator, 'both')
      expect((await client.query('SELECT * FROM public.bento_lifecycle_journeys WHERE org_id = $1', [orgId])).rows).toEqual([])
      await assign(client, creator)
      const { rows } = await client.query('SELECT product,support_hold,refresh_claim_token FROM public.bento_lifecycle_journeys WHERE org_id = $1 ORDER BY product', [orgId])
      expect(rows).toEqual([
        { product: 'builder', support_hold: false, refresh_claim_token: null },
        { product: 'ota', support_hold: false, refresh_claim_token: null },
      ])
      await client.query(`UPDATE public.bento_lifecycle_journeys SET state='{"consumed":["last-resort"]}'::jsonb,support_hold=true WHERE org_id=$1`, [orgId])
      await assign(client, creator)
      expect((await client.query('SELECT state,support_hold FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows).toEqual([
        { state: { consumed: ['last-resort'] }, support_hold: true },
        { state: { consumed: ['last-resort'] }, support_hold: true },
      ])
    })
  })

  it.concurrent('does not enroll an original control through its current owner and retains provenance after creator deletion', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client)
      const currentOwner = await seedUser(client)
      const orgId = await seedOrg(client, creator)
      // A transferred org must retain an active owner membership. Without it,
      // deleting the last member correctly deletes the org and its provenance.
      await client.query(`INSERT INTO public.org_users(user_id,org_id,rbac_role_name,is_invite)
        VALUES($1,$2,'org_super_admin',false)`, [currentOwner, orgId])
      await client.query(`INSERT INTO public.role_bindings
        (principal_type,principal_id,role_id,scope_type,org_id,granted_by,reason,is_direct)
        SELECT public.rbac_principal_user(),$1,roles.id,public.rbac_scope_org(),$2,$1,
          'Lifecycle transfer fixture successor',true FROM public.roles roles
        WHERE roles.name='org_super_admin' AND roles.scope_type=public.rbac_scope_org()
        ON CONFLICT DO NOTHING`, [currentOwner, orgId])
      expect((await client.query(`SELECT public.is_effective_active_org_super_admin_user($1,$2) AS active`, [orgId, currentOwner])).rows).toEqual([{ active: true }])
      await client.query('UPDATE public.orgs SET created_by=$2 WHERE id=$1', [orgId, currentOwner])
      await assign(client, currentOwner)
      await client.query('UPDATE public.orgs SET management_email=$2 WHERE id=$1', [orgId, 'other-owner@example.com'])
      expect((await client.query('SELECT * FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows).toEqual([])
      await assign(client, creator)
      expect((await client.query('SELECT product FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows).toEqual([{ product: 'ota' }])
      await client.query('DELETE FROM auth.users WHERE id=$1', [creator])
      expect((await client.query('SELECT original_creator_id FROM public.org_lifecycle_creators WHERE org_id=$1', [orgId])).rows).toEqual([{ original_creator_id: creator }])
      expect((await client.query('SELECT product FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows).toEqual([{ product: 'ota' }])
    })
  })

  it.concurrent('preserves completed readiness when deleted before worker reconciliation and isolates recreation by apps.id', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client)
      const orgId = await seedOrg(client, creator)
      const appId = `com.example.lifecycle.${randomUUID().replaceAll('-', '')}`
      const originalId = randomUUID()
      await client.query(`INSERT INTO public.apps(id,app_id,icon_url,user_id,owner_org,created_at) VALUES($1,$2,'',$3,$4,$5)`, [originalId, appId, creator, orgId, createdAt])
      // The production BEFORE INSERT trigger sets checklist defaults, so trusted
      // completion is persisted through the same later UPDATE as real progress.
      await client.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE id=$1', [originalId, JSON.stringify(completedChecklist())])
      await assign(client, creator)
      await client.query(`UPDATE public.bento_lifecycle_journeys SET selected_app_incarnation=$2,
        state='{"consumed":["recovery-24h","recovery-48h","last-resort"]}'::jsonb WHERE org_id=$1`, [orgId, originalId])
      await client.query(`UPDATE public.bento_lifecycle_app_observations SET seen_facts=ARRAY['original-outcome'],verified='{"value":"original"}'::jsonb WHERE org_id=$1 AND app_incarnation=$2`, [orgId, originalId])
      await client.query('DELETE FROM public.apps WHERE id=$1', [originalId])
      const { rows: deleted } = await client.query('SELECT state,selected_app_incarnation FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])
      expect(deleted[0]).toMatchObject({ selected_app_incarnation: null, state: {
        consumed: ['recovery-24h', 'recovery-48h', 'last-resort'],
        checklistCompleteAt: expect.any(String),
      } })
      const replacementId = randomUUID()
      await client.query(`INSERT INTO public.apps(id,app_id,icon_url,user_id,owner_org,created_at) VALUES($1,$2,'',$3,$4,$5)`, [replacementId, appId, creator, orgId, createdAt])
      const { rows: replacement } = await client.query('SELECT app_incarnation,seen_facts,verified,verified_at,healthy FROM public.bento_lifecycle_app_observations WHERE org_id=$1 AND product=$2 AND app_incarnation=$3', [orgId, 'ota', replacementId])
      expect(replacement).toEqual([{ app_incarnation: replacementId, seen_facts: [], verified: {}, verified_at: null, healthy: false }])
      expect((await client.query('SELECT state FROM public.bento_lifecycle_journeys WHERE org_id=$1', [orgId])).rows[0].state).toEqual(deleted[0].state)
      expect((await client.query('SELECT seen_facts FROM public.bento_lifecycle_app_observations WHERE org_id=$1 AND product=$2 AND app_incarnation=$3', [orgId, 'ota', originalId])).rows).toEqual([{ seen_facts: ['original-outcome'] }])
    })
  })

  it.concurrent('uses indexed creator and org lookups for late allocation without a broad organization scan', async () => {
    await transaction(async (client) => {
      const creator = await seedUser(client)
      const orgId = await seedOrg(client, creator)
      await client.query('SET LOCAL enable_seqscan=off')
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT c.org_id,o.onboarding FROM public.org_lifecycle_creators c
        JOIN public.orgs o ON o.id=c.org_id WHERE c.original_creator_id=$1`, [creator])
      const plan = JSON.stringify(rows[0]['QUERY PLAN'])
      expect(plan).toContain('org_lifecycle_original_creator')
      expect(plan).not.toContain('Seq Scan')
      const { rows: indexed } = await client.query('SELECT org_id FROM public.org_lifecycle_creators WHERE original_creator_id=$1 AND org_id=$2', [creator, orgId])
      expect(indexed).toEqual([{ org_id: orgId }])
    })
  })
})
