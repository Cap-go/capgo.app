import type { EligibleUser } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { describe, expect, it, vi } from 'vitest'
import { DispatchStore } from '../cloudflare_workers/bento_dispatch/store.ts'

describe('bento shared provider budget', () => {
  it('defers without creating or consuming an event attempt when the rolling budget is exhausted', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*)'))
        return { rows: [{ count: 60 }], rowCount: 1 }
      return { rows: [{ id: 'active' }], rowCount: 1 }
    }) }
    const store = new DispatchStore(client as never)
    const user: EligibleUser = { flowKey: 'flow', contextKey: 'context', recipientKey: 'recipient', email: 'recipient@example.com', tag: 'test:event', action: 'send', reason: 'due', metadata: {} }
    expect(await store.claimEvent({ id: '11111111-1111-4111-8111-111111111111' } as never, user)).toBeNull()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO public.bento_event_dispatches'))).toBe(false)
    expect(JSON.stringify(client.query.mock.calls)).toContain('provider_budget_deferred')
  })
})
