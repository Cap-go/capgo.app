import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('cloudflare api CORS', () => {
  it.concurrent('responds to notifications preflight requests', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/notifications/providers?app_id=com.test.app', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://console.capgo.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type,authorization',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
  })

  it.concurrent('allows the console image upload headers', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/console/images/upload', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://console.capgo.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-image-path,x-image-upsert',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
    const allowHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? ''
    expect(allowHeaders).toContain('x-image-path')
    expect(allowHeaders).toContain('x-image-upsert')
  })

  it.concurrent('includes CORS headers on unknown api routes', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/missing-route', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://console.capgo.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
  })
})
