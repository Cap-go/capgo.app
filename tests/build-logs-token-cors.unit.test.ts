import { describe, expect, it } from 'vitest'
import { app as build } from '../supabase/functions/_backend/public/build/index.ts'
import { createAllCatch, createHono } from '../supabase/functions/_backend/utils/hono.ts'

// Same composition as the API worker: the console calls this route cross-origin with a JWT.
const api = createHono('api', 'test')
api.route('/build', build)
createAllCatch(api, 'api')

describe('build logs token CORS', () => {
  it('answers the console preflight', async () => {
    const res = await api.request('/build/logs_token/job_abc', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://console.capgo.app',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    })
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
  })

  it('lets the console read the response, even when it is an auth error', async () => {
    const res = await api.request('/build/logs_token/job_abc', { headers: { Origin: 'https://console.capgo.app' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
  })
})
