import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { reportBuilderCapacity } from '../supabase/functions/_backend/public/build/capacity.ts'

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: () => 'builder-test-key',
}))

const app = new Hono<MiddlewareKeyVariables>().post('/capacity', reportBuilderCapacity)

function report(body: unknown, apiKey = 'builder-test-key') {
  return app.request('http://local/capacity', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  })
}

describe('builder capacity handoff', () => {
  it.concurrent('acknowledges authenticated reports without recording history', async () => {
    const response = await report({ workers_total: 3 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', recorded: false, workers_total: 3 })
  })

  it.concurrent('rejects reports with an invalid API key', async () => {
    expect((await report({ workers_total: 3 }, 'invalid-key')).status).toBe(401)
  })

  it.concurrent('keeps validating the reported worker count', async () => {
    expect((await report({ workers_total: -1 })).status).toBe(400)
  })
})
