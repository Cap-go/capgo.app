import type { DispatchEnv } from '../cloudflare_workers/bento_dispatch/index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeDispatch, scheduleDispatch } from '../cloudflare_workers/bento_dispatch/index.ts'

const { db, store, publish, process, accepted } = vi.hoisted(() => ({
  db: { connect: vi.fn(), end: vi.fn(), query: vi.fn(), on: vi.fn() },
  store: { relayPendingAudit: vi.fn() },
  publish: vi.fn(),
  process: vi.fn(),
  accepted: vi.fn(),
}))
vi.mock('pg', () => ({ Client: class {
  constructor() {
    return db
  }
} }))
vi.mock('../cloudflare_workers/bento_dispatch/store.ts', () => ({ DispatchStore: class {
  constructor() {
    return store
  }
} }))
vi.mock('../cloudflare_workers/bento_dispatch/scheduler.ts', () => ({ publishDispatchJobs: publish }))
vi.mock('../cloudflare_workers/bento_dispatch/consumer.ts', () => ({ processDispatchJob: process }))
vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({ isBentoConfigured: () => true, trackBentoEvent: accepted }))

const job = { version: 1, evaluationKey: 'org:invite_existing_user_reminder_1', runId: '11111111-1111-4111-8111-111111111111' }
function environment(): DispatchEnv {
  return { HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://local' } as Hyperdrive, DISPATCH_QUEUE: { send: vi.fn() } as never, POSTHOG_QUEUE: { send: vi.fn() }, BENTO_EVENT_DISPATCH_ENABLED: 'true', BENTO_PUBLISHABLE_KEY: 'configured', BENTO_SECRET_KEY: 'configured', BENTO_SITE_UUID: 'configured', WEBAPP_URL: 'https://console.example.com' }
}
function message(body: unknown = job, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() } as unknown as Message<unknown>
}
const batch = (messages: Message<unknown>[]) => ({ messages } as unknown as MessageBatch<unknown>)
beforeEach(() => {
  vi.clearAllMocks()
  db.query.mockResolvedValue({ rows: [] })
  publish.mockResolvedValue(undefined)
  process.mockResolvedValue({ accepted: 1 })
  store.relayPendingAudit.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
describe('dedicated evaluation Worker', () => {
  it('sweeps audits independently and still schedules evaluations during analytics failure', async () => {
    store.relayPendingAudit.mockRejectedValue(new Error('unavailable'))
    await scheduleDispatch({} as ScheduledController, environment())
    expect(publish).toHaveBeenCalledOnce()
    expect(db.end).toHaveBeenCalledOnce()
  })
  it('defaults inactive without a Vault setting', async () => {
    const env = environment()
    delete env.BENTO_EVENT_DISPATCH_ENABLED
    await scheduleDispatch({} as ScheduledController, env)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('vault.decrypted_secrets'), ['BENTO_EVENT_DISPATCH_ENABLED'])
    expect(publish).not.toHaveBeenCalled()
  })
  it('honors explicit off and acknowledges stale jobs', async () => {
    const env = environment()
    env.BENTO_EVENT_DISPATCH_ENABLED = 'false'
    const msg = message()
    await consumeDispatch(batch([msg]), env)
    expect(msg.ack).toHaveBeenCalledOnce()
    expect(process).not.toHaveBeenCalled()
  })
  it('runs the registered evaluator and acknowledges completed business work despite audit outage', async () => {
    store.relayPendingAudit.mockRejectedValue(new Error('unavailable'))
    const env = environment()
    const msg = message()
    await consumeDispatch(batch([msg]), env)
    expect(process).toHaveBeenCalledWith(job, store, expect.any(Function), expect.objectContaining({ key: job.evaluationKey }), env.POSTHOG_QUEUE)
    expect(msg.ack).toHaveBeenCalledOnce()
    expect(msg.retry).not.toHaveBeenCalled()
  })
  it.each([1, 5])('caps queue delivery retries at five, delivery %i', async (attempts) => {
    process.mockRejectedValue(new Error('unavailable'))
    const msg = message(job, attempts)
    await consumeDispatch(batch([msg]), environment())
    expect(attempts < 5 ? msg.retry : msg.ack).toHaveBeenCalledOnce()
    expect(attempts < 5 ? msg.ack : msg.retry).not.toHaveBeenCalled()
  })
  it('defensively acknowledges delivery six without another database attempt', async () => {
    const msg = message(job, 6)
    await consumeDispatch(batch([msg]), environment())
    expect(msg.ack).toHaveBeenCalledOnce()
    expect(msg.retry).not.toHaveBeenCalled()
    expect(db.connect).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
  })
  it('rejects malformed payloads without exposing their contents', async () => {
    const msg = message({ secret: 'private-message' })
    await consumeDispatch(batch([msg]), environment())
    expect(msg.ack).toHaveBeenCalledOnce()
    expect(db.connect).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-message')
  })
  it('refuses multi-message batches', async () => {
    const messages = [message(), message()]
    await consumeDispatch(batch(messages), environment())
    expect(messages.every(msg => vi.mocked(msg.retry).mock.calls.length === 1)).toBe(true)
    expect(db.connect).not.toHaveBeenCalled()
  })
  it('rejects unsafe runtime configuration before claiming work', async () => {
    const env = environment()
    env.WEBAPP_URL = 'https://user:secret@console.example.com'
    const msg = message()
    await consumeDispatch(batch([msg]), env)
    expect(process).not.toHaveBeenCalled()
    expect(msg.retry).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret')
  })
})
