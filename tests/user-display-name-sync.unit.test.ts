import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostHogDeliveryResult } from '../supabase/functions/_backend/utils/posthog_delivery.ts'

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
