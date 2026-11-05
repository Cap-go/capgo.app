import { describe, expect, it, vi } from 'vitest'
import { computeNewOrgTrialEnd, DEFAULT_TRIAL_DAYS, getDirectOfferStatus, isDirectOfferMetadata, isDirectOfferUser, resolveNewOrgTrialEnd } from '../supabase/functions/_backend/utils/direct_offer.ts'

describe('direct offer trial', () => {
  it.concurrent('only the literal direct value is a direct offer', () => {
    expect(isDirectOfferMetadata({ offer: 'direct' })).toBe(true)
    expect(isDirectOfferMetadata({ offer: 'Direct' })).toBe(false)
    expect(isDirectOfferMetadata({ offer: 'direct ' })).toBe(false)
    expect(isDirectOfferMetadata({ offer: true })).toBe(false)
    expect(isDirectOfferMetadata({})).toBe(false)
    expect(isDirectOfferMetadata(null)).toBe(false)
    expect(isDirectOfferMetadata(undefined)).toBe(false)
  })

  it.concurrent('direct offer orgs get a zero-length trial', () => {
    const now = new Date('2026-10-20T12:00:00.000Z')
    expect(computeNewOrgTrialEnd(true, now).toISOString()).toBe(now.toISOString())
  })

  it.concurrent('other orgs keep the standard trial', () => {
    const now = new Date('2026-10-20T12:00:00.000Z')
    expect(DEFAULT_TRIAL_DAYS).toBe(15)
    const expected = new Date(now)
    expected.setDate(expected.getDate() + 15)
    expect(computeNewOrgTrialEnd(false, now).toISOString()).toBe(expected.toISOString())
    expect(now.toISOString()).toBe('2026-10-20T12:00:00.000Z')
  })

  const context = { get: () => 'direct-offer-test' } as any
  function admin(result: { metadata?: Record<string, unknown>, userMetadata?: Record<string, unknown>, error?: Error }) {
    return { auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: result.error ? null : { app_metadata: result.metadata ?? {}, user_metadata: result.userMetadata ?? {} } }, error: result.error ?? null })) } } }
  }

  it.concurrent('resolveNewOrgTrialEnd rethrows a failed lookup instead of granting a trial', async () => {
    const failure = new Error('auth unavailable')
    await expect(resolveNewOrgTrialEnd(context, admin({ error: failure }), 'user-id')).rejects.toBe(failure)
  })

  it.concurrent('resolveNewOrgTrialEnd gives the standard trial without a creator, and none for direct', async () => {
    const lookup = admin({ metadata: { offer: 'direct' } })
    const before = Date.now()
    const noCreator = await resolveNewOrgTrialEnd(context, lookup, null)
    expect(noCreator.getTime() - before).toBeGreaterThan(14 * 24 * 60 * 60 * 1000)
    expect(lookup.auth.admin.getUserById).not.toHaveBeenCalled()
    const direct = await resolveNewOrgTrialEnd(context, lookup, 'user-id')
    expect(direct.getTime()).toBeGreaterThanOrEqual(before)
    expect(direct.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it.concurrent('getDirectOfferStatus reports a failed lookup as unknown; isDirectOfferUser throws', async () => {
    await expect(getDirectOfferStatus(context, admin({ error: new Error('auth unavailable') }), 'user-id')).resolves.toBeNull()
    await expect(isDirectOfferUser(context, admin({ error: new Error('auth unavailable') }), 'user-id')).rejects.toThrow('auth unavailable')
  })

  it.concurrent('reads the offer from server-only app metadata, not user metadata', async () => {
    await expect(isDirectOfferUser(context, admin({ metadata: { offer: 'direct' } }), 'user-id')).resolves.toBe(true)
    await expect(isDirectOfferUser(context, admin({ userMetadata: { offer: 'direct' } }), 'user-id')).resolves.toBe(false)
    await expect(getDirectOfferStatus(context, admin({}), 'user-id')).resolves.toBe(false)
  })
})
