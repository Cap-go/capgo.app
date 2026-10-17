import type { EligibleUser, QueryClient, ReadOnlyContext } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import type { AppEvidence, Product } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import type { Candidate, LifecycleInput } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { claimLifecycleBudget } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/budget.ts'
import { evaluateLifecycle } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evaluate.ts'
import { buildAppEvidence, nextTask } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import { resolveLifecycle } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/index.ts'
import { buildLifecycleEvent, lifecycleBranch } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/payload.ts'
import { buildLifecycleAnalyticsQuery } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/refresh.ts'
import { LIFECYCLE_CONTRACT, lifecycleReady } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/rollout.ts'
import { loadLifecycleInput, originalCreatorHasTreatment, readAcceptedPurposes, resolveAppEvidence } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/source.ts'
import contract from '../docs/bento/lifecycle-v2-contract.json' with { type: 'json' }
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

vi.mock('../supabase/functions/_backend/utils/ab_tests.json', () => ({ default: { new_emails_v2: { audience: 'self_signup', enroll_new_users_after: '2026-10-17T00:00:00Z' } } }))

const CREATED = '2026-10-17T10:00:00.000Z'
const DONE = '2026-10-17T11:00:00.000Z'
const NOW = '2026-10-18T00:00:00.000Z'
const ORG = '22222222-2222-4222-8222-222222222222'
const RECIPIENT = '33333333-3333-4333-8333-333333333333'
const WEBAPP = 'https://console.capgo.app'
const READY = { BENTO_EVENT_DISPATCH_ENABLED: 'true', BENTO_LIFECYCLE_V2_SENDER_CONTRACT: LIFECYCLE_CONTRACT, BENTO_LIFECYCLE_V2_LEGACY_HANDOFF: LIFECYCLE_CONTRACT, WEBAPP_URL: WEBAPP }

function profile(intent = 'ota') {
  return { intent, abtests_enrolled: ['new_emails_v2'], abtests: { new_emails_v2: { branch: 'A', assigned_at: CREATED }, builder_todo_list_v4: { branch: 'A', assigned_at: CREATED } } }
}

function appRow(overrides: Record<string, unknown> = {}) {
  const steps = Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'pending' }]))
  return { app_id: 'com.example.lifecycle', id: '11111111-1111-4111-8111-111111111111', created_at: CREATED, name: 'Example app', need_onboarding: false, onboarding: { setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], selected_path: 'ota', steps: { ota: steps } } }, ...overrides }
}

function app(steps: Record<string, unknown> = {}): AppEvidence {
  const row = appRow()
  Object.assign(row.onboarding.setup.steps.ota, steps)
  return buildAppEvidence(row, 'ota')!
}

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    now: NOW,
    orgId: ORG,
    orgName: 'Example organization',
    product: 'ota',
    recipientId: RECIPIENT,
    email: 'lifecycle@example.com',
    creatorTreatment: true,
    consent: true,
    selected: true,
    shippingIntent: true,
    supportHold: false,
    paused: false,
    evidence: app(),
    sourceHealthy: true,
    state: { enrolledAt: CREATED, lastProgressAt: CREATED, appLessSince: null, checklistCompleteAt: null, firstValueAt: null, batch: null },
    accepted: [],
    trialDeadline: '2026-10-25T00:00:00.000Z',
    billingHealthy: true,
    paid: false,
    compatibleCredits: false,
    plan: { name: 'Example plan', monthlyPrice: 19, reason: 'Fits your current measured usage', includes: 'Updates and builds' },
    ...overrides,
  }
}

function candidate(branch = 'progress_digest'): Candidate {
  return { branch, purpose: branch.startsWith('trial') || branch.startsWith('today') ? 'trial:example' : 'summary:batch', context: 'matching-context', priority: 80, expiresAt: '2026-10-19T00:00:00.000Z' }
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    org_id: ORG,
    product: 'ota',
    org_name: 'Example organization',
    enrolled_at: CREATED,
    selected_app_incarnation: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    state: {},
    support_hold: false,
    org_onboarding: { intent: 'ota' },
    org_preferences: {},
    creator_onboarding: profile(),
    creator_created_at: CREATED,
    creator_created_via_invite: false,
    recipient_id: RECIPIENT,
    email: 'lifecycle@example.com',
    recipient_preferences: {},
    enable_notifications: true,
    opt_for_newsletters: true,
    authorized: true,
    app: appRow(),
    captured_at: CREATED,
    seen_facts: [],
    verified: {},
    verified_at: NOW,
    healthy: true,
    customer_id: 'customer-example',
    trial_at: '2026-10-25T00:00:00.000Z',
    status: 'created',
    subscription_id: null,
    has_usage_credits: false,
    build_time_exceeded: false,
    now_at: NOW,
    ...overrides,
  }
}

