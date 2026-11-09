import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncSecurityUpdatesBento } from '../supabase/functions/_backend/utils/security_updates_bento.ts'

const syncBentoSubscriberTagsMock = vi.hoisted(() => vi.fn(async () => true))
const updateBentoFieldsMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
  updateBentoFields: updateBentoFieldsMock,
}))

function createContext() {
  return { get: vi.fn(() => 'test-request-id') } as never
}

describe('syncSecurityUpdatesBento', () => {
  beforeEach(() => {
    syncBentoSubscriberTagsMock.mockClear()
    updateBentoFieldsMock.mockClear()
  })

  it('subscribes with tag and field when opt-in turns on', async () => {
    await syncSecurityUpdatesBento(
      createContext(),
      'user@example.com',
      { security_updates: true },
      { security_updates: false },
    )
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'user@example.com',
      segments: ['security-updates'],
      deleteSegments: [],
    })
    expect(updateBentoFieldsMock).toHaveBeenCalledWith(expect.anything(), 'user@example.com', {
      security_updates_opt_in: true,
    })
  })

  it('unsubscribes by removing the tag and clearing the field', async () => {
    await syncSecurityUpdatesBento(
      createContext(),
      'user@example.com',
      { security_updates: false },
      { security_updates: true },
    )
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'user@example.com',
      segments: [],
      deleteSegments: ['security-updates'],
    })
    expect(updateBentoFieldsMock).toHaveBeenCalledWith(expect.anything(), 'user@example.com', {
      security_updates_opt_in: false,
    })
  })

  it('skips Bento when the preference did not change', async () => {
    await syncSecurityUpdatesBento(
      createContext(),
      'user@example.com',
      { security_updates: true },
      { security_updates: true },
    )
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(updateBentoFieldsMock).not.toHaveBeenCalled()
  })
})
