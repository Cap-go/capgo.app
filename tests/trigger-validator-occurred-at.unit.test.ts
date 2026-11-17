import { describe, expect, it } from 'vitest'
import { honoFactory, triggerValidator } from '../supabase/functions/_backend/utils/hono.ts'

// Trigger messages carry occurred_at (when the row changed) since the GB-hour storage billing:
// on_app_delete finalizes a deleted app's storage up to it, whatever the queue delay.

function createApp() {
  const app = honoFactory.createApp()
  app.post('/', triggerValidator('apps', 'DELETE'), c => c.json({ occurredAt: c.get('webhookOccurredAt') ?? null }))
  return app
}

async function post(body: Record<string, unknown>) {
  const response = await createApp().request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'DELETE', table: 'apps', schema: 'public', record: null, old_record: { app_id: 'com.test.app' }, ...body }),
  })
  expect(response.status).toBe(200)
  return (await response.json() as { occurredAt: string | null }).occurredAt
}

describe('triggerValidator occurred_at', () => {
  it('exposes the event time of the database change', async () => {
    expect(await post({ occurred_at: '2026-01-10T12:00:00.000Z' })).toBe('2026-01-10T12:00:00.000Z')
  })

  it('ignores messages queued without it or with an invalid value', async () => {
    expect(await post({})).toBeNull()
    expect(await post({ occurred_at: 'not a date' })).toBeNull()
  })
})
