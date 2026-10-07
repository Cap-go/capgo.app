import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare request manifest upload route', () => {
  it('mounts the endpoint behind API-key authentication', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_key_provided' })
  })
})
