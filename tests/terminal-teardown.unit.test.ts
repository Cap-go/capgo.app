import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_IDLE_MS, TERMINAL_MAX_SESSION_MINUTES } from '../cloudflare_workers/terminal/lib/constants.ts'
import { nextSessionAlarmAtMs, sessionAlarmAtMs, teardownReasonAtAlarm } from '../cloudflare_workers/terminal/lib/security.ts'
import {
  finalizeOrScheduleRetry,
  PENDING_FINISH_RETRY_MS,
  readPendingFinish,
  resolveSessionStartedAtMs,
  type TeardownStorage,
} from '../cloudflare_workers/terminal/lib/teardown.ts'

const pgQueries = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string, params: unknown[] }>,
  rows: [] as unknown[],
}))

vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params: unknown[]) {
      pgQueries.calls.push({ sql, params })
      return { rows: pgQueries.rows }
    }
  },
}))

function memoryStorage() {
  const data = new Map<string, unknown>()
  const alarms: number[] = []
  const storage: TeardownStorage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value)
    },
    setAlarm: async (ms: number) => {
      alarms.push(ms)
    },
  }
  return { storage, alarms }
}

beforeEach(() => {
  pgQueries.calls = []
  pgQueries.rows = []
})

describe('terminal teardown finish retry', () => {
  it('retries a failed DB finish with the original teardown time, not the retry time', async () => {
    const { storage, alarms } = memoryStorage()
    const teardownAt = 1_800_000_000_000
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db still down'))
      .mockResolvedValueOnce({ finalized: true })

    // Teardown: DB write fails, retry is scheduled.
    let now = teardownAt
    expect(await finalizeOrScheduleRetry({ storage, sessionKey: 'k', reason: 'client_end', endedAtMs: teardownAt, finalize, nowMs: () => now })).toBe(false)
    expect(alarms).toEqual([teardownAt + PENDING_FINISH_RETRY_MS])

    // Each alarm retry reads the pending finish (as TerminalSession.alarm does) and sends the stored time.
    for (const attempt of [1, 2]) {
      now = teardownAt + attempt * PENDING_FINISH_RETRY_MS
      const pending = await readPendingFinish(storage)
      expect(pending).toEqual({ reason: 'client_end', endedAtMs: teardownAt })
      await finalizeOrScheduleRetry({ storage, sessionKey: 'k', reason: pending!.reason, endedAtMs: pending!.endedAtMs, finalize, nowMs: () => now })
    }

    expect(finalize).toHaveBeenCalledTimes(3)
    for (const call of finalize.mock.calls)
      expect(call).toEqual(['k', 'client_end', teardownAt])
  })

  it('finalizeTerminalSession sends the teardown time as p_ended_at', async () => {
    const { finalizeTerminalSession } = await import('../cloudflare_workers/terminal/lib/apikey.ts')
    pgQueries.rows = [{ minutes: 5 }]
    const endedAtMs = Date.UTC(2026, 10, 27, 12, 0, 0)

    await finalizeTerminalSession({ connectionString: 'postgres://unused' }, 'k', 'client_end', endedAtMs)

    expect(pgQueries.calls).toHaveLength(1)
    expect(pgQueries.calls[0].sql).toContain('terminal_session_finish($1::text, $2::text, $3::timestamptz)')
    expect(pgQueries.calls[0].params).toEqual(['k', 'client_end', '2026-11-27T12:00:00.000Z'])
  })
})

describe('terminal session clock seeded from the DB reservation', () => {
  it('fires the max duration alarm at reservation started_at + max_duration, not at DO creation + max_duration', () => {
    const dbStartedAtMs = 1_800_000_000_000
    const doCreatedAtMs = dbStartedAtMs + 7 * 60_000
    const startedAtMs = resolveSessionStartedAtMs(dbStartedAtMs, doCreatedAtMs, doCreatedAtMs)
    const expiresAtMs = dbStartedAtMs + TERMINAL_MAX_SESSION_MINUTES * 60_000

    expect(startedAtMs).toBe(dbStartedAtMs)
    expect(sessionAlarmAtMs(startedAtMs, TERMINAL_MAX_SESSION_MINUTES)).toBe(expiresAtMs)
    // Active right before expiry: the next alarm is capped at the DB expiry.
    expect(nextSessionAlarmAtMs(startedAtMs, TERMINAL_MAX_SESSION_MINUTES, TERMINAL_IDLE_MS, expiresAtMs - 60_000)).toBe(expiresAtMs)
    expect(teardownReasonAtAlarm(startedAtMs, TERMINAL_MAX_SESSION_MINUTES, expiresAtMs)).toBe('max_duration_alarm')
  })

  it('falls back to the stored start, then now, without a reservation time', () => {
    expect(resolveSessionStartedAtMs(undefined, 5_000, 9_000)).toBe(5_000)
    expect(resolveSessionStartedAtMs(undefined, 0, 9_000)).toBe(9_000)
    expect(resolveSessionStartedAtMs(Number.NaN, 0, 9_000)).toBe(9_000)
  })

  it('reserveTerminalSession returns the DB started_at from the reservation', async () => {
    const { reserveTerminalSession } = await import('../cloudflare_workers/terminal/lib/apikey.ts')
    pgQueries.rows = [{ result: { ok: true, created: true, reused: false, started_at_ms: '1800000000000' } }]

    const reserved = await reserveTerminalSession({ connectionString: 'postgres://unused' }, {
      sessionKey: 'k',
      orgId: 'o',
      appId: 'a',
      apikeyId: 1,
      maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
      maxConcurrency: 2,
    })

    expect(reserved.startedAtMs).toBe(1_800_000_000_000)
  })

  it('activeTerminalSessionStartedAtMs returns started_at for the WebSocket path, null when inactive', async () => {
    const { activeTerminalSessionStartedAtMs } = await import('../cloudflare_workers/terminal/lib/apikey.ts')
    pgQueries.rows = [{ started_at_ms: '1800000000000' }]
    expect(await activeTerminalSessionStartedAtMs({ connectionString: 'postgres://unused' }, 'k')).toBe(1_800_000_000_000)
    pgQueries.rows = []
    expect(await activeTerminalSessionStartedAtMs({ connectionString: 'postgres://unused' }, 'k')).toBeNull()
  })
})
