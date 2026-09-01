import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api observe route', () => {
  it.concurrent('mounts observe query on private API worker routes', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'com.test.app', view: 'summary', days: 7 }),
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_jwt_apikey_or_subkey' })
  })
})