function reader(row = sourceRow(), acceptedRows: unknown[] = [], planRows: unknown[] = [{ name: 'Example plan', price_m: '19', mau: 10000, build_time_unit: 3600 }]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('/* lifecycle sibling priority */'))
      return []
    if (sql.includes('FROM public.bento_lifecycle_journeys j'))
      return [row]
    if (sql.includes('FROM public.bento_event_dispatches'))
      return acceptedRows
    if (sql.includes('JOIN public.plans p'))
      return planRows
    if (sql.includes('vault.decrypted_secrets'))
      return []
    throw new Error(`Unexpected read: ${sql}`)
  })
  return { ctx: { query } as unknown as ReadOnlyContext, query }
}

function user(overrides: Partial<EligibleUser> = {}): EligibleUser {
  return { flowKey: 'lifecycle:v2:ota', contextKey: ORG, recipientKey: `org:${ORG}`, email: 'lifecycle@example.com', tag: 'summary:batch', action: 'send', reason: 'progress_digest', metadata: { orgId: ORG, product: 'ota', recipientId: RECIPIENT, revision: 2, branch: 'progress_digest', context: 'matching-context' }, ...overrides }
}

describe('lifecycle cross-repository sender contract', () => {
  it.concurrent('has exactly 49 unique product branches, provider events and sender tags', () => {
    expect(contract.branches).toHaveLength(49)
    expect(new Set(contract.branches.map(branch => `${branch.product}:${branch.key}`)).size).toBe(49)
    expect(new Set(contract.branches.map(branch => branch.event)).size).toBe(49)
    expect(new Set(contract.branches.map(branch => branch.tag)).size).toBe(49)
    expect(() => lifecycleBranch('ota', 'funding_blocked')).toThrow('Unknown lifecycle sender branch')
  })

  it.concurrent.each(contract.branches)('supplies every required payload field for $product/$key', (branch) => {
    const current = input({ product: branch.product as Product })
    const result = buildLifecycleEvent(current, candidate(branch.key), 'stable-dispatch-id', WEBAPP)
    expect(result.event).toBe(branch.event)
    expect(result.email).toBe(current.email)
    for (const field of contract.required_string_fields)
      expect(typeof result.data[field], field).toBe('string')
    expect(result.data.dispatch_id).toBe('stable-dispatch-id')
    expect(result.data.unique).toEqual({ key: 'stable-dispatch-id' })
    expect(typeof result.data.checklist_complete).toBe('boolean')
    expect(typeof result.data.first_value_verified).toBe('boolean')
  })

  it.concurrent('keeps text plain for the sender to escape and strips subject header newlines', () => {
    const current = input({ orgName: 'Example <organization> & team', evidence: { ...app(), name: 'Example\r\nInjected: subject' } })
    const result = buildLifecycleEvent(current, candidate(), 'dispatch', WEBAPP)
    expect(result.data.org_name).toBe('Example <organization> & team')
    expect(result.data.email_subject).not.toMatch(/[\r\n]/)
    expect(result.data).not.toHaveProperty('api_key')
    expect(result.data).not.toHaveProperty('setup_prompt')
    expect(result.data).not.toHaveProperty('signing_credentials')
  })

  it.concurrent('changes Run my app to Test my update only when the current app actually connected', () => {
    const done = Object.fromEntries(['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'upload_bundle'].map(id => [id, { status: 'done', at: DONE }]))
    const disconnected = buildLifecycleEvent(input({ evidence: app(done) }), candidate('stall_24h'), 'dispatch', WEBAPP)
    expect(disconnected.data.cta_label).toBe('Run my app')
    const connected = buildLifecycleEvent(input({ evidence: app({ ...done, run_device: { status: 'done', at: DONE } }) }), candidate('help_48h'), 'dispatch', WEBAPP)
    expect(connected.data.cta_label).toBe('Test my update')
    expect(connected.data.next_action_explanation).toContain('download and install')
    expect(connected.data.completed_steps_summary).toContain('Connected your app')
  })

  it.concurrent('acknowledges current real achievements even when no progress batch is pending', () => {
    const current = input({ evidence: app({ add_channel: { status: 'done', at: DONE }, add_updater: { status: 'done', at: DONE } }) })
    const result = buildLifecycleEvent(current, candidate('stall_24h'), 'dispatch', WEBAPP)
    expect(current.state.batch).toBeNull()
    expect(result.data.completed_steps_summary).toContain('✅ Created the channel')
    expect(result.data.completed_steps_summary).toContain('✅ Installed Capacitor Updater')
    expect(result.data.progress_summary).toBe(result.data.completed_steps_summary)
  })

  it.concurrent('drops a stale batch from a deleted incarnation rather than personalizing the replacement with it', () => {
    const current = input({ evidence: app({ add_channel: { status: 'done', at: DONE } }) })
    current.state.batch = { key: 'old-batch', incarnation: 'deleted-incarnation', openedAt: DONE, lastAt: DONE, facts: [{ id: 'old-fact', at: DONE, step: 'upload_bundle', kind: 'task', acknowledgement: 'Uploaded the deleted app bundle' }] }
    const result = buildLifecycleEvent(current, candidate('stall_24h'), 'dispatch', WEBAPP)
    expect(result.data.progress_summary).toContain('Created the channel')
    expect(result.data.progress_summary).not.toContain('deleted app')
  })

  it.concurrent('retains historical purchase readiness while omitting unknown replacement task help', () => {
    const current = input({ sourceHealthy: false, evidence: { ...app(), healthy: false, tasks: { run_device: 'unknown' } } })
    current.state.checklistCompleteAt = CREATED
    const result = buildLifecycleEvent(current, candidate('trial3_ready'), 'dispatch', WEBAPP)
    expect(result.data.checklist_complete).toBe(true)
    expect(result.data.cta_label).toBe('Choose Example plan')
    expect(result.data.next_action_title).not.toBe('Run your app')
    expect(result.data.next_action_explanation).not.toContain('Run your app on a device')
    expect(result.data.completed_steps_summary).toBe('')
  })

  it.concurrent('coalesces simultaneous checklist completion and first real value into one success with a fitted purchase CTA', () => {
    const row = appRow()
    Object.assign(row.onboarding.setup.steps.ota, Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'done', at: DONE }])))
    const evidence = buildAppEvidence(row, 'ota', { otaAppliedAt: DONE, otaBundleId: 'real-bundle', demoApp: false })!
    const current = input({ evidence, trialDeadline: null })
    current.state = { ...current.state, lastProgressAt: DONE, checklistCompleteAt: DONE, firstValueAt: DONE, batch: { key: 'completion-and-value', incarnation: evidence.incarnation, openedAt: DONE, lastAt: DONE, facts: evidence.facts } }
    const selected = evaluateLifecycle(current)!
    expect(selected.branch).toBe('first_update_success')
    expect(selected.purpose).toBe('summary:completion-and-value')
    const result = buildLifecycleEvent(current, selected, 'dispatch', WEBAPP)
    expect(result.data.checklist_complete).toBe(true)
    expect(result.data.first_value_verified).toBe(true)
    expect(result.data.progress_summary).toContain('Applied an update on a device')
    expect(result.data.cta_label).toBe('Choose Example plan')
    expect(new URL(String(result.data.continue_url)).pathname).toBe('/settings/organization/plans')
  })

  it.concurrent.each([
    ['ota', 'paid', 'first_update_success', 'Open my bundles', 'bundles'],
    ['ota', 'credits', 'first_update_success', 'Open my bundles', 'bundles'],
    ['builder', 'paid', 'first_real_success', 'Open my builds', 'builds'],
    ['builder', 'credits', 'first_real_success', 'Open my builds', 'builds'],
  ] as const)('opens the next useful %s view after success with %s coverage', (product, coverage, branch, label, destination) => {
    const evidence: AppEvidence = {
      ...app(),
      product,
      platform: product === 'builder' ? 'ios' : null,
      tasks: Object.fromEntries((product === 'ota' ? APP_ONBOARDING_OTA_V1_STEP_IDS : ['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate', 'prepare_profile', 'successful_cloud_build']).map(id => [id, 'done'])),
      checklistComplete: true,
      firstValue: { id: 'verified-value', at: DONE, kind: 'value', step: product === 'ota' ? 'test_update' : 'successful_cloud_build', acknowledgement: 'Completed your first real result' },
    }
    const current = input({ product, evidence, paid: coverage === 'paid', compatibleCredits: coverage === 'credits' })
    const result = buildLifecycleEvent(current, candidate(branch), 'dispatch', WEBAPP)
    const link = new URL(String(result.data.continue_url))
    expect(result.data.cta_label).toBe(label)
    expect(link.pathname).toBe(`/app/com.example.lifecycle/${destination}`)
    expect(link.searchParams.get('oid')).toBe(ORG)
    expect(link.searchParams.get('source')).toBe('capgo_lifecycle')
  })

  it.concurrent.each(['', '   '])('uses the current app ID when its optional display name is blank (%j)', (name) => {
    const current = input({ evidence: { ...app(), name } })
    expect(buildLifecycleEvent(current, candidate(), 'dispatch', WEBAPP).data.app_name).toBe('com.example.lifecycle')
  })

  it.concurrent('makes the funding action the main CTA without promising an unsuitable paid plan', () => {
    const current = input({ product: 'builder', evidence: { ...app(), product: 'builder', platform: 'ios', fundingBlocked: true } })
    const result = buildLifecycleEvent(current, candidate('funding_blocked'), 'dispatch', WEBAPP)
    expect(result.data.cta_label).toBe(result.data.funding_cta_label)
    expect(result.data.cta_label).toBe('Review build allowance')
    expect(new URL(String(result.data.continue_url)).pathname).toBe('/settings/organization/credits')
    expect(result.data.funding_recommendation).not.toContain('Choose Example plan')
  })

  it.concurrent('preserves the exact payment subject and actual extended deadline without asserting automatic payment', () => {
    const current = input({ trialDeadline: '2026-11-05T12:00:00.000Z' })
    const result = buildLifecycleEvent(current, candidate('today_unfinished'), 'dispatch', WEBAPP)
    expect(result.data.email_subject).toBe('🚨 Capgo payment incoming !')
    expect(result.data.trial_setup_intro).toContain('2026-11-05')
    expect(result.data.trial_setup_intro).not.toMatch(/automatically|will charge|ends today/i)
  })

  it.concurrent('includes organization selection and lifecycle attribution on all actionable console links', () => {
    const result = buildLifecycleEvent(input(), candidate('checklist_complete_purchase'), 'dispatch', WEBAPP)
    for (const field of ['continue_url', 'ai_setup_url', 'org_preferences_url', 'pause_url', 'plan_url']) {
      const link = new URL(String(result.data[field]))
      expect(link.origin).toBe(WEBAPP)
      expect(link.searchParams.get('oid')).toBe(ORG)
      expect(link.searchParams.get('source')).toBe('capgo_lifecycle')
    }
    expect(new URL(String(result.data.continue_url)).pathname).toBe('/settings/organization/plans')
    expect(result.data.recommended_monthly_price_label).toBe('$19/month')
  })

  it.concurrent.each(['http://console.capgo.app', 'https://user:secret@console.capgo.app', 'https://console.capgo.app/unverified', 'https://console.capgo.app/?unexpected=1'])('rejects unsafe or ambiguous configured console roots: %s', (url) => {
    expect(() => buildLifecycleEvent(input(), candidate(), 'dispatch', url)).toThrow('Invalid lifecycle webapp URL')
  })
})

