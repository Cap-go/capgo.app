import { beforeEach, describe, expect, it, vi } from 'vitest'

import { syncUserPreferenceTags } from '../supabase/functions/_backend/utils/user_preferences.ts'

const syncBentoSubscriberTagsMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
}))

function createContext() {
  return {
    get: vi.fn(() => 'test-request-id'),
  } as never
}

const record = {
  email_preferences: {},
  enable_notifications: false,
  opt_for_newsletters: false,
} as never

describe('syncUserPreferenceTags email type', () => {
  beforeEach(() => {
    syncBentoSubscriberTagsMock.mockClear()
  })

  it.each([
    ['developer@company.com', 'email_type:professional', ['email_type:personal', 'email_type:disposable']],
    ['developer@gmail.com', 'email_type:personal', ['email_type:professional', 'email_type:disposable']],
    ['developer@mailinator.com', 'email_type:disposable', ['email_type:professional', 'email_type:personal']],
  ])('tags %s as %s', async (email, expectedTag, removedTags) => {
    const context = createContext()

    await syncUserPreferenceTags(context, email, record)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      email,
      segments: [expectedTag],
      deleteSegments: expect.arrayContaining(removedTags),
    }))
  })

  it('moves all managed tags when an email address changes', async () => {
    const context = createContext()

    await syncUserPreferenceTags(context, 'developer@company.com', record, record, 'developer@gmail.com')

    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
      email: 'developer@gmail.com',
      segments: [],
      deleteSegments: expect.arrayContaining([
        'email_type:professional',
        'email_type:personal',
        'email_type:disposable',
      ]),
    }))
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(2, context, expect.objectContaining({
      email: 'developer@company.com',
      segments: ['email_type:professional'],
      deleteSegments: expect.arrayContaining(['email_type:personal', 'email_type:disposable']),
    }))
  })

  it('backfills the email type tag for a same-address preference update', async () => {
    const context = createContext()

    await syncUserPreferenceTags(context, 'developer@gmail.com', {
      email_preferences: {},
      enable_notifications: true,
      opt_for_newsletters: false,
    } as never, record, 'developer@gmail.com')

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      email: 'developer@gmail.com',
      segments: expect.arrayContaining(['email_type:personal', 'notifications_opt_in']),
      deleteSegments: expect.arrayContaining(['email_type:professional', 'email_type:disposable']),
    }))
  })
})
