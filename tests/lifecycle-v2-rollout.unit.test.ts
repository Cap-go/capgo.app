import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isLegacyLifecycleEvent, isLifecycleV2Treatment, LIFECYCLE_V2_CONTRACT, shouldUseLifecycleV2, withoutLegacyTrialTriggers } from '../supabase/functions/_backend/utils/lifecycle_v2_rollout.ts'

const mocks = vi.hoisted(() => ({
  closeClient: vi.fn(),
  getPgClient: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: mocks.closeClient,
  getPgClient: mocks.getPgClient,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn() }))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  existInEnv: (c: { env: Record<string, string> }, key: string) => c.env[key] !== undefined,
  getEnv: (c: { env: Record<string, string> }, key: string) => c.env[key] ?? '',
}))

vi.mock('../supabase/functions/_backend/utils/ab_tests.json', () => ({ default: { new_emails_v2: { audience: 'self_signup', enroll_new_users_after: '2026-10-17T14:24:00.000Z' } } }))

const treatment = { branch: 'A', assigned_at: '2026-10-17T15:01:00.000Z' }
const profile = (assignment: unknown = treatment) => ({ created_at: '2026-10-17T15:00:00.000Z', created_via_invite: false, onboarding: { intent: 'ota', abtests_enrolled: ['new_emails_v2'], abtests: { new_emails_v2: assignment } } })
const ready = {
  BENTO_EVENT_DISPATCH_ENABLED: 'true',
  BENTO_LIFECYCLE_V2_SENDER_CONTRACT: LIFECYCLE_V2_CONTRACT,
  BENTO_LIFECYCLE_V2_LEGACY_HANDOFF: LIFECYCLE_V2_CONTRACT,
}
const orgId = '10000000-0000-4000-8000-000000000001'

function context(env: Record<string, string> = ready) {
  return { env, get: () => 'request-id' } as any
}

describe('lifecycle v2 legacy handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPgClient.mockResolvedValue({ query: mocks.query })
    mocks.query.mockResolvedValue({ rows: [profile()] })
    mocks.closeClient.mockResolvedValue(undefined)
  })

  it('uses only persisted immutable creator treatment and an existing organization journey', async () => {
    expect(await shouldUseLifecycleV2(context(), orgId)).toBe(true)
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM public.org_lifecycle_creators AS creators'), [orgId])
    const sql = mocks.query.mock.calls[0][0]
    expect(sql).toContain('users.id = creators.original_creator_id')
    expect(sql).toContain('users.created_via_invite')
    expect(sql).toContain('journeys.org_id = creators.org_id')
    expect(sql).toContain('LIMIT 1')
    expect(sql).not.toContain('orgs.created_by')
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it.each(Object.keys(ready))('retains legacy when the explicit %s override disables handoff', async (key) => {
    expect(await shouldUseLifecycleV2(context({ ...ready, [key]: 'false' }), orgId)).toBe(false)
    expect(mocks.getPgClient).not.toHaveBeenCalled()
  })

  it('requires every Vault setting and does not mistake absent readiness for enabled', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ name: 'BENTO_EVENT_DISPATCH_ENABLED', decrypted_secret: 'true' }] })
    expect(await shouldUseLifecycleV2(context({}), orgId)).toBe(false)
    expect(mocks.query).toHaveBeenCalledOnce()
  })

  it('reads missing settings from Vault while preserving deployment overrides', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [
      { name: 'BENTO_LIFECYCLE_V2_SENDER_CONTRACT', decrypted_secret: ` ${LIFECYCLE_V2_CONTRACT} ` },
      { name: 'BENTO_LIFECYCLE_V2_LEGACY_HANDOFF', decrypted_secret: LIFECYCLE_V2_CONTRACT },
    ] })
    expect(await shouldUseLifecycleV2(context({ BENTO_EVENT_DISPATCH_ENABLED: 'true' }), orgId)).toBe(true)
    expect(mocks.query.mock.calls[0][1]).toEqual([[
      'BENTO_LIFECYCLE_V2_SENDER_CONTRACT',
      'BENTO_LIFECYCLE_V2_LEGACY_HANDOFF',
    ]])
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it.each([
    undefined,
    { branch: 'B', assigned_at: treatment.assigned_at },
    { branch: 'A' },
    { branch: 'A', assigned_at: 'yesterday' },
  ])('retains legacy for unresolved or non-treatment creator assignment %j', async (assignment) => {
    mocks.query.mockResolvedValueOnce({ rows: [profile(assignment ?? null)] })
    expect(await shouldUseLifecycleV2(context(), orgId)).toBe(false)
  })

  it('retains legacy when the original creator was deleted or no immutable provenance/journey exists', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    expect(await shouldUseLifecycleV2(context(), orgId)).toBe(false)
  })

  it.each([true, null, undefined])('retains legacy for invited or unknown original signup provenance %j despite stale protected treatment', async (createdViaInvite) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...profile(), created_via_invite: createdViaInvite }] })
    expect(await shouldUseLifecycleV2(context(), orgId)).toBe(false)
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it('retains legacy when any readiness or creator read fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('database unavailable'))
    expect(await shouldUseLifecycleV2(context(), orgId)).toBe(false)
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it('does not open the database for an absent organization', async () => {
    expect(await shouldUseLifecycleV2(context(), '')).toBe(false)
    expect(mocks.getPgClient).not.toHaveBeenCalled()
  })
})

describe('legacy overlap boundaries', () => {
  it.each([
    'org:created',
    'app:created',
    'app:updated',
    'app:onboarding_ready',
    'app:ai_instructions_copied',
    'user:need_onboarding',
    'builder_onboarding_started',
    'builder_onboarding_completed',
  ])('owns the legacy setup event %s', (event) => {
    expect(isLegacyLifecycleEvent(event)).toBe(true)
  })

  it.each([
    'org:failed_payment',
    'org:charge_succeeded',
    'org:invoice_upcoming',
    'org:payment_action_required',
    'org:card_expiring',
    'user:plan_change',
    'org:invite',
    'bundle:created',
    'builder:cocoapods_deprecated',
    'user:weekly_stats',
    'device:channel_self_set_rejected',
  ])('preserves unrelated transactional or product events %s', (event) => {
    expect(isLegacyLifecycleEvent(event)).toBe(false)
  })

  it('skips Trial triggers without deleting person-scoped tags another organization needs', () => {
    expect(withoutLegacyTrialTriggers({
      segments: ['capgo', 'trial', 'trial7', 'trial1', 'trial0', 'trial-plan:Team', 'paying', 'plan:Solo'],
      deleteSegments: ['trial', 'trial7', 'trial1', 'trial0', 'trial-plan:Solo', 'canceled'],
    })).toEqual({
      segments: ['capgo', 'paying', 'plan:Solo'],
      deleteSegments: ['canceled'],
    })
  })

  it.concurrent('accepts only an explicit valid persisted A treatment', () => {
    expect(isLifecycleV2Treatment(treatment)).toBe(true)
    expect(isLifecycleV2Treatment({ branch: 'A', assigned_at: '2026-10-17' })).toBe(false)
    expect(isLifecycleV2Treatment({ branch: 'A', assigned_at: '2026-13-17T10:00:00Z' })).toBe(false)
    expect(isLifecycleV2Treatment(['A', treatment.assigned_at])).toBe(false)
  })
})
