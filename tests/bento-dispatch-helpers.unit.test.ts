import type { EligibleUser, ResolvedAction } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { describe, expect, it, vi } from 'vitest'
import { createMutationContext } from '../cloudflare_workers/bento_dispatch/helpers.ts'

const user: EligibleUser = { flowKey: 'test:flow', contextKey: 'context', recipientKey: 'email:recipient@example.com', email: 'recipient@example.com', tag: 'test:event', action: 'send', reason: 'due', metadata: {} }
const sending: ResolvedAction = { action: 'send', buildEvent: id => ({ email: user.email, event: user.tag, data: { dispatch_id: id } }) }
function fixture() {
  const store = { readOnly: vi.fn(async fn => fn({ query: vi.fn() })), claimEvent: vi.fn().mockResolvedValue({ id: 'event', claim_token: 'owner', attempt_count: 1 }), acceptEvent: vi.fn().mockResolvedValue(true), failEvent: vi.fn(), releaseEvent: vi.fn(), endFlow: vi.fn(), skip: vi.fn(), flushFlowAudit: vi.fn() }
  return { store, send: vi.fn().mockResolvedValue(true) }
}
describe('audited shared Bento helpers', () => {
  it('records an unconfirmed provider result without claiming that Bento rejected it', async () => {
    const f = fixture()
    f.send.mockResolvedValue(false)
    const ctx = createMutationContext(f.store as never, { id: 'run' } as never, f.send)
    expect(await ctx.sendBentoEvent(user, async () => sending)).toMatchObject({ outcome: 'failed' })
    expect(f.store.failEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), user, 'provider_not_confirmed')
  })
  it('releases a stale post-claim candidate with a skip audit instead of a provider failure', async () => {
    const f = fixture()
    const resolve = vi.fn().mockResolvedValueOnce(sending).mockResolvedValueOnce({ action: 'end', reason: 'cancelled' })
    const ctx = createMutationContext(f.store as never, { id: 'run' } as never, f.send)
    expect(await ctx.sendBentoEvent(user, resolve)).toMatchObject({ outcome: 'ended' })
    expect(f.store.releaseEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), user, 'cancelled')
    expect(f.store.failEvent).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('keeps saved acceptance when its analytics handoff fails', async () => {
    const f = fixture()
    f.store.flushFlowAudit.mockRejectedValue(new Error('queue unavailable'))
    const ctx = createMutationContext(f.store as never, { id: 'run' } as never, f.send)
    expect(await ctx.sendBentoEvent(user, async () => sending)).toMatchObject({ outcome: 'accepted' })
    expect(f.store.acceptEvent).toHaveBeenCalledOnce()
    expect(f.store.failEvent).not.toHaveBeenCalled()
  })
  it('returns individual outcomes and leaves unfinished recipients for a future evaluation', async () => {
    const f = fixture()
    let time = 0
    const ctx = createMutationContext(f.store as never, { id: 'run' } as never, async () => {
      time += 30_000
      return true
    }, {}, () => time)
    const users = Array.from({ length: 12 }, (_, index) => ({ ...user, contextKey: `context-${index}` }))
    const outcomes = await ctx.sendBentoEvents(users, async () => sending)
    expect(outcomes).toHaveLength(12)
    expect(outcomes.some(outcome => outcome.outcome === 'deferred')).toBe(true)
    expect(f.store.claimEvent.mock.calls.length).toBeLessThanOrEqual(5)
  })
})
