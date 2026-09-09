import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api onboarding A/B tests route', () => {
  it.concurrent('rejects unauthenticated private API traffic', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/onboarding_ab_tests', {
      method: 'POST',
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_jwt_apikey_or_subkey' })
  })
})
