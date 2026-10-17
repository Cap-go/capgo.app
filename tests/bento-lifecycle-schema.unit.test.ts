import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createPgliteEngine, Database } from 'tinbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILDER_STEP_IDS } from '../src/services/builderOnboardingChecklist.ts'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

const createdAt = '2026-10-17T15:00:00.000Z'
const assignedAt = '2026-10-17T15:01:00.000Z'
const migration = readFileSync('supabase/migrations/20261017144842_organization_lifecycle_v2.sql', 'utf8')
let db: Database

function treatment(branch = 'A') {
  return { intent: 'ota', abtests_enrolled: ['new_emails_v2'], abtests: { new_emails_v2: { branch, assigned_at: assignedAt } } }
}

function checklist(product: 'ota' | 'builder', platform: 'ios' | 'android' = 'ios', status = 'done') {
  const ids = product === 'ota' ? APP_ONBOARDING_OTA_V1_STEP_IDS : BUILDER_STEP_IDS[platform]
  const steps = Object.fromEntries(ids.map(id => [id, { status, at: assignedAt }]))
  return { setup: {
    todo_list_version: 4,
    ota_todo_list_version: '1',
    builder_todo_list_version: '1',
    selected_path: product,
    selected_builder_platform: platform,
    paths: [product],
    outcome: 'in_progress',
    steps: product === 'ota' ? { ota: steps } : { builder: { [platform]: steps } },
  } }
}

async function user(onboarding: unknown = {}, created = createdAt, invited = false) {
  const id = randomUUID()
  await db.query('INSERT INTO public.users(id, onboarding, created_at, created_via_invite) VALUES ($1, $2::jsonb, $3, $4)', [id, JSON.stringify(onboarding), created, invited])
  return id
}

async function org(creator: string, intent = 'both') {
  const id = randomUUID()
  await db.query('INSERT INTO public.orgs(id, created_by, onboarding) VALUES ($1, $2, $3::jsonb)', [id, creator, JSON.stringify({ intent })])
  return id
}

async function assign(id: string, onboarding: unknown = treatment()) {
  await db.query('UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1', [id, JSON.stringify(onboarding)])
}

async function journeys(orgId: string) {
  return (await db.query('SELECT * FROM public.bento_lifecycle_journeys WHERE org_id = $1 ORDER BY product', [orgId])).rows
}

beforeAll(async () => {
  db = await Database.create(await createPgliteEngine())
  // Representative parent tables retain real keys/FKs. The exact migration
  // supplies every lifecycle table, function, privilege, index and trigger.
  await db.exec(`
    CREATE TABLE public.users(id uuid PRIMARY KEY, created_at timestamptz NOT NULL, onboarding jsonb NOT NULL DEFAULT '{}',
      created_via_invite boolean NOT NULL DEFAULT false, email_preferences jsonb NOT NULL DEFAULT '{}', enable_notifications boolean NOT NULL DEFAULT true,
      opt_for_newsletters boolean NOT NULL DEFAULT true, email text);
    CREATE TABLE public.orgs(id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      onboarding jsonb NOT NULL DEFAULT '{}', email_preferences jsonb NOT NULL DEFAULT '{}', management_email text,
      customer_id text, has_usage_credits boolean NOT NULL DEFAULT false);
    CREATE INDEX finx_orgs_created_by ON public.orgs(created_by);
    CREATE INDEX idx_orgs_customer_id ON public.orgs(customer_id);
    CREATE TABLE public.apps(id uuid PRIMARY KEY, app_id text NOT NULL UNIQUE, owner_org uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL, onboarding jsonb NOT NULL DEFAULT '{}');
    CREATE INDEX finx_apps_owner_org ON public.apps(owner_org);
    CREATE TABLE public.bento_event_dispatches(flow_key text, recipient_key text, event_at timestamptz, details jsonb);
    CREATE TABLE public.stripe_info(customer_id text PRIMARY KEY, status text, trial_at timestamptz, subscription_id text);
    CREATE TABLE public.build_requests(id uuid PRIMARY KEY, app_id text NOT NULL, owner_org uuid NOT NULL,
      created_at timestamptz NOT NULL, status text NOT NULL, completed_at timestamptz, builder_job_id text,
      upload_session_key text NOT NULL, platform text NOT NULL);
    CREATE TABLE public.onboarding_demo_data(app_id text NOT NULL, seed_id uuid NOT NULL, relation_name text NOT NULL,
      row_key text NOT NULL, PRIMARY KEY(seed_id,relation_name,row_key), UNIQUE(app_id,relation_name,row_key));
  `)
  await db.exec(migration)
}, 30_000)

