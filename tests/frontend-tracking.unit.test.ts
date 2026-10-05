import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, getSessionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getSessionMock: vi.fn(),
}))

vi.mock('~/services/supabase', () => ({
  defaultApiHost: 'https://api.capgo.test',
  useSupabase: () => ({
    auth: {
      getSession: getSessionMock,
    },
  }),
}))

import { sendEvent } from '~/services/tracking'

describe('frontend analytics tracking', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    getSessionMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('keeps the analytics request alive when the document unloads', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'test-access-token',
        },
      },
    })
    fetchMock.mockResolvedValue({ ok: true })

    await sendEvent({
      channel: 'usage',
      event: 'Navigation Started',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.capgo.test/private/events',
      expect.objectContaining({
        keepalive: true,
        method: 'POST',
      }),
    )
  })
})
