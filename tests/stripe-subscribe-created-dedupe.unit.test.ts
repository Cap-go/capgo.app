import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const {
  notifToOrgMembersMock,
  notifToOrgMembersOnceWithResultMock,
} = vi.hoisted(() => ({
  notifToOrgMembersMock: vi.fn(),
  notifToOrgMembersOnceWithResultMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: () => true,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: vi.fn(async () => ({ mocked: true })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: (_c: unknown, promise: Promise<unknown>) => promise,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/org_email_notifications.ts')>(),
  sendNotifToOrgMembers: notifToOrgMembersMock,
  sendNotifToOrgMembersOnceWithResult: notifToOrgMembersOnceWithResultMock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  trackPosthogEvent: vi.fn(async () => true),
  deliverPosthogEvent: vi.fn(async () => ({ outcome: 'delivered', legacy_success: true })),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-subscribe-dedupe-test' : undefined,
    req: { header: () => undefined },
  } as any
}

describe('subscription subscribe_created Bento dedupe', () => {
  it.concurrent('uses once-ever Bento delivery for created subscribe events', () => {
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    expect(stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
      'created',
      'user:subscribe_created:monthly',
      'Solo',
      metadata,
    )).toEqual({
      once: true,
      audience: 'billing',
      data: metadata,
      event: 'user:subscribe_created:monthly',
      preferenceKey: 'credit_usage',
      uniqId: 'subscription:user:subscribe_created:monthly:Solo',
    })
  })

  it.concurrent('records processed Stripe events for subscription stripe_info writes without revenue movement', () => {
    const updateStatement = { text: 'UPDATE public.stripe_info SET status = $2 WHERE customer_id = $1', values: ['cus_x', 'created'] }
    expect(stripeEventTestUtils.shouldRecordProcessedStripeEvent(
      updateStatement,
      stripeEventTestUtils.classifyRevenueMovement(
        { status: 'updated', paid_at: null, price_id: null, product_id: null, is_good_plan: false },
        { status: 'created' },
        [],
      ),
    )).toBe(true)
  })

  it.concurrent('keeps cron throttling for updated and succeeded subscribe events', () => {
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    expect(stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
      'updated',
      'user:subscribe_updated:monthly',
      'Solo',
      metadata,
    )).toEqual({
      cron: '* * * * *',
      audience: 'billing',
      data: metadata,
      event: 'user:subscribe_updated:monthly',
      preferenceKey: 'credit_usage',
      uniqId: 'subscription:user:subscribe_updated:monthly:Solo',
    })
  })

  it.concurrent('runs subscription subscribe tracking after billing tag sync and cache purge in createdOrUpdated', () => {
    const source = readFileSync(`${import.meta.dirname}/../supabase/functions/_backend/triggers/stripe_event.ts`, 'utf8')
    const syncMarker = 'await syncBillingBentoTags(c, org, stripeData.data.customer_id, segment)'
    const purgeMarker = 'purgeOnPremCacheForOrg(c, org.id)'
    const subscribeMarker = 'bento: buildSubscriptionSubscribeBentoPayload(statusName, eventName, plan.name, subscriptionMetadata)'
    const syncIndex = source.indexOf(syncMarker)
    const purgeIndex = source.indexOf(purgeMarker, syncIndex)
    const subscribeIndex = source.indexOf(subscribeMarker, purgeIndex)
    expect(syncIndex).toBeGreaterThan(0)
    expect(purgeIndex).toBeGreaterThan(syncIndex)
    expect(subscribeIndex).toBeGreaterThan(purgeIndex)
  })
})

describe('second created subscription event for the same org', () => {
  const orgId = randomUUID()

  beforeEach(() => {
    notifToOrgMembersMock.mockReset()
    notifToOrgMembersOnceWithResultMock.mockReset()
    notifToOrgMembersOnceWithResultMock.mockResolvedValue('sent')
    notifToOrgMembersMock.mockResolvedValue(true)
  })

  it('delivers subscribe_created Bento at most once per org across a second created webhook', async () => {
    const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    const payload = {
      bento: stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
        'created',
        'user:subscribe_created:monthly',
        'Solo',
        metadata,
      ),
      channel: 'usage',
      event: 'User subscribe',
      sentToBento: true,
      user_id: orgId,
      groups: { organization: orgId },
      tags: metadata,
    }

    await sendEventToTracking(createContext(), payload, { background: false })
    notifToOrgMembersOnceWithResultMock.mockResolvedValueOnce('already_claimed')
    await sendEventToTracking(createContext(), payload, { background: false })

    expect(notifToOrgMembersOnceWithResultMock).toHaveBeenCalledTimes(2)
    expect(notifToOrgMembersMock).not.toHaveBeenCalled()
    expect(notifToOrgMembersOnceWithResultMock.mock.calls.every(call => call[5] === payload.bento!.uniqId)).toBe(true)
  })
})

describe('webhook replay blocks subscribe tracking before Bento', () => {
  it.concurrent('does not send subscribe tracking when persist returns duplicate', () => {
    expect(stripeEventTestUtils.shouldSendSubscriptionSubscribeTrackingAfterPersist('duplicate')).toBe(false)
    expect(stripeEventTestUtils.shouldSendSubscriptionSubscribeTrackingAfterPersist('applied')).toBe(true)
  })
})
