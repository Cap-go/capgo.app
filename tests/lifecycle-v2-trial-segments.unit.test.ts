import { beforeEach, describe, expect, it, vi } from 'vitest'
import { customerToSegmentOrg } from '../supabase/functions/_backend/utils/supabase.ts'

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  state: { onboarded: true, paying: false, trialDays: 4, allowance: true },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc(name: string) {
      const values: Record<string, unknown> = {
        is_onboarded_org: mocks.state.onboarded,
        is_canceled_org: false,
        is_trial_org: mocks.state.trialDays,
        is_paying_org: mocks.state.paying,
        is_good_plan_v5_org: mocks.state.allowance,
      }
      return { single: () => ({ throwOnError: async () => ({ data: values[name], error: null }) }) }
    },
  }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: () => '',
  isStripeConfigured: () => true,
}))

vi.mock('../supabase/functions/_backend/utils/lifecycle_v2_rollout.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/lifecycle_v2_rollout.ts')>(),
  shouldUseLifecycleV2: mocks.ready,
}))

const c = { get: () => 'request-id' } as any
const plan = { name: 'Solo', price_m_id: 'price-monthly' } as any

describe('trial sender handoff at the billing producer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ready.mockResolvedValue(false)
    Object.assign(mocks.state, { onboarded: true, paying: false, trialDays: 4, allowance: true })
  })

  it.each([
    { trialDays: 4, allowance: true, expected: 'trial7' },
    { trialDays: 1, allowance: true, expected: 'trial1' },
    { trialDays: 0, allowance: false, expected: 'trial0' },
  ])('preserves the existing $expected segment for controls and unknown readiness', async ({ trialDays, allowance, expected }) => {
    Object.assign(mocks.state, { trialDays, allowance })
    const result = await customerToSegmentOrg(c, 'org-control', null, plan)
    expect(result.segments).toEqual(expect.arrayContaining(['trial', expected]))
    expect(mocks.ready).toHaveBeenCalledExactlyOnceWith(c, 'org-control')
  })

  it.each([
    { trialDays: 4, allowance: true },
    { trialDays: 1, allowance: true },
    { trialDays: 0, allowance: false },
  ])('does not add or delete person-scoped Trial triggers after ready handoff %j', async (state) => {
    Object.assign(mocks.state, state)
    mocks.ready.mockResolvedValue(true)
    const result = await customerToSegmentOrg(c, 'org-treatment', null, plan, ['Solo', 'Team'])
    for (const tag of [...result.segments, ...result.deleteSegments])
      expect(tag).not.toMatch(/^trial(?:$|[017]$|-plan:)/)
    expect(result.segments).toEqual(expect.arrayContaining(['capgo', 'onboarded']))
  })

  it('preserves paid plan and billing status tags for treatment organizations', async () => {
    Object.assign(mocks.state, { paying: true, trialDays: 0 })
    mocks.ready.mockResolvedValue(true)
    const result = await customerToSegmentOrg(c, 'org-treatment', 'price-monthly', plan, ['Solo'])
    expect(result.segments).toEqual(expect.arrayContaining(['paying', 'payingMonthly', 'plan:Solo']))
    expect(result.deleteSegments).toContain('canceled')
  })

  it('does not add a trial plan trigger when setup is still incomplete after handoff', async () => {
    Object.assign(mocks.state, { onboarded: false })
    mocks.ready.mockResolvedValue(true)
    const result = await customerToSegmentOrg(c, 'org-treatment', null, plan)
    expect(result.segments).not.toContain('trial-plan:Solo')
    expect(result.deleteSegments).toContain('onboarded')
  })
})