describe('creator enrollment and dispatch readiness', () => {
  it.concurrent('reads the original creator treatment with current intent, prerequisites, marker and signup cutoff', () => {
    expect(originalCreatorHasTreatment(profile(), CREATED, false)).toBe(true)
    expect(originalCreatorHasTreatment(profile('builder'), CREATED, false)).toBe(true)
    expect(originalCreatorHasTreatment(profile('both'), CREATED, false)).toBe(false)
    expect(originalCreatorHasTreatment(profile(), '2026-10-16T23:59:59Z', false)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile(), abtests_enrolled: [] }, CREATED, false)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile('builder'), abtests: { new_emails_v2: { branch: 'A', assigned_at: CREATED }, builder_todo_list_v4: { branch: 'B', assigned_at: CREATED } } }, CREATED, false)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile(), abtests: { new_emails_v2: { branch: 'B', assigned_at: CREATED } } }, CREATED, false)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile(), abtests: { new_emails_v2: { branch: 'A', assigned_at: 'yesterday' } } }, CREATED, false)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile(), abtests: { new_emails_v2: { branch: 'A', assigned_at: '2026-10-17T09:59:59Z' } } }, CREATED, false)).toBe(false)
  })

  it.concurrent.each([true, null, undefined, 'false'])('excludes invited or unproven original signup provenance %j despite a protected treatment', (createdViaInvite) => {
    expect(originalCreatorHasTreatment(profile(), CREATED, createdViaInvite)).toBe(false)
    expect(originalCreatorHasTreatment(profile('builder'), CREATED, createdViaInvite)).toBe(false)
    expect(originalCreatorHasTreatment({ ...profile(), created_via_invite: false }, CREATED, createdViaInvite)).toBe(false)
  })

  it('fails closed when the prerequisite engine configuration has not merged', async () => {
    vi.resetModules()
    vi.doMock('../supabase/functions/_backend/utils/ab_tests.json', () => ({ default: {} }))
    try {
      const unconfigured = await import('../supabase/functions/_backend/utils/lifecycle_v2_cohort.ts')
      expect(unconfigured.isLifecycleV2Creator(profile(), CREATED, false)).toBe(false)
    }
    finally {
      vi.doUnmock('../supabase/functions/_backend/utils/ab_tests.json')
    }
  })

  it.each([undefined, 'all', 'unknown'])('fails closed when the prerequisite engine audience is not self_signup: %j', async (audience) => {
    vi.resetModules()
    vi.doMock('../supabase/functions/_backend/utils/ab_tests.json', () => ({ default: { new_emails_v2: { audience, enroll_new_users_after: '2026-10-17T00:00:00Z' } } }))
    try {
      const unconfigured = await import('../supabase/functions/_backend/utils/lifecycle_v2_cohort.ts')
      expect(unconfigured.isLifecycleV2Creator(profile(), CREATED, false)).toBe(false)
    }
    finally {
      vi.doUnmock('../supabase/functions/_backend/utils/ab_tests.json')
    }
  })

  it.concurrent('requires the exact sender and legacy handoff acknowledgement before any dispatch', async () => {
    const { ctx } = reader()
    expect(await lifecycleReady(ctx, READY)).toBe(true)
    expect(await lifecycleReady(ctx, { ...READY, BENTO_LIFECYCLE_V2_SENDER_CONTRACT: 'older-contract' })).toBe(false)
    expect(await lifecycleReady(ctx, { ...READY, BENTO_LIFECYCLE_V2_LEGACY_HANDOFF: '' })).toBe(false)
    expect(await lifecycleReady(ctx, {})).toBe(false)
  })

  it.concurrent('skips unknown readiness without loading organization or recipient facts', async () => {
    const { ctx, query } = reader()
    expect(await resolveLifecycle(ctx, user(), 'ota', {})).toEqual({ action: 'skip', reason: 'lifecycle_sender_not_ready' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('vault.decrypted_secrets')
  })

  it.concurrent('revalidates original creator enrollment and the current recipient instead of trusting the saved selection', async () => {
    const changed = reader(sourceRow({ revision: 3 }))
    expect(await resolveLifecycle(changed.ctx, user(), 'ota', READY)).toEqual({ action: 'skip', reason: 'lifecycle_context_changed' })
    const replacement = reader(sourceRow({ recipient_id: '44444444-4444-4444-8444-444444444444' }))
    expect(await resolveLifecycle(replacement.ctx, user(), 'ota', READY)).toEqual({ action: 'skip', reason: 'lifecycle_context_changed' })
    const declined = reader(sourceRow({ creator_onboarding: profile('exploring') }))
    expect(await resolveLifecycle(declined.ctx, user(), 'ota', READY)).toEqual({ action: 'skip', reason: 'lifecycle_selection_stale' })
    const invitedOriginal = reader(sourceRow({ creator_created_via_invite: true }))
    expect(await resolveLifecycle(invitedOriginal.ctx, user(), 'ota', READY)).toEqual({ action: 'skip', reason: 'lifecycle_selection_stale' })
  })

  it.concurrent('builds a matching provider event only after re-reading current eligible evidence and exact candidate identity', async () => {
    const row = appRow()
    Object.assign(row.onboarding.setup.steps.ota, { add_channel: { status: 'done', at: DONE } })
    const evidence = buildAppEvidence(row, 'ota')!
    const source = sourceRow({ app: row, state: { lastProgressAt: DONE, batch: { key: 'current-batch', incarnation: row.id, openedAt: DONE, lastAt: DONE, facts: evidence.facts } } })
    const { ctx } = reader(source)
    const loaded = await loadLifecycleInput(ctx, ORG, 'ota')
    const selected = evaluateLifecycle(loaded!.input)!
    expect(selected.branch).toBe('progress_digest')
    const saved = user({ tag: selected.purpose, metadata: { ...user().metadata, ...selected } })
    const resolved = await resolveLifecycle(ctx, saved, 'ota', READY)
    expect(resolved.action).toBe('send')
    if (resolved.action !== 'send')
      throw new Error('Expected an eligible send')
    expect(resolved.buildEvent('provider-stable-id')).toMatchObject({ event: 'capgo:lifecycle:ota_v4:progress_digest', data: { dispatch_id: 'provider-stable-id', unique: { key: 'provider-stable-id' } } })
    expect(await resolveLifecycle(ctx, { ...saved, metadata: { ...saved.metadata, context: 'replaced-context' } }, 'ota', READY)).toEqual({ action: 'skip', reason: 'lifecycle_selection_stale' })
  })
})

