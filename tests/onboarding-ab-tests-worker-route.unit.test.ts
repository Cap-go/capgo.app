import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api onboarding A/B tests route', () => {
  it.concurrent.each(['onboarding_ab_tests', 'onboarding_progress'])('rejects unauthenticated private API traffic for %s', async (path) => {
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app/private/${path}`, {
      method: 'POST',
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_jwt_apikey_or_subkey' })
  })
})
