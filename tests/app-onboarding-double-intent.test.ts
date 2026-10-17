import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { getOrCreateUserABTests } from '../supabase/functions/_backend/utils/ab_tests.ts'
import { APP_ONBOARDING_OTA_V1_STEP_IDS, parseAppOnboarding } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { POSTGRES_URL, requestDirectDatabaseRoute } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 4 })
const experiment = 'todo_list_v4_double_intent'
const at = '2026-10-18T00:00:00.000Z'
const assignment = (branch = 'A') => ({ branch, assigned_at: at })

afterAll(async () => pool.end())

interface Scenario {
  intent?: string | null
  orgIntent?: string
  branch?: string | null
  invited?: boolean
  ownOrg?: boolean
  creator?: 'self' | 'other' | 'missing'
}

async function fixture(client: PoolClient, scenario: Scenario = {}) {
  const userId = randomUUID()
  const otherId = randomUUID()
  const orgId = randomUUID()
  const appId = `com.test.doubleintent.${randomUUID()}`
  for (const id of [userId, otherId]) {
    const email = `double-intent-${id}@example.com`
    await client.query('INSERT INTO auth.users(id, email) VALUES ($1, $2)', [id, email])
    await client.query('INSERT INTO public.users(id, email) VALUES ($1, $2)', [id, email])
  }
  const intent = scenario.intent === undefined ? 'both' : scenario.intent
  const branch = scenario.branch === undefined ? 'A' : scenario.branch
  const onboarding = { ...(intent === null ? {} : { intent }), abtests: branch ? { [experiment]: assignment(branch) } : {} }
  await client.query('UPDATE public.users SET created_via_invite = $2, onboarding = $3 WHERE id = $1', [userId, scenario.invited ?? false, onboarding])
  await client.query(`INSERT INTO public.orgs(id, created_by, name, management_email, onboarding)
    VALUES ($1, $2, 'Double intent test', 'double-intent@example.com', $3)`, [orgId, scenario.ownOrg === false ? otherId : userId, { intent: scenario.orgIntent ?? intent }])
  const creator = scenario.creator === 'missing' ? {} : { created_by_user_id: scenario.creator === 'other' ? otherId : userId }
  await client.query(`INSERT INTO public.apps(app_id, owner_org, name, icon_url, need_onboarding, onboarding)
    VALUES ($1, $2, 'Double intent test', '', true, $3)`, [appId, orgId, creator])
  const read = async () => (await client.query('SELECT onboarding, need_onboarding FROM public.apps WHERE app_id = $1', [appId])).rows[0]
  const reconcile = async () => (await client.query('SELECT public.reconcile_double_intent_app_onboarding($1) AS changed', [userId])).rows[0].changed
  return { userId, otherId, orgId, appId, onboarding, read, reconcile }
}

async function inTransaction(run: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await run(client)
  }
  finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function expectBoth(onboarding: any) {
  expect(onboarding.setup).toMatchObject({ todo_list_version: 4, ota_todo_list_version: '1', builder_todo_list_version: '1' })
  expect([...onboarding.setup.paths].sort()).toEqual(['builder', 'ota'])
  expect(Object.keys(onboarding.setup.steps.ota).sort()).toEqual([...APP_ONBOARDING_OTA_V1_STEP_IDS].sort())
  expect(Object.keys(onboarding.setup.steps.builder.ios)).toHaveLength(6)
  expect(Object.keys(onboarding.setup.steps.builder.android)).toHaveLength(4)
}

