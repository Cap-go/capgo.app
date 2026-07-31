import { describe, expect, it } from 'vitest'
import pluginWorker from '../cloudflare_workers/plugin/index.ts'

describe('cloudflare plugin CORS', () => {
  it.concurrent('responds to manifest size preflight requests', async () => {
    const response = await pluginWorker.fetch(new Request('https://api.capgo.app/updates/manifest_size', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://console.capgo.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
    const allowMethods = response.headers.get('access-control-allow-methods')?.toLowerCase()
    const allowHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase()
    expect(allowMethods).toContain('options')
    expect(allowMethods).toContain('post')
    expect(allowHeaders).toContain('content-type')
    expect(allowHeaders).toContain('authorization')
  })
})