afterAll(async () => db?.close())

describe('organization lifecycle PostgreSQL triggers', () => {
  it('denies invited original creators with stale treatment and wakes stored journeys if signup provenance changes', async () => {
    const invited = await user(treatment(), createdAt, true)
    const invitedOrg = await org(invited)
    await assign(invited)
    expect(await journeys(invitedOrg)).toEqual([])
    const creator = await user(treatment())
    const orgId = await org(creator, 'ota')
    expect(await journeys(orgId)).toHaveLength(1)
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z',candidate='{"branch":"old"}'::jsonb WHERE org_id=$1`, [orgId])
    await db.query('UPDATE public.users SET created_via_invite=true WHERE id=$1', [creator])
    expect((await journeys(orgId))[0].candidate).toBeNull()
    expect(new Date((await journeys(orgId))[0].next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
    for (const provenance of [true, null]) {
      expect((await db.query('SELECT public.lifecycle_v2_user_eligible($1::jsonb,$2::timestamptz,$3::boolean) AS eligible', [JSON.stringify(treatment()), createdAt, provenance])).rows).toEqual([{ eligible: false }])
    }
  })

  it('enrolls default organizations when protected signup allocation arrives later', async () => {
    const creator = await user()
    const orgId = await org(creator)
    expect(await journeys(orgId)).toEqual([])
    await assign(creator)
    expect((await journeys(orgId)).map(row => row.product)).toEqual(['builder', 'ota'])
    await db.query(`UPDATE public.bento_lifecycle_journeys SET state = '{"consumed":["recovery-24h"]}'::jsonb, support_hold = true WHERE org_id = $1`, [orgId])
    await assign(creator)
    expect(await journeys(orgId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ product: 'ota', support_hold: true, state: { consumed: ['recovery-24h'] } }),
    ]))
  })

  it('honors deferred organization intent after signup assignment without backfilling untrusted organizations', async () => {
    const creator = await user(treatment())
    const orgId = await org(creator, 'unknown')
    expect(await journeys(orgId)).toEqual([])
    await db.query(`UPDATE public.orgs SET onboarding = '{"intent":"ota"}'::jsonb WHERE id = $1`, [orgId])
    expect((await journeys(orgId)).map(row => row.product)).toEqual(['ota'])
    const legacyCreator = await user()
    const legacyOrg = await org(legacyCreator)
    await db.query('DELETE FROM public.org_lifecycle_creators WHERE org_id = $1', [legacyOrg])
    await assign(legacyCreator)
    await db.query(`UPDATE public.orgs SET onboarding = '{"intent":"both"}'::jsonb WHERE id = $1`, [legacyOrg])
    expect(await journeys(legacyOrg)).toEqual([])
  })

  it.each([
    { label: 'pre-cutoff user', created: '2026-10-16T15:00:00.000Z', onboarding: treatment() },
    { label: 'control', created: createdAt, onboarding: treatment('B') },
    { label: 'missing enrollment', created: createdAt, onboarding: { abtests: treatment().abtests } },
    { label: 'invalid timestamp', created: createdAt, onboarding: { abtests_enrolled: ['new_emails_v2'], abtests: { new_emails_v2: { branch: 'A', assigned_at: 'yesterday' } } } },
    { label: 'allocation before account creation', created: '2026-10-18T00:00:00Z', onboarding: treatment() },
    ...['exploring', 'both', 'publish'].map(intent => ({ label: `${intent} stale treatment`, created: createdAt, onboarding: { ...treatment(), intent } })),
    { label: 'builder without prerequisite', created: createdAt, onboarding: { ...treatment(), intent: 'builder' } },
  ])('does not enroll $label', async ({ created, onboarding }) => {
    const creator = await user({}, created)
    const orgId = await org(creator)
    await assign(creator, onboarding)
    expect(await journeys(orgId)).toEqual([])
  })

  it('requires a valid Builder prerequisite and immediately wakes on a newly ineligible original creator intent', async () => {
    const creator = await user()
    const orgId = await org(creator, 'builder')
    await assign(creator, { ...treatment(), intent: 'builder', abtests: {
      ...treatment().abtests,
      builder_todo_list_v4: { branch: 'A', assigned_at: assignedAt },
    } })
    expect(await journeys(orgId)).toHaveLength(1)
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z',candidate='{"branch":"old"}'::jsonb WHERE org_id=$1`, [orgId])
    await assign(creator, { ...treatment(), intent: 'exploring' })
    expect((await journeys(orgId))[0].candidate).toBeNull()
    expect(new Date((await journeys(orgId))[0].next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
    const { rows } = await db.query('SELECT public.lifecycle_v2_user_eligible($1::jsonb,$2::timestamptz,false) AS eligible', [JSON.stringify({
      ...treatment(),
      intent: 'builder',
      abtests: { ...treatment().abtests, builder_todo_list_v4: { branch: 'A', assigned_at: 'invalid' } },
    }), createdAt])
    expect(rows).toEqual([{ eligible: false }])
  })

  it('retains the original creator through transfers and deletion without inheriting the new owner treatment', async () => {
    const creator = await user()
    const currentOwner = await user()
    const orgId = await org(creator)
    await db.query('UPDATE public.orgs SET created_by = $2 WHERE id = $1', [orgId, currentOwner])
    await assign(currentOwner)
    expect(await journeys(orgId)).toEqual([])
    await assign(creator)
    expect(await journeys(orgId)).toHaveLength(2)
    await db.query('DELETE FROM public.users WHERE id = $1', [creator])
    const { rows } = await db.query('SELECT original_creator_id FROM public.org_lifecycle_creators WHERE org_id = $1', [orgId])
    expect(rows).toEqual([{ original_creator_id: creator }])
    expect(await journeys(orgId)).toHaveLength(2)
    await expect(db.query('UPDATE public.org_lifecycle_creators SET original_creator_id = $2 WHERE org_id = $1', [orgId, currentOwner])).rejects.toMatchObject({ code: '55000' })
  })

  it('preserves readiness on deletion before reconciliation and never lends old observations to a recreated app ID', async () => {
    const creator = await user()
    const orgId = await org(creator, 'ota')
    const oldId = randomUUID()
    const appId = `com.example.lifecycle.${randomUUID().replaceAll('-', '')}`
    await db.query('INSERT INTO public.apps(id, app_id, owner_org, created_at, onboarding) VALUES ($1,$2,$3,$4,$5::jsonb)', [oldId, appId, orgId, createdAt, JSON.stringify(checklist('ota'))])
    await assign(creator)
    expect((await journeys(orgId))[0].state).toEqual({})
    await db.query(`UPDATE public.bento_lifecycle_journeys SET selected_app_incarnation = $2,
      state = '{"consumed":["recovery-24h","recovery-48h","last-resort"],"trialPurposes":["trial0"]}'::jsonb,
      support_hold = true WHERE org_id = $1`, [orgId, oldId])
    await db.query(`UPDATE public.bento_lifecycle_app_observations SET seen_facts = ARRAY['old-completion'],
      verified = '{"otaAppliedAt":"2026-10-17T15:01:00Z"}'::jsonb, healthy = true WHERE org_id = $1 AND app_incarnation = $2`, [orgId, oldId])
    await db.query('DELETE FROM public.apps WHERE id = $1', [oldId])
    const deletedJourney = (await journeys(orgId))[0]
    expect(deletedJourney.selected_app_incarnation).toBeNull()
    expect(deletedJourney.state).toMatchObject({ consumed: ['recovery-24h', 'recovery-48h', 'last-resort'], trialPurposes: ['trial0'], checklistCompleteAt: expect.any(String) })
    const nextId = randomUUID()
    await db.query('INSERT INTO public.apps(id, app_id, owner_org, created_at, onboarding) VALUES ($1,$2,$3,$4,$5::jsonb)', [nextId, appId, orgId, createdAt, JSON.stringify(checklist('ota', 'ios', 'pending'))])
    const recreated = (await journeys(orgId))[0]
    expect(recreated.state).toEqual(deletedJourney.state)
    expect(recreated.support_hold).toBe(true)
    expect(recreated.selected_app_incarnation).toBe(nextId)
    const observations = (await db.query('SELECT app_incarnation, seen_facts, verified, verified_at, healthy FROM public.bento_lifecycle_app_observations WHERE org_id = $1 AND product = $2 ORDER BY captured_at', [orgId, 'ota'])).rows
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ app_incarnation: oldId, seen_facts: ['old-completion'] }),
      { app_incarnation: nextId, seen_facts: [], verified: {}, verified_at: null, healthy: false },
    ]))
  })

  it('captures a fresh destination context on transfer while retaining the source observation history', async () => {
    const source = await org(await user(treatment()), 'ota')
    const destination = await org(await user(treatment()), 'ota')
    const incarnation = randomUUID()
    const appId = `com.example.transfer.${randomUUID().replaceAll('-', '')}`
    await db.query('INSERT INTO public.apps(id,app_id,owner_org,created_at,onboarding) VALUES($1,$2,$3,$4,$5::jsonb)', [incarnation, appId, source, createdAt, JSON.stringify(checklist('ota'))])
    await db.query(`UPDATE public.bento_lifecycle_app_observations SET captured_at='2026-10-16T15:00:00Z',
      seen_facts=ARRAY['source-progress'],verified='{"otaBundleAt":"2026-10-17T15:01:00Z"}'::jsonb,healthy=true
      WHERE org_id=$1 AND app_incarnation=$2`, [source, incarnation])
    await db.query('UPDATE public.apps SET owner_org=$2 WHERE id=$1', [incarnation, destination])
    const { rows } = await db.query(`SELECT org_id,captured_at,seen_facts,verified,healthy
      FROM public.bento_lifecycle_app_observations WHERE app_incarnation=$1 AND product='ota'`, [incarnation])
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.org_id === source)).toMatchObject({ seen_facts: ['source-progress'], healthy: true })
    const next = rows.find(row => row.org_id === destination)
    expect(next).toMatchObject({ seen_facts: [], verified: {}, healthy: false })
    expect(new Date(next.captured_at).getTime()).toBeGreaterThan(new Date('2026-10-16T15:00:00Z').getTime())
    expect((await journeys(source))[0].selected_app_incarnation).toBeNull()
    expect((await journeys(destination))[0].selected_app_incarnation).toBe(incarnation)
    const captured = next.captured_at
    await db.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE id=$1', [incarnation, JSON.stringify(checklist('ota', 'ios', 'pending'))])
    expect((await db.query(`SELECT captured_at FROM public.bento_lifecycle_app_observations
      WHERE org_id=$1 AND app_incarnation=$2 AND product='ota'`, [destination, incarnation])).rows[0].captured_at).toEqual(captured)
    await db.query('UPDATE public.apps SET owner_org=$2 WHERE id=$1', [incarnation, source])
    const returned = (await db.query(`SELECT captured_at,seen_facts,verified,healthy FROM public.bento_lifecycle_app_observations
      WHERE org_id=$1 AND app_incarnation=$2 AND product='ota'`, [source, incarnation])).rows[0]
    expect(returned).toMatchObject({ seen_facts: ['source-progress'], verified: {}, healthy: false })
    expect(new Date(returned.captured_at).getTime()).toBeGreaterThan(new Date('2026-10-16T15:00:00Z').getTime())
  })

  it.each([1, 2])('initially selects only an unambiguous supported context from %i pre-allocation apps', async (count) => {
    const creator = await user()
    const orgId = await org(creator, 'ota')
    const incarnations: string[] = []
    for (let index = 0; index < count; index++) {
      const incarnation = randomUUID()
      incarnations.push(incarnation)
      await db.query('INSERT INTO public.apps(id,app_id,owner_org,created_at,onboarding) VALUES($1,$2,$3,$4,$5::jsonb)', [
        incarnation,
        `com.example.bootstrap.${randomUUID().replaceAll('-', '')}`,
        orgId,
        createdAt,
        JSON.stringify(checklist('ota', 'ios', 'pending')),
      ])
    }
    await assign(creator)
    const next = (await journeys(orgId))[0]
    expect(next.selected_app_incarnation).toBe(count === 1 ? incarnations[0] : null)
    expect(next.state).toEqual({})
    expect(next.candidate).toBeNull()
  })

  it.each(['ota', 'builder'] as const)('checks independent canonical %s flags and ignores outcome-only labels', async (product) => {
    const complete = checklist(product)
    const incomplete = checklist(product)
    const steps = product === 'ota' ? incomplete.setup.steps.ota! : incomplete.setup.steps.builder!.ios!
    const first = product === 'ota' ? APP_ONBOARDING_OTA_V1_STEP_IDS[0] : BUILDER_STEP_IDS.ios[0]
    steps[first] = { status: 'pending', at: assignedAt }
    const cases = [
      { value: complete, expected: true },
      { value: checklist(product, 'ios', 'skipped'), expected: true },
      { value: incomplete, expected: false },
      { value: { setup: { ...complete.setup, outcome: 'completed', steps: {} } }, expected: false },
      { value: { setup: { ...complete.setup, todo_list_version: 99 } }, expected: false },
    ]
    for (const { value, expected } of cases) {
      const { rows } = await db.query('SELECT public.lifecycle_v2_checklist_complete($1::jsonb, $2, $3::timestamptz) AS complete', [JSON.stringify(value), product, createdAt])
      expect(rows[0].complete).toBe(expected)
    }
  })

  it('requires the selected Builder platform and rejects stale done flags from another incarnation', async () => {
    const value = checklist('builder', 'ios')
    value.setup.selected_builder_platform = 'android'
    expect((await db.query('SELECT public.lifecycle_v2_checklist_complete($1::jsonb,$2,$3::timestamptz) AS complete', [JSON.stringify(value), 'builder', createdAt])).rows[0].complete).toBe(false)
    const ota = checklist('ota')
    ota.setup.steps.ota!.login_cli_mcp.at = '2026-10-16T15:00:00Z'
    expect((await db.query('SELECT public.lifecycle_v2_checklist_complete($1::jsonb,$2,$3::timestamptz) AS complete', [JSON.stringify(ota), 'ota', createdAt])).rows[0].complete).toBe(false)
  })

  it('wakes only a current recipient’s orgs when preferences change, without replenishing purposes', async () => {
    const recipient = await user(treatment())
    const orgId = await org(recipient)
    const otherOrg = await org(await user(treatment()))
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z',
      state='{"consumed":["last-resort"]}'::jsonb,candidate='{"branch":"old"}'::jsonb WHERE org_id IN ($1,$2)`, [orgId, otherOrg])
    await db.query('UPDATE public.users SET enable_notifications=false WHERE id=$1', [recipient])
    expect((await journeys(orgId))[0]).toMatchObject({ candidate: null, state: { consumed: ['last-resort'] } })
    expect(new Date((await journeys(orgId))[0].next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
    expect(new Date((await journeys(otherOrg))[0].next_evaluation_at).getUTCFullYear()).toBe(2099)
    const revision = (await journeys(orgId))[0].revision
    await db.query('UPDATE public.users SET enable_notifications=false WHERE id=$1', [recipient])
    expect((await journeys(orgId))[0].revision).toBe(revision)
  })

  it('wakes and fences a parked journey on support hold changes without altering consumed history', async () => {
    const orgId = await org(await user(treatment()), 'ota')
    await db.query(`UPDATE public.bento_lifecycle_journeys SET support_hold=true,
      state='{"consumed":["last-resort"]}'::jsonb WHERE org_id=$1`, [orgId])
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z',candidate='{"branch":"old"}'::jsonb WHERE org_id=$1`, [orgId])
    const before = (await journeys(orgId))[0].revision
    await db.query('UPDATE public.bento_lifecycle_journeys SET support_hold=false WHERE org_id=$1', [orgId])
    const next = (await journeys(orgId))[0]
    expect(next.revision).not.toBe(before)
    expect(next.candidate).toBeNull()
    expect(next.state).toEqual({ consumed: ['last-resort'] })
    expect(new Date(next.next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
  })

  it('wakes a matching billing customer on a real trial extension and preserves consumed Trial phases', async () => {
    const orgId = await org(await user(treatment()))
    const customerId = `lifecycle-test-${randomUUID()}`
    await db.query('UPDATE public.orgs SET customer_id=$2 WHERE id=$1', [orgId, customerId])
    await db.query('INSERT INTO public.stripe_info(customer_id,status,trial_at) VALUES($1,$2,$3)', [customerId, 'trialing', assignedAt])
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z',
      state='{"trialPurposes":["trial7"]}'::jsonb,candidate='{"deadline":"old"}'::jsonb WHERE org_id=$1`, [orgId])
    await db.query('UPDATE public.stripe_info SET trial_at=$2 WHERE customer_id=$1', [customerId, '2026-11-17T15:01:00Z'])
    const next = (await journeys(orgId))[0]
    expect(next).toMatchObject({ candidate: null, state: { trialPurposes: ['trial7'] } })
    expect(new Date(next.next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
    const revision = next.revision
    await db.query('UPDATE public.stripe_info SET trial_at=$2 WHERE customer_id=$1', [customerId, '2026-11-17T15:01:00Z'])
    expect((await journeys(orgId))[0].revision).toBe(revision)
  })

  it('wakes selected current-incarnation real builds while ignoring demo, old and other-platform writes', async () => {
    const orgId = await org(await user(treatment()), 'builder')
    const appId = `com.example.build.${randomUUID().replaceAll('-', '')}`
    const incarnation = randomUUID()
    await db.query('INSERT INTO public.apps(id,app_id,owner_org,created_at,onboarding) VALUES($1,$2,$3,$4,$5::jsonb)', [incarnation, appId, orgId, createdAt, JSON.stringify(checklist('builder'))])
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z' WHERE org_id=$1`, [orgId])
    const before = (await journeys(orgId))[0].revision
    for (const [platform, created, session] of [['android', createdAt, 'real'], ['ios', '2026-10-16T15:00:00Z', 'real'], ['ios', createdAt, 'demo-session-fixture']]) {
      await db.query(`INSERT INTO public.build_requests(id,app_id,owner_org,created_at,status,platform,upload_session_key)
        VALUES($1,$2,$3,$4,'pending',$5,$6)`, [randomUUID(), appId, orgId, created, platform, session])
    }
    expect((await journeys(orgId))[0].revision).toBe(before)
    const seededDemoId = randomUUID()
    const independentSeedId = randomUUID()
    expect(independentSeedId).not.toBe(incarnation)
    await db.query(`INSERT INTO public.build_requests(id,app_id,owner_org,created_at,status,platform,upload_session_key)
      VALUES($1,$2,$3,$4,'pending','ios','unprefixed-seeded-session')`, [seededDemoId, appId, orgId, createdAt])
    await db.query(`INSERT INTO public.onboarding_demo_data(app_id,seed_id,relation_name,row_key)
      VALUES($1,$2,'build_requests',$3)`, [appId, independentSeedId, seededDemoId])
    const beforeSeededOutcome = (await journeys(orgId))[0].revision
    await db.query(`UPDATE public.build_requests SET status='succeeded',completed_at=$2 WHERE id=$1`, [seededDemoId, assignedAt])
    expect((await journeys(orgId))[0].revision).toBe(beforeSeededOutcome)
    const buildId = randomUUID()
    await db.query(`INSERT INTO public.build_requests(id,app_id,owner_org,created_at,status,platform,upload_session_key)
      VALUES($1,$2,$3,$4,'pending','ios','real-build-session')`, [buildId, appId, orgId, createdAt])
    expect((await journeys(orgId))[0].revision).not.toBe(before)
    await db.query(`UPDATE public.bento_lifecycle_journeys SET next_evaluation_at='2099-01-01T00:00:00Z' WHERE org_id=$1`, [orgId])
    await db.query(`UPDATE public.build_requests SET status='succeeded',completed_at=$2 WHERE id=$1`, [buildId, assignedAt])
    expect(new Date((await journeys(orgId))[0].next_evaluation_at).getUTCFullYear()).toBeLessThan(2099)
  })
})

