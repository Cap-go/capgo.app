import { describe, expect, it, vi } from 'vitest'

const API_SECRET = 'testsecret'

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => (key === 'API_SECRET' ? API_SECRET : ''),
}))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', () => ({
  sweepDueSimulatorSessions: vi.fn(async () => ({ orgs: 2, orphanedDevices: 1 })),
}))

describe('cron_expire_simulator_sessions', () => {
  it('returns sweep stats', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/cron_expire_simulator_sessions.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { apisecret: API_SECRET },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', orgs: 2, orphanedDevices: 1 })
  })
})