describe('current source evidence and accepted purposes', () => {
  it.concurrent.each([true, null, undefined])('excludes original creators with persisted invited or unknown provenance %j without inferring from org membership', async (creatorCreatedViaInvite) => {
    const { ctx, query } = reader(sourceRow({ creator_created_via_invite: creatorCreatedViaInvite, authorized: true }))
    const loaded = await loadLifecycleInput(ctx, ORG, 'ota')
    expect(loaded?.input.creatorTreatment).toBe(false)
    expect(loaded?.input.consent).toBe(true)
    expect(query.mock.calls[0][0]).toContain('original.created_via_invite AS creator_created_via_invite')
  })

  it.concurrent('keeps an eligible original self-signup creator independent from the current recipient’s invite history', async () => {
    const { ctx } = reader(sourceRow({ creator_created_via_invite: false, recipient_created_via_invite: true }))
    const loaded = await loadLifecycleInput(ctx, ORG, 'ota')
    expect(loaded?.input.creatorTreatment).toBe(true)
  })

  it.concurrent.each([null, undefined])('delivers Builder platform guidance through current source, recovery and Trial adapters (%s)', async (platform) => {
    const setup: Record<string, unknown> = { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_path: 'builder', steps: { builder: {} } }
    if (platform === null)
      setup.selected_builder_platform = null
    const row = sourceRow({ product: 'builder', org_onboarding: { intent: 'builder' }, creator_onboarding: profile('builder'), app: appRow({ onboarding: { setup } }), now_at: '2026-10-18T10:00:00.000Z', verified_at: '2026-10-18T10:00:00.000Z', trial_at: '2026-11-01T10:00:00.000Z' })
    const loaded = await loadLifecycleInput(reader(row).ctx, ORG, 'builder')
    const current = loaded!.input
    expect(current.evidence).toMatchObject({ platform: null, healthy: true, facts: [], tasks: {}, checklistComplete: false, firstValue: null })
    const first = evaluateLifecycle(current)!
    expect(first.branch).toBe('stall_24h')
    const event = buildLifecycleEvent(current, first, 'platform-help', WEBAPP)
    expect(event.data).toMatchObject({ cta_label: 'Choose my platform', platform_label: '', completed_steps_summary: '', checklist_complete: false, first_value_verified: false })
    expect(new URL(String(event.data.continue_url)).pathname).toBe('/app/com.example.lifecycle/getting-started')
    const second = evaluateLifecycle({ ...current, now: '2026-10-19T10:00:00.000Z', accepted: [{ purpose: first.purpose, acceptedAt: current.now, context: first.context, product: 'builder' }] })!
    expect(second.branch).toBe('help_48h')
    expect(buildLifecycleEvent(current, second, 'platform-help-48h', WEBAPP).data.cta_label).toBe('Choose my platform')
    const trialInput = { ...current, now: '2026-10-29T10:00:00.000Z' }
    const trial = evaluateLifecycle(trialInput)!
    expect(trial.branch).toBe('trial3_unfinished')
    expect(buildLifecycleEvent(trialInput, trial, 'platform-trial', WEBAPP).data).toMatchObject({ cta_label: 'Choose my platform', platform_label: '', next_action_title: 'Choose your build platform' })
  })

  it.concurrent('keeps malformed Builder platform evidence out of recovery and specific task copy', async () => {
    const row = sourceRow({ product: 'builder', org_onboarding: { intent: 'builder' }, creator_onboarding: profile('builder'), app: appRow({ onboarding: { setup: { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_builder_platform: 'web' } } }), now_at: '2026-10-18T10:00:00.000Z', verified_at: '2026-10-18T10:00:00.000Z', trial_at: '2026-11-01T10:00:00.000Z' })
    const loaded = await loadLifecycleInput(reader(row).ctx, ORG, 'builder')
    expect(loaded?.input.evidence?.healthy).toBe(false)
    expect(evaluateLifecycle(loaded!.input)).toBeNull()
    const trialInput = { ...loaded!.input, now: '2026-10-29T10:00:00.000Z' }
    const trial = evaluateLifecycle(trialInput)!
    expect(buildLifecycleEvent(trialInput, trial, 'unknown-platform', WEBAPP).data.cta_label).not.toBe('Choose my platform')
  })

  it.concurrent('loads verified current device and finalized upload without manufacturing canonical checklist completion', async () => {
    const row = appRow()
    Object.assign(row.onboarding.setup.steps.ota, Object.fromEntries(['login_cli_mcp', 'add_channel', 'add_updater', 'add_code'].map(id => [id, { status: 'done', at: DONE }])))
    const factual = resolveAppEvidence(row, 'ota', { otaDeviceAt: DONE, otaBundleAt: DONE, otaUploadId: '23' })!
    expect(factual.tasks.run_device).toBe('done')
    expect(factual.tasks.upload_bundle).toBe('done')
    expect(factual.checklistComplete).toBe(false)
    expect(nextTask(factual)?.ctaLabel).toBe('Test my update')
    expect(row.onboarding.setup.steps.ota.run_device).toEqual({ status: 'pending' })
  })

  it.concurrent('keeps independently verified real value even after every canonical checklist flag is done', async () => {
    const row = appRow()
    Object.assign(row.onboarding.setup.steps.ota, Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'done', at: DONE }])))
    const { ctx } = reader(sourceRow({ app: row, verified: { otaAppliedAt: DONE, otaBundleId: 'bundle-real', demoApp: false } }))
    const loaded = await loadLifecycleInput(ctx, ORG, 'ota')
    expect(loaded?.input.evidence?.checklistComplete).toBe(true)
    expect(loaded?.input.evidence?.firstValue).toMatchObject({ kind: 'value', at: DONE })
    expect(loaded?.input.creatorTreatment).toBe(true)
  })

  it.concurrent('fails closed on stale telemetry or lost recipient membership and missing quoted plan', async () => {
    const stale = await loadLifecycleInput(reader(sourceRow({ verified_at: CREATED })).ctx, ORG, 'ota')
    expect(stale?.input.sourceHealthy).toBe(false)
    const departed = await loadLifecycleInput(reader(sourceRow({ authorized: false })).ctx, ORG, 'ota')
    expect(departed?.input.consent).toBe(false)
    const unquoted = await loadLifecycleInput(reader(sourceRow({ state: { checklistCompleteAt: CREATED }, trial_at: '2026-10-21T00:00:00Z' }), [], []).ctx, ORG, 'ota')
    expect(unquoted?.input.plan).toBeNull()
    expect(evaluateLifecycle(unquoted!.input)).toBeNull()
  })

  it.concurrent('only turns accepted deliveries into permanent success, resumed and purchase aliases', async () => {
    const rows = [
      { purpose: 'summary:success', accepted_at: DONE, context: 'original', product: 'ota', branch: 'first_update_success' },
      { purpose: 'summary:resume', accepted_at: DONE, context: 'original', product: 'ota', branch: 'resumed_progress_digest' },
      { purpose: 'summary:purchase', accepted_at: DONE, context: 'original', product: 'builder', branch: 'checklist_complete_purchase' },
    ]
    const { ctx } = reader(sourceRow(), rows)
    const purposes = await readAcceptedPurposes(ctx, ORG)
    expect(purposes.map(item => item.purpose)).toEqual(['summary:success', 'success:ota', 'summary:resume', 'resumed:ota', 'summary:purchase', 'offer:builder'])
    expect(purposes.every(item => item.acceptedAt === DONE)).toBe(true)
  })
})

