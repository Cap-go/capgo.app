import type { PostHogDeliveryResult } from '../supabase/functions/_backend/utils/posthog_delivery.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deliverPosthogEventMock,
  importBentoSubscriberProfileMock,
} = vi.hoisted(() => ({
  deliverPosthogEventMock: vi.fn(async (): Promise<PostHogDeliveryResult> => ({
    outcome: 'delivered',
    duration_ms: 1,
    http_status: 200,
    legacy_success: true,
  })),
  importBentoSubscriberProfileMock: vi.fn(async () => true),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  deliverPosthogEvent: deliverPosthogEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  importBentoSubscriberProfile: importBentoSubscriberProfileMock,
}))

const { syncUserDisplayNameIntegrations, userDisplayNameChanged } = await import('../supabase/functions/_backend/utils/user_display_name_sync.ts')

describe('user display name sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects first or last name changes only', () => {
    const base = { first_name: 'Jane', last_name: 'Doe' }
    expect(userDisplayNameChanged(base, base)).toBe(false)
    expect(userDisplayNameChanged(base, { ...base, first_name: 'Janet' })).toBe(true)
    expect(userDisplayNameChanged(undefined, base)).toBe(false)
  })

  it('syncs PostHog before Bento and fails when PostHog delivery fails', async () => {
    deliverPosthogEventMock.mockResolvedValueOnce({
      outcome: 'retryable',
      duration_ms: 1,
      http_status: 503,
      legacy_success: false,
    } satisfies PostHogDeliveryResult)
    const ok = await syncUserDisplayNameIntegrations({} as never, {
      id: 'user-id',
      email: 'user@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    })
    expect(ok).toBe(false)
    expect(importBentoSubscriberProfileMock).not.toHaveBeenCalled()
  })

  it('still syncs Bento when PostHog is not configured', async () => {
    deliverPosthogEventMock.mockResolvedValueOnce({
      outcome: 'permanent_failure',
      reason: 'not_configured',
      duration_ms: 0,
      http_status: null,
      legacy_success: false,
    } satisfies PostHogDeliveryResult)
    const record = { id: 'user-id', email: 'user@example.com', first_name: 'Jane', last_name: 'Doe' }
    expect(await syncUserDisplayNameIntegrations({} as never, record)).toBe(true)
    expect(importBentoSubscriberProfileMock).toHaveBeenCalledWith(expect.anything(), {
      email: record.email,
      first_name: record.first_name,
      last_name: record.last_name,
    })
  })

  it('reports Bento failures so the existing update delivery can retry', async () => {
    importBentoSubscriberProfileMock.mockResolvedValueOnce(false)
    expect(await syncUserDisplayNameIntegrations({} as never, {
      id: 'user-id',
      email: 'user@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    })).toBe(false)
  })

  it.each([{ first_name: '', last_name: '', name: '' }, { first_name: '', last_name: 'Doe', name: 'Doe' }])('clears stale PostHog names when stored names change: %j', async (names) => {
    expect(await syncUserDisplayNameIntegrations({} as never, {
      id: 'user-id',
      email: 'user@example.com',
      first_name: names.first_name,
      last_name: names.last_name,
    })).toBe(true)
    expect(deliverPosthogEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      personProperties: { ...names, email: 'user@example.com' },
    }))
    expect(importBentoSubscriberProfileMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'user@example.com',
      first_name: names.first_name,
      last_name: names.last_name,
    })
  })

  it('syncs both integrations when PostHog succeeds', async () => {
    const ok = await syncUserDisplayNameIntegrations({} as never, {
      id: 'user-id',
      email: 'user@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    })
    expect(ok).toBe(true)
    expect(deliverPosthogEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: '$identify',
      user_id: 'user-id',
    }))
    expect(importBentoSubscriberProfileMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'user@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    })
  })
})
