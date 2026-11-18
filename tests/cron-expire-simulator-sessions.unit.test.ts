import { describe, expect, it, vi } from 'vitest'

const API_SECRET = 'testsecret'

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => (key === 'API_SECRET' ? API_SECRET : ''),
}))

const sweepDueSimulatorSessionsMock = vi.hoisted(() => vi.fn(async () => ({ orgs: 2, orphanedDevices: 1, hostSync: 3 })))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', () => ({
  sweepDueSimulatorSessions: sweepDueSimulatorSessionsMock,
}))

describe('cron_expire_simulator_sessions', () => {
  it('returns sweep stats', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/cron_expire_simulator_sessions.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { apisecret: API_SECRET },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', orgs: 2, orphanedDevices: 1, hostSync: 3 })
  })

  it('rejects requests without the API secret', async () => {
    sweepDueSimulatorSessionsMock.mockClear()
    const { app } = await import('../supabase/functions/_backend/triggers/cron_expire_simulator_sessions.ts')
    const response = await app.request('http://local/', { method: 'POST' })
    expect(response.status).toBe(400)
    expect(sweepDueSimulatorSessionsMock).not.toHaveBeenCalled()
  })
})