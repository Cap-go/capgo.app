/**
 * Loads the TerminalSession Durable Object class itself (agents McpAgent base stubbed) and checks
 * the wiring of the two billing/clock fixes:
 * - alarm() retries a failed finish with the saved original teardown time;
 * - onStart() seeds the session clock from the DB reservation started_at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_IDLE_MS, TERMINAL_MAX_SESSION_MINUTES } from '../cloudflare_workers/terminal/lib/constants.ts'

const finalizeMock = vi.hoisted(() => vi.fn())

vi.mock('@cloudflare/sandbox', () => ({
  Files: class {},
}))

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    ctx: unknown
    env: unknown
    props: unknown
    #state: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }

    get state() {
      return this.#state ?? (this as unknown as { initialState: unknown }).initialState
    }

    setState(next: unknown) {
      this.#state = next
    }

    async onStart(props?: unknown) {
      if (props)
        this.props = props
      await (this as unknown as { init: () => Promise<void> }).init()
    }

    broadcast() {}
  },
}))

vi.mock('../cloudflare_workers/terminal/lib/apikey.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudflare_workers/terminal/lib/apikey.ts')>()
  return { ...actual, finalizeTerminalSession: finalizeMock }
})

function fakeCtx() {
  const data = new Map<string, unknown>()
  const alarms: number[] = []
  return {
    alarms,
    data,
    ctx: {
      storage: {
        get: async (key: string) => data.get(key),
        put: async (key: string, value: unknown) => {
          data.set(key, value)
        },
        setAlarm: async (ms: number) => {
          alarms.push(ms)
        },
        deleteAll: async () => {
          data.clear()
        },
      },
    },
  }
}

async function newSession() {
  const { TerminalSession } = await import('../cloudflare_workers/terminal/terminal_session.ts')
  const fake = fakeCtx()
  const env = { HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://unused' } }
  const Ctor = TerminalSession as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof TerminalSession>
  return { session: new Ctor(fake.ctx, env), ...fake }
}

const SESSION = {
  sessionKey: '00000000-0000-4000-8000-000000000001:com.test.do:s1',
  orgId: '00000000-0000-4000-8000-000000000001',
  appId: 'com.test.do',
}

beforeEach(() => {
  vi.useFakeTimers()
  finalizeMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TerminalSession durable object', () => {
  it('alarm() retries a failed finish with the saved original teardown time', async () => {
    const teardownAt = Date.UTC(2026, 10, 27, 12, 0, 0)
    vi.setSystemTime(teardownAt)
    const { session, alarms, data } = await newSession()
    session.props = SESSION
    finalizeMock
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ billedMinutes: 3, finalized: true })

    await session.teardown('client_end')
    expect(alarms.at(-1)).toBe(teardownAt + 30_000)

    vi.setSystemTime(teardownAt + 30_000)
    await session.alarm()

    expect(finalizeMock).toHaveBeenCalledTimes(2)
    expect(finalizeMock.mock.calls[1].slice(1)).toEqual([SESSION.sessionKey, 'client_end', teardownAt])
    expect(data.size).toBe(0)
  })

  it('onStart() seeds the session clock from the reservation started_at', async () => {
    const dbStartedAtMs = Date.UTC(2026, 10, 27, 12, 0, 0)
    // DO wakes 55 minutes after the DB reservation: max expiry is sooner than the idle alarm.
    const now = dbStartedAtMs + 55 * 60_000
    vi.setSystemTime(now)
    const { session, alarms } = await newSession()

    await session.onStart({ ...SESSION, startedAtMs: dbStartedAtMs })

    expect(session.state.startedAtMs).toBe(dbStartedAtMs)
    const expiresAt = dbStartedAtMs + TERMINAL_MAX_SESSION_MINUTES * 60_000
    expect(expiresAt).toBeLessThan(now + TERMINAL_IDLE_MS)
    expect(alarms.at(-1)).toBe(expiresAt)
  })
})
