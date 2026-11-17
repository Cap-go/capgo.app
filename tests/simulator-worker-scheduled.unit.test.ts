import { describe, expect, it, vi } from 'vitest'

const sweepSpy = vi.hoisted(() => vi.fn(async () => ({ orgs: 0, orphanedDevices: 0, hostSync: 0 })))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/public/build/concurrency.ts')>(),
  sweepDueSimulatorSessions: sweepSpy,
}))

vi.mock('../supabase/functions/_backend/utils/plugin_notification_flush.ts', () => ({
  flushQueuedPluginNotifications: vi.fn(async () => ({ transferred: 0, failed: 0 })),
}))

describe('simulator worker scheduled sweep', () => {
  it('runs the simulator sweep from the worker scheduled handler', async () => {
    const worker = (await import('../cloudflare_workers/api/index.ts')).default
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
    await worker.scheduled({} as ScheduledController, {} as never, ctx)
    await Promise.all(pending)
    expect(sweepSpy).toHaveBeenCalledTimes(1)
  })
})