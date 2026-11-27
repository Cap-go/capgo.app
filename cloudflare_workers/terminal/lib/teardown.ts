const PENDING_FINISH_STORAGE = 'terminal_pending_finish'
export const PENDING_FINISH_RETRY_MS = 30_000

/** A DB finish that failed and must be retried with the original teardown time. */
export interface PendingFinish {
  reason: string
  endedAtMs: number
}

export interface TeardownStorage {
  get: <T>(key: string) => Promise<T | undefined>
  put: <T>(key: string, value: T) => Promise<void>
  setAlarm: (scheduledTimeMs: number) => Promise<void>
}

export type FinalizeSession = (
  sessionKey: string,
  reason: string,
  endedAtMs: number,
) => Promise<{ finalized: boolean }>

function parsePendingFinish(raw: unknown): PendingFinish | null {
  if (typeof raw !== 'string' || raw.length === 0)
    return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingFinish>
    if (typeof parsed.reason === 'string' && typeof parsed.endedAtMs === 'number' && Number.isFinite(parsed.endedAtMs))
      return { reason: parsed.reason, endedAtMs: parsed.endedAtMs }
  }
  catch {
    // not JSON
  }
  return null
}

export async function readPendingFinish(storage: Pick<TeardownStorage, 'get'>): Promise<PendingFinish | null> {
  return parsePendingFinish(await storage.get<string>(PENDING_FINISH_STORAGE))
}

/**
 * Finishes the DB session with the original teardown time. On failure it stores
 * `{ reason, endedAtMs }` and schedules a retry alarm, so every retry bills up to
 * the original teardown instead of the retry time. Returns true when the DB row is final.
 */
export async function finalizeOrScheduleRetry(input: {
  storage: TeardownStorage
  sessionKey: string
  reason: string
  endedAtMs: number
  finalize: FinalizeSession
  nowMs: () => number
  onError?: (error: unknown) => void
}): Promise<boolean> {
  const { storage, sessionKey, reason, endedAtMs, finalize, nowMs } = input
  let finalized = false
  try {
    finalized = (await finalize(sessionKey, reason, endedAtMs)).finalized
  }
  catch (error) {
    input.onError?.(error)
    finalized = false
  }
  if (!finalized) {
    const pending: PendingFinish = { reason, endedAtMs }
    await storage.put(PENDING_FINISH_STORAGE, JSON.stringify(pending))
    await storage.setAlarm(nowMs() + PENDING_FINISH_RETRY_MS)
  }
  return finalized
}

/**
 * DB `started_at` from the reservation is the source of truth for the session
 * clock (the DB frees the slot at started_at + max_duration). Falls back to the
 * DO's stored start, then to now.
 */
export function resolveSessionStartedAtMs(
  reservationStartedAtMs: unknown,
  storedStartedAtMs: number | undefined,
  nowMs: number,
): number {
  if (typeof reservationStartedAtMs === 'number' && Number.isFinite(reservationStartedAtMs) && reservationStartedAtMs > 0)
    return reservationStartedAtMs
  if (storedStartedAtMs && storedStartedAtMs > 0)
    return storedStartedAtMs
  return nowMs
}
