import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api native observe route', () => {
  it.concurrent('mounts native observe stats on private API worker routes', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/native_observe_stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'com.test.app', days: 7 }),
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_jwt_apikey_or_subkey' })
  })
})
