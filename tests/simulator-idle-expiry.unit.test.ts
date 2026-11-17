import { describe, expect, it } from 'vitest'
import { SIMULATOR_IDLE_TIMEOUT_MINUTES } from '../supabase/functions/_backend/public/build/concurrency.ts'
import { simulatorSessionPastExpiry } from '../supabase/functions/_backend/public/build/simulator.ts'

describe('simulator idle expiry helpers', () => {
  it('treats four minutes idle as inside the five minute window', () => {
    const now = Date.parse('2026-10-29T12:10:00.000Z')
    const startedAt = '2026-10-29T12:00:00.000Z'
    const lastActivityAt = '2026-10-29T12:06:00.000Z'
    expect(simulatorSessionPastExpiry({ started_at: startedAt, last_activity_at: lastActivityAt, max_duration_minutes: 40 }, now)).toBe(false)
  })

  it('treats six minutes idle as past the window', () => {
    const now = Date.parse('2026-10-29T12:10:00.000Z')
    const startedAt = '2026-10-29T12:00:00.000Z'
    const lastActivityAt = '2026-10-29T12:04:00.000Z'
    expect(simulatorSessionPastExpiry({ started_at: startedAt, last_activity_at: lastActivityAt, max_duration_minutes: 40 }, now)).toBe(true)
  })

  it('keeps the SQL and TypeScript idle windows aligned at five minutes', () => {
    expect(SIMULATOR_IDLE_TIMEOUT_MINUTES).toBe(5)
  })
})