it('does not wake or replace selected context for passive telemetry heartbeats', async () => {
  const orgId = await org(await user(treatment()), 'ota')
  const first = randomUUID()
  const second = randomUUID()
  for (const id of [first, second])
    await db.query('INSERT INTO public.apps(id,app_id,owner_org,created_at,onboarding) VALUES($1,$2,$3,$4,$5::jsonb)', [id, `com.example.heartbeat.${id}`, orgId, createdAt, JSON.stringify(checklist('ota', 'ios', 'pending'))])
  await db.query(`UPDATE public.bento_lifecycle_journeys SET selected_app_incarnation=$2,next_evaluation_at='2099-01-01',candidate='{}'::jsonb WHERE org_id=$1`, [orgId, first])
  const before = (await journeys(orgId))[0]
  await db.query(`UPDATE public.apps SET onboarding=onboarding || '{"features":{"ota":{"last_used_at":"2026-10-17T16:00:00Z"}}}'::jsonb WHERE id=$1`, [second])
  expect((await journeys(orgId))[0]).toEqual(before)
  await db.query(`UPDATE public.apps SET onboarding=pg_catalog.jsonb_set(onboarding,'{features,ota,succeeded_at}','"2026-10-17T16:01:00Z"') WHERE id=$1`, [second])
  const after = (await journeys(orgId))[0]
  expect(after.selected_app_incarnation).toBe(first)
  expect(Number(after.revision)).toBeGreaterThan(Number(before.revision))
})

