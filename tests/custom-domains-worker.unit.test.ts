import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

// Exercise the entrypoint used by the production console, not only the Supabase router.
describe('cloudflare API custom domain routes', () => {
  it.each(['GET', 'POST', 'DELETE'])('routes %s requests through domain authentication', async (method) => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/custom_domains/00000000-0000-4000-8000-000000000001', { method }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'no_jwt_apikey_or_subkey' })
  })
})
