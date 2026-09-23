import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOnboardingPaymentCohortData } from '../supabase/functions/_backend/utils/onboarding_payment_cohorts_data.ts'

const { getPgMock, closeMock, queryMock, releaseMock, connectMock } = vi.hoisted(() => ({ getPgMock: vi.fn(), closeMock: vi.fn(), queryMock: vi.fn(), releaseMock: vi.fn(), connectMock: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => {
  const { checkoutPgClient, releasePgClient } = await import('./helpers/pg-checkout-release-mocks.ts')
  return { getPgClient: getPgMock, closeClient: closeMock, checkoutPgClient, releasePgClient }
})
const c = {} as Context
const period = { start: '2026-06-01T00:00:00.000Z', cutoff: '2026-09-16T00:00:00.000Z' }
const user = { id: '00000000-0000-4000-a000-000000000001', signup_at: new Date('2026-09-01T00:00:00Z'), has_public_row: true, created_via_invite: false, total_rows: '1' }
const org = { id: '00000000-0000-4000-a000-000000000002', created_by: user.id, customer_id: 'cus_fake', total_rows: '1' }
const grant = { id: '00000000-0000-4000-a000-000000000003', org_id: org.id, granted_at: new Date('2026-09-02T00:00:00Z'), credits_total: '12.5', source: 'stripe_top_up', source_ref: { paymentIntentId: 'pi_fake' }, total_rows: '1' }

beforeEach(() => {
  releaseMock.mockReset()
  closeMock.mockReset()
  queryMock.mockReset().mockResolvedValueOnce({ rows: [user] }).mockResolvedValueOnce({ rows: [org] }).mockResolvedValueOnce({ rows: [grant] })
  connectMock.mockReset().mockResolvedValue({ query: queryMock, release: releaseMock })
  getPgMock.mockReset().mockReturnValue({ connect: connectMock })
})

describe('cohort-scoped primary database loader', () => {
  it('uses primary auth signup range, profile PK, creator scope and positive Stripe-only grants', async () => {
    const data = await loadOnboardingPaymentCohortData(c, period)
    expect(getPgMock).toHaveBeenCalledWith(c, false)
    expect(queryMock.mock.calls[0][0]).toContain('auth.users')
    expect(queryMock.mock.calls[0][0]).toContain('LEFT JOIN public.users')
    expect(queryMock.mock.calls[0][1]).toEqual([period.start, period.cutoff])
    expect(queryMock.mock.calls[1][0]).toContain('created_by = ANY($1::uuid[])')
    expect(queryMock.mock.calls[1][1]).toEqual([[user.id]])
    expect(queryMock.mock.calls[2][0]).toContain('source = \'stripe_top_up\'')
    expect(queryMock.mock.calls[2][0]).toContain('credits_total > 0')
    expect(queryMock.mock.calls[2][1]).toEqual([[org.id], period.start])
    expect(queryMock.mock.calls[2][0]).not.toContain('granted_at <')
    expect(data.grants[0]).toMatchObject({ credits_total: 12.5, payment_intent_id: 'pi_fake', granted_at: '2026-09-02T00:00:00.000Z' })
    expect(releaseMock).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('never expands lookups to missing profiles or invited signups', async () => {
    queryMock.mockReset().mockResolvedValue({ rows: [{ ...user, has_public_row: false, created_via_invite: null }] })
    const data = await loadOnboardingPaymentCohortData(c, period)
    expect(data.orgs).toEqual([])
    expect(data.grants).toEqual([])
    expect(queryMock).toHaveBeenCalledOnce()
  })

  it.each([0, 1, 2])('releases and closes pool when query %s fails', async (failureIndex) => {
    queryMock.mockReset()
    for (let index = 0; index < failureIndex; index++)
      queryMock.mockResolvedValueOnce({ rows: index === 0 ? [user] : [org] })
    queryMock.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow('database unavailable')
    expect(releaseMock).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('closes pool even when connecting fails', async () => {
    connectMock.mockRejectedValueOnce(new Error('connection unavailable'))
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow('connection unavailable')
    expect(releaseMock).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('still closes the pool if returning the connection throws', async () => {
    releaseMock.mockImplementationOnce(() => {
      throw new Error('release unavailable')
    })
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow('release unavailable')
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it.each([{ total_rows: 2 }, { total_rows: undefined }, { signup_at: 'bad' }, { created_via_invite: null }, { id: '' }])('rejects truncated or malformed signup source %j', async (extra) => {
    queryMock.mockReset().mockResolvedValueOnce({ rows: [{ ...user, ...extra }] })
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow()
    expect(releaseMock).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('rejects truncated owned orgs and never loads their grants', async () => {
    queryMock.mockReset().mockResolvedValueOnce({ rows: [user] }).mockResolvedValueOnce({ rows: [{ ...org, total_rows: 2 }] })
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow(/incomplete/i)
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it.each([{ credits_total: 'bad' }, { source_ref: [] }, { granted_at: 'bad' }, { total_rows: 2 }])('rejects malformed or incomplete credit source %j', async (extra) => {
    queryMock.mockReset().mockResolvedValueOnce({ rows: [user] }).mockResolvedValueOnce({ rows: [org] }).mockResolvedValueOnce({ rows: [{ ...grant, ...extra }] })
    await expect(loadOnboardingPaymentCohortData(c, period)).rejects.toThrow()
  })
})