describe('persisted double intent checklist lifecycle', () => {
  it.concurrent.each(['both', 'exploring'])('initializes both paths for eligible A / %s, with the compatible OTA default', async intent => inTransaction(async (client) => {
    const f = await fixture(client, { intent })
    const { onboarding } = await f.read()
    expectBoth(onboarding)
    expect(onboarding.setup.selected_path).toBe('ota')
    expect(parseAppOnboarding(onboarding).ota_todo_list_version).toBe('1')
    expect(onboarding.setup.selected_builder_platform).toBeUndefined()
    expect(await f.reconcile()).toBe(0)
    expect((await f.read()).onboarding).toEqual(onboarding)
  }))

  it.concurrent.each([
    { branch: 'B' },
    { branch: null },
    { branch: 'C' },
    { invited: true },
    { intent: 'ota' },
    { intent: 'builder' },
    { intent: null },
    { ownOrg: false },
    { creator: 'other' },
    { creator: 'missing' },
    { orgIntent: 'ota' },
    { orgIntent: 'builder' },
  ] satisfies Scenario[])('keeps the normal OTA checklist for ineligible fixture %j', async scenario => inTransaction(async (client) => {
    const f = await fixture(client, scenario)
    const before = await f.read()
    expect(before.onboarding.setup.paths).toEqual(['ota'])
    expect(await f.reconcile()).toBe(0)
    expect(await f.read()).toEqual(before)
  }))

  it.concurrent.each(['ota', 'builder'])('keeps existing pure %s behavior', async intent => inTransaction(async (client) => {
    const f = await fixture(client, { intent, branch: null })
    await client.query('UPDATE public.users SET onboarding = $2 WHERE id = $1', [f.userId, { intent, abtests: { builder_todo_list_v4: assignment() } }])
    const appId = `${f.appId}.pure`
    await client.query(`INSERT INTO public.apps(app_id, owner_org, name, icon_url, onboarding)
      VALUES ($1, $2, 'Pure checklist', '', $3)`, [appId, f.orgId, { created_by_user_id: f.userId }])
    const { onboarding } = (await client.query('SELECT onboarding FROM public.apps WHERE app_id = $1', [appId])).rows[0]
    expect(onboarding.setup.paths).toEqual([intent])
    expect(onboarding.setup.selected_path).toBe(intent)
  }))

  it.concurrent.each(['ota', 'builder'])('additively upgrades existing %s progress and remains byte-for-byte idempotent', async path => inTransaction(async (client) => {
    const f = await fixture(client, { branch: null })
    const steps = path === 'ota'
      ? { ota: { add_code: { status: 'done', at, source: 'cli' }, upload_bundle: { status: 'skipped', at } } }
      : { builder: { ios: { prepare_certificate: { status: 'warning', at, annotation: 'keep' } }, android: { prepare_keystore: { status: 'done', at } } } }
    const setup = { todo_list_version: 4, [`${path}_todo_list_version`]: '1', paths: [path], selected_path: path, selected_builder_platform: 'android', source: 'mcp', outcome: 'in_progress', started_at: at, updated_at: at, steps }
    const original = { created_by_user_id: f.userId, setup, features: { ota: { stage: 'local_only', at } }, custom: 'keep' }
    await client.query('UPDATE public.apps SET onboarding = $2 WHERE app_id = $1', [f.appId, original])
    await client.query('UPDATE public.users SET onboarding = $2 WHERE id = $1', [f.userId, { ...f.onboarding, abtests: { [experiment]: assignment() } }])
    expect(await f.reconcile()).toBe(1)
    const upgraded = (await f.read()).onboarding
    expectBoth(upgraded)
    expect(upgraded).toMatchObject({ ...original, setup: { ...setup, paths: upgraded.setup.paths } })
    expect(upgraded.setup.selected_path).toBe(path)
    expect(await f.reconcile()).toBe(0)
    expect((await f.read()).onboarding).toEqual(upgraded)
  }))

  it.concurrent.each(['dismissed', 'completed', 'skipped', 'inactive'])('does not resurrect %s onboarding', async state => inTransaction(async (client) => {
    const f = await fixture(client, { branch: null })
    const original = (await f.read()).onboarding
    if (state === 'dismissed')
      original.getting_started_dismissed_at = at
    if (state === 'completed' || state === 'skipped')
      original.setup = { ...original.setup, outcome: state, completed_at: at }
    await client.query('UPDATE public.apps SET onboarding = $2, need_onboarding = $3 WHERE app_id = $1', [f.appId, original, state !== 'inactive'])
    const before = await f.read()
    await client.query('UPDATE public.users SET onboarding = $2 WHERE id = $1', [f.userId, { ...f.onboarding, abtests: { [experiment]: assignment() } }])
    expect(await f.reconcile()).toBe(0)
    expect(await f.read()).toEqual(before)
  }))

  it.concurrent('does not accept a client-forged treatment or invite provenance', async () => inTransaction(async (client) => {
    const f = await fixture(client, { branch: 'B', invited: true })
    await client.query('SELECT pg_catalog.set_config(\'request.jwt.claims\', $1, true)', [JSON.stringify({ sub: f.userId, role: 'authenticated' })])
    await client.query('SET LOCAL ROLE authenticated')
    await client.query('UPDATE public.users SET onboarding = $2, created_via_invite = false WHERE id = $1', [f.userId, { intent: 'both', abtests: { [experiment]: assignment() } }])
    await client.query('RESET ROLE')
    const saved = (await client.query('SELECT onboarding, created_via_invite FROM public.users WHERE id = $1', [f.userId])).rows[0]
    expect(saved.created_via_invite).toBe(true)
    expect(saved.onboarding.abtests[experiment].branch).toBe('B')
    expect(await f.reconcile()).toBe(0)
    expect((await f.read()).onboarding.setup.paths).toEqual(['ota'])
  }))

  it.concurrent('preserves legacy steps and timestamps when adding both paths', async () => inTransaction(async (client) => {
    const f = await fixture(client)
    const original = { created_by_user_id: f.userId, setup: { todo_list_version: 2, source: 'cli', updated_at: at, steps: { add_app: { status: 'done', at }, add_channel: { status: 'skipped', at }, legacy_custom: { status: 'done', at } } } }
    await client.query('UPDATE public.apps SET onboarding = $2 WHERE app_id = $1', [f.appId, original])
    expect(await f.reconcile()).toBe(1)
    const { onboarding } = await f.read()
    expectBoth(onboarding)
    expect(onboarding.setup.steps.ota.login_cli_mcp).toEqual({ status: 'done', at })
    expect(onboarding.setup.steps.ota.add_channel).toEqual({ status: 'skipped', at })
    expect(onboarding.setup.steps.legacy_custom).toEqual({ status: 'done', at })
    expect(onboarding.setup.updated_at).toBe(at)
    expect(await f.reconcile()).toBe(0)
  }))

  it.concurrent.each(['completed', 'skipped'])('does not resurrect root-level legacy outcome %s even with an empty setup', async outcome => inTransaction(async (client) => {
    const f = await fixture(client)
    for (const setup of [undefined, {}]) {
      const original = { created_by_user_id: f.userId, outcome, completed_at: at, ...(setup ? { setup } : {}) }
      await client.query('UPDATE public.apps SET onboarding = $2 WHERE app_id = $1', [f.appId, original])
      expect(await f.reconcile()).toBe(0)
      expect((await f.read()).onboarding).toEqual(original)
    }
  }))

  it.concurrent('carries root-level legacy progress and source metadata into nested setup', async () => inTransaction(async (client) => {
    const f = await fixture(client)
    const original = { created_by_user_id: f.userId, todo_list_version: 2, source: 'mcp', outcome: 'in_progress', started_at: at, updated_at: at, steps: { add_app: { status: 'done', at }, add_channel: { status: 'skipped', at } } }
    await client.query('UPDATE public.apps SET onboarding = $2 WHERE app_id = $1', [f.appId, original])
    expect(await f.reconcile()).toBe(1)
    const { onboarding } = await f.read()
    expectBoth(onboarding)
    expect(onboarding).toMatchObject(original)
    expect(onboarding.setup).toMatchObject({ source: 'mcp', outcome: 'in_progress', started_at: at, updated_at: at })
    expect(onboarding.setup.steps.ota.login_cli_mcp).toEqual({ status: 'done', at })
    expect(onboarding.setup.steps.ota.add_channel).toEqual({ status: 'skipped', at })
  }))

  it.concurrent('keeps reconciliation and its merge helper service-only with empty search paths', async () => inTransaction(async (client) => {
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['public.reconcile_double_intent_app_onboarding(uuid)', 'public.add_double_intent_onboarding_paths(jsonb)']) {
        expect((await client.query('SELECT pg_catalog.has_function_privilege($1, $2, \'EXECUTE\') AS allowed', [role, signature])).rows[0].allowed).toBe(false)
      }
    }
    const rows = (await client.query(`SELECT p.proname, p.proconfig, r.rolname FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid IN ('public.reconcile_double_intent_app_onboarding(uuid)'::regprocedure, 'public.add_double_intent_onboarding_paths(jsonb)'::regprocedure)`)).rows
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.rolname).toBe('postgres')
      expect(row.proconfig).toContain('search_path=""')
    }
  }))

  it('upgrades a pre-existing app through the real assignment endpoint service even when A was already persisted', async () => {
    const client = await pool.connect()
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      f = await fixture(client, { branch: null })
      const progress = (await f.read()).onboarding
      progress.setup.steps.ota.add_code = { status: 'done', at }
      await client.query('UPDATE public.apps SET onboarding = $2 WHERE app_id = $1', [f.appId, progress])
      await client.query('UPDATE public.users SET onboarding = $2 WHERE id = $1', [f.userId, { ...f.onboarding, abtests: { [experiment]: assignment() } }])
      const userId = f.userId
      const assignments = await requestDirectDatabaseRoute<Record<string, unknown>>((app) => {
        app.get('/', async c => c.json(await getOrCreateUserABTests(c as any, userId)))
      })
      expect(assignments[experiment]).toEqual(assignment())
      const { onboarding } = await f.read()
      expectBoth(onboarding)
      expect(onboarding.setup.steps.ota.add_code).toEqual({ status: 'done', at })
      // Exercise eight concurrent callers through a bounded pool, leaving room
      // for the unrelated read and other parallel test files.
      const parallel = new Pool({ connectionString: POSTGRES_URL, max: 3 })
      try {
        const results = await Promise.all([
          ...Array.from({ length: 8 }, () => parallel.query('SELECT public.reconcile_double_intent_app_onboarding($1) AS changed', [userId])),
          parallel.query('SELECT id FROM public.orgs LIMIT 1'),
        ])
        expect(results.slice(0, 8).map(result => result.rows[0].changed)).toEqual(Array.from({ length: 8 }).fill(0))
        expect(results[8].rows).toHaveLength(1)
        expect((await f.read()).onboarding).toEqual(onboarding)
      }
      finally {
        await parallel.end()
      }
    }
    finally {
      if (f) {
        await client.query('DELETE FROM public.apps WHERE owner_org = $1', [f.orgId])
        await client.query('DELETE FROM public.orgs WHERE id = $1', [f.orgId])
        await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [[f.userId, f.otherId]])
      }
      client.release()
    }
  })
})