describe('bounded claim-time collision checks', () => {
  function client(results: unknown[][]) {
    const query = vi.fn(async () => ({ rows: results.shift() ?? [], rowCount: 0, command: 'SELECT', fields: [], oid: 0 }))
    return { client: { query } as unknown as QueryClient, query }
  }

  it.concurrent('does not read the database for invalid claim identity or charge a stale selection', async () => {
    const invalid = client([])
    expect(await claimLifecycleBudget(invalid.client, user({ metadata: {} }))).toBe(false)
    expect(invalid.query).not.toHaveBeenCalled()
    const stale = client([[]])
    expect(await claimLifecycleBudget(stale.client, user())).toBe(false)
    expect(stale.query).toHaveBeenCalledTimes(1)
  })

  it.concurrent('passes Trial exemption separately from purchase collision checks and yields blocked candidates without consuming them', async () => {
    const trial = client([[{ exists: 1 }], [{ blocked: false }]])
    expect(await claimLifecycleBudget(trial.client, user({ tag: 'trial:today', metadata: { ...user().metadata, branch: 'today_ready' } }))).toBe(true)
    expect(trial.query).toHaveBeenCalledTimes(2)
    const trialArguments = trial.query.mock.calls[1] as unknown as [string, unknown[]]
    expect(trialArguments[1][2]).toBe(true)
    expect(trialArguments[1][7]).toBe(false)
    const blocked = client([[{ exists: 1 }], [{ blocked: true }], []])
    expect(await claimLifecycleBudget(blocked.client, user({ metadata: { ...user().metadata, branch: 'checklist_complete_purchase' } }))).toBe(false)
    expect(blocked.query).toHaveBeenCalledTimes(3)
    const blockedArguments = blocked.query.mock.calls[1] as unknown as [string, unknown[]]
    expect(blockedArguments[1][2]).toBe(false)
    expect(blockedArguments[1][7]).toBe(true)
  })
})

