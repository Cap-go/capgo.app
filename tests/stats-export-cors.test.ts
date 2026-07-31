import { describe, expect, it } from 'vitest'

import { app } from '../supabase/functions/_backend/private/stats.ts'

describe('[OPTIONS] /private/stats/export', () => {
  it('responds to CORS preflight', async () => {
    const res = await app.request('http://local/export', {
      method: 'OPTIONS',
      headers: {
        'origin': 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
  })
})