describe('lifecycle private schema and bounded lookup indexes', () => {
  it.each(['anon', 'authenticated'])('denies %s table and helper access even if the caller knows identifiers', async (role) => {
    for (const table of ['org_lifecycle_creators', 'bento_lifecycle_journeys', 'bento_lifecycle_app_observations']) {
      const rights = (await db.query(`SELECT pg_catalog.has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS allowed`, [role, `public.${table}`])).rows
      expect(rights).toEqual([{ allowed: false }])
      await expect(db.withContext({ role, claims: {} }, query => query(`SELECT * FROM public.${table}`))).rejects.toMatchObject({ code: '42501' })
    }
    const functions = (await db.query(`SELECT p.proname, pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS allowed,
      p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'lifecycle_v2_%' OR p.proname LIKE 'wake_lifecycle_%' OR p.proname IN
        ('capture_lifecycle_org_creator','preserve_lifecycle_org_creator','enroll_lifecycle_org_products','enroll_lifecycle_creator_products','observe_lifecycle_app_context'))`, [role])).rows
    expect(functions).toHaveLength(13)
    expect(functions.every(row => !row.allowed && row.owner === 'postgres' && row.proconfig.includes('search_path=""'))).toBe(true)
    const policies = (await db.query(`SELECT c.relname, c.relrowsecurity, count(p.oid)::integer AS policies
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
      WHERE c.oid IN ('public.org_lifecycle_creators'::regclass,'public.bento_lifecycle_journeys'::regclass,'public.bento_lifecycle_app_observations'::regclass)
      GROUP BY c.relname,c.relrowsecurity`)).rows
    expect(policies).toHaveLength(3)
    expect(policies.every(row => row.relrowsecurity && row.policies > 0)).toBe(true)
  })

  it('keeps original-creator, due and per-person/org history lookups indexed', async () => {
    const indexes = (await db.query(`SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname IN
      ('org_lifecycle_original_creator','bento_lifecycle_due','bento_lifecycle_dispatch_org','bento_lifecycle_dispatch_person')`)).rows
    expect(indexes).toHaveLength(4)
    expect(indexes.find(row => row.indexname === 'org_lifecycle_original_creator').indexdef).toContain('(original_creator_id, org_id)')
    expect(indexes.find(row => row.indexname === 'bento_lifecycle_dispatch_person').indexdef).toContain('recipientId')
    expect(indexes.find(row => row.indexname === 'bento_lifecycle_dispatch_org').indexdef).toContain('orgId')
  })

  it('keeps creator enrollment indexed with 100,000 synthetic users, organizations and provenance rows', async () => {
    const seed = randomUUID()
    const cardinality = 100_000
    const startedAt = Date.now()
    // This is the internal trigger lookup. Public/RLS request variants cannot
    // call these helpers: the privilege tests above verify denied EXECUTE and
    // table access, rather than pretending a public query executes this plan.
    await db.exec('BEGIN;')
    try {
      await db.query(`INSERT INTO public.users(id,created_at,onboarding)
        SELECT pg_catalog.md5($1 || ':user:' || n)::uuid,$2::timestamptz,'{}'::jsonb
        FROM pg_catalog.generate_series(1,$3::integer) AS n`, [seed, createdAt, cardinality])
      // Actual migration capture/enrollment triggers run for every inserted org.
      await db.query(`INSERT INTO public.orgs(id,created_by,onboarding)
        SELECT pg_catalog.md5($1 || ':org:' || n)::uuid,
          pg_catalog.md5($1 || ':user:' || n)::uuid,'{"intent":"ota"}'::jsonb
        FROM pg_catalog.generate_series(1,$2::integer) AS n`, [seed, cardinality])
      const { rows: [target] } = await db.query('SELECT pg_catalog.md5($1 || $2)::uuid AS id', [seed, ':user:50000'])
      await assign(target.id)
      await db.exec('ANALYZE public.users; ANALYZE public.orgs; ANALYZE public.org_lifecycle_creators;')
      const { rows: [counts] } = await db.query(`SELECT
        (SELECT pg_catalog.count(*)::integer FROM public.users) AS users,
        (SELECT pg_catalog.count(*)::integer FROM public.orgs) AS orgs,
        (SELECT pg_catalog.count(*)::integer FROM public.org_lifecycle_creators) AS creators`)
      expect(counts.users).toBeGreaterThanOrEqual(cardinality)
      expect(counts.orgs).toBeGreaterThanOrEqual(cardinality)
      expect(counts.creators).toBeGreaterThanOrEqual(cardinality)
      const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT c.org_id,o.onboarding FROM public.org_lifecycle_creators c
        JOIN public.orgs o ON o.id=c.org_id
        JOIN public.users u ON u.id=c.original_creator_id
        WHERE c.original_creator_id=$1::uuid
          AND public.lifecycle_v2_user_eligible(u.onboarding,u.created_at,u.created_via_invite)`, [target.id])
      const analyzed = rows[0]['QUERY PLAN'][0]
      const plan = JSON.stringify(analyzed.Plan)
      expect(plan).toContain('org_lifecycle_original_creator')
      expect(plan).toContain('orgs_pkey')
      expect(plan).toContain('users_pkey')
      expect(plan).not.toContain('Seq Scan')
      expect(analyzed.Plan['Actual Rows']).toBe(1)
      console.info(`Lifecycle creator scale (PGlite PostgreSQL, normal planner): ${JSON.stringify({
        seededPerTable: cardinality,
        actualCardinality: counts,
        returnedRows: analyzed.Plan['Actual Rows'],
        planningMs: analyzed['Planning Time'],
        executionMs: analyzed['Execution Time'],
        sharedHitBlocks: analyzed.Plan['Shared Hit Blocks'],
        sharedReadBlocks: analyzed.Plan['Shared Read Blocks'],
        fixtureAndPlanMs: Date.now() - startedAt,
      })}`)
    }
    finally {
      await db.exec('ROLLBACK;')
    }
  }, 120_000)
})