describe('bounded incarnation-aware analytics evidence', () => {
  it.concurrent('keeps a separate creation lower bound for every app rather than admitting another incarnation’s events', () => {
    const query = buildLifecycleAnalyticsQuery([{ appId: 'com.example.old', createdAt: '2026-10-01T00:00:00Z' }, { appId: 'com.example.new', createdAt: CREATED }], 'value', NOW)
    expect(query).toContain('index1 = \'com.example.old\' AND timestamp >= toDateTime(\'2026-10-01 00:00:00\')')
    expect(query).toContain('index1 = \'com.example.new\' AND timestamp >= toDateTime(\'2026-10-17 10:00:00\')')
    expect(query).toContain('blob2 = \'set\'')
    expect(query).toContain('blob3 NOT IN (\'\', \'builtin\', \'unknown\')')
    expect(query).toContain('LIMIT 2')
  })

  it.concurrent('escapes hostile identifier quotes and backslashes within a bounded string literal', () => {
    const query = buildLifecycleAnalyticsQuery([{ appId: 'com.example.\'\\quoted', createdAt: CREATED }], 'device', NOW)
    expect(query).toContain('index1 = \'com.example.\'\'\\\\quoted\'')
    expect(query).toContain('FROM device_info')
  })

  it.concurrent('rejects oversized UTF-8 queries and invalid batches before any provider request', () => {
    expect(() => buildLifecycleAnalyticsQuery([], 'value', NOW)).toThrow('Invalid lifecycle analytics batch')
    expect(() => buildLifecycleAnalyticsQuery(Array.from({ length: 21 }, () => ({ appId: 'example', createdAt: CREATED })), 'value', NOW)).toThrow('Invalid lifecycle analytics batch')
    expect(() => buildLifecycleAnalyticsQuery([{ appId: '🧩'.repeat(2200), createdAt: CREATED }], 'value', NOW)).toThrow('Lifecycle analytics query too large')
    expect(() => buildLifecycleAnalyticsQuery([{ appId: 'example', createdAt: 'invalid' }], 'value', NOW)).toThrow()
  })
})
