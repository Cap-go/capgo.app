import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bento from '../supabase/functions/_backend/utils/bento.ts'

const originalBentoEnv = {
  publishableKey: process.env.BENTO_PUBLISHABLE_KEY,
  secretKey: process.env.BENTO_SECRET_KEY,
  siteUuid: process.env.BENTO_SITE_UUID,
}

type BentoWithChangeEmail = typeof bento & {
  changeEmailBento: (c: never, oldEmail: string, newEmail: string) => Promise<boolean | undefined>
}

function context() {
  return { get: vi.fn(() => 'request-id') } as never
}

async function changeEmail(oldEmail: string, newEmail: string) {
  return await (bento as BentoWithChangeEmail).changeEmailBento(context(), oldEmail, newEmail)
}

describe('changeEmailBento', () => {
  beforeEach(() => {
    process.env.BENTO_PUBLISHABLE_KEY = 'publishable-key'
    process.env.BENTO_SECRET_KEY = 'secret-key'
    process.env.BENTO_SITE_UUID = 'site-uuid'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalBentoEnv.publishableKey === undefined)
      delete process.env.BENTO_PUBLISHABLE_KEY
    else
      process.env.BENTO_PUBLISHABLE_KEY = originalBentoEnv.publishableKey
    if (originalBentoEnv.secretKey === undefined)
      delete process.env.BENTO_SECRET_KEY
    else
      process.env.BENTO_SECRET_KEY = originalBentoEnv.secretKey
    if (originalBentoEnv.siteUuid === undefined)
      delete process.env.BENTO_SITE_UUID
    else
      process.env.BENTO_SITE_UUID = originalBentoEnv.siteUuid
  })

  it('moves the normalized subscriber identity with the Bento change_email command', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(changeEmail(' Old.User@Example.COM ', ' New.User@Example.COM ')).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.bentonow.com/api/v1/fetch/commands?site_uuid=site-uuid')
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        command: {
          command: 'change_email',
          email: 'old.user@example.com',
          query: 'new.user@example.com',
        },
      }),
    }))
  })

  it('returns false when configured Bento rejects the identity move', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))

    await expect(changeEmail('old@example.com', 'new@example.com')).resolves.toBe(false)
  })

  it('returns undefined without making a request when Bento is not configured', async () => {
    delete process.env.BENTO_SECRET_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(changeEmail('old@example.com', 'new@example.com')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
