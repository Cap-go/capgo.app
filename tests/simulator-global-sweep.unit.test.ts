import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_IDLE_TIMEOUT_MINUTES } from '../supabase/functions/_backend/public/build/concurrency.ts'

const concurrencyPath = join(dirname(fileURLToPath(import.meta.url)), '../supabase/functions/_backend/public/build/concurrency.ts')
const workerPath = join(dirname(fileURLToPath(import.meta.url)), '../cloudflare_workers/api/index.ts')
const wranglerPath = join(dirname(fileURLToPath(import.meta.url)), '../cloudflare_workers/api/wrangler.jsonc')

describe('simulator global idle sweep', () => {
  it('finds due orgs globally and expires each org', () => {
    const source = readFileSync(concurrencyPath, 'utf8')
    expect(source).toContain('ORGS_WITH_DUE_SIMULATOR_SESSIONS_SQL')
    expect(source).toContain('syncInProgressSimulatorSessionsFromHost')
    expect(source).toMatch(/for \(const row of orgs\.rows\)/)
    expect(source).toContain('expireSimulatorSessions(c, row.owner_org)')
    expect(source).toContain('Simulator expiry failed for one org')
    expect(source).toContain(`make_interval(mins => $1)`)
    expect(source).toContain('SIMULATOR_IDLE_TIMEOUT_MINUTES')
  })

  it('registers a per minute cron trigger in the deployed worker config', () => {
    const wrangler = readFileSync(wranglerPath, 'utf8')
    expect(wrangler).toContain('"crons": ["* * * * *"]')
  })

  it('dispatches the simulator sweep from the scheduled handler', async () => {
    const worker = readFileSync(workerPath, 'utf8')
    expect(worker).toContain('runScheduledSimulatorExpiry')
    expect(worker).toContain('sweepDueSimulatorSessions')
  })

  it('keeps the sweep idle window aligned with the API constant', () => {
    expect(SIMULATOR_IDLE_TIMEOUT_MINUTES).toBe(5)
  })
})