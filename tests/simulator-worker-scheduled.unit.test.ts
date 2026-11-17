import { describe, expect, it, vi } from 'vitest'

const sweepMock = vi.hoisted(() => vi.fn(async () => ({ orgs: 0, orphanedDevices: 0, hostSync: 0 })))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/public/build/concurrency.ts')>(),
  sweepDueSimulatorSessions: sweepMock,
}))

describe('simulator worker scheduled sweep', () => {
  it('runs the simulator sweep from the minute cron', async () => {
    const { runScheduledSimulatorExpiry } = await import('../cloudflare_workers/api/index.ts')
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
    await runScheduledSimulatorExpiry({} as never, ctx)
    await Promise.all(pending)
    expect(sweepMock).toHaveBeenCalledTimes(1)
  })
})