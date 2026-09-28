import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api organization invitation route', () => {
  it.concurrent('mounts the anonymous magic-link lookup on the private API worker', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/organization_invitation/magic-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_json_body' })
  })
})
