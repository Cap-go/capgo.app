import type { AlertTailRecord } from './tail_logic.ts'
import { dedupeKey } from './tail_logic.ts'

export const DEFAULT_THROTTLE_WINDOW_SEC = 300
export const DEFAULT_THROTTLE_SUMMARY_INTERVAL_SEC = 60

export type ThrottleState = {
  windowStartMs: number
  lastSummaryMs: number
  suppressed: number
  template: AlertTailTemplate
}

export type AlertTailTemplate = Pick<
  AlertTailRecord,
  'functionName' | 'errorName' | 'message' | 'stack' | 'method' | 'url' | 'environment' | 'userAgent'
>

export type ThrottleOptions = {
  windowMs: number
  summaryIntervalMs: number
}

export type ThrottleStore = {
  get: (key: string) => Promise<ThrottleState | null>
  put: (key: string, state: ThrottleState) => Promise<void>
}

export function recordTemplate(record: AlertTailRecord): AlertTailTemplate {
  return {
    functionName: record.functionName,
    errorName: record.errorName,
    message: record.message,
    stack: record.stack,
    method: record.method,
    url: record.url,
    environment: record.environment,
    userAgent: record.userAgent,
  }
}

export function buildSuppressedSummaryAlert(
  template: AlertTailTemplate,
  suppressedCount: number,
  timestampMs: number,
): AlertTailRecord {
  return {
    ...template,
    errorName: 'AlertTailSuppressedSummary',
    message: `[alert tail] suppressed ${suppressedCount} similar alert(s): ${template.message}`,
    requestId: null,
    timestamp: new Date(timestampMs).toISOString(),
    body: null,
    count: suppressedCount,
  }
}

function shouldEmitPeriodicSummary(state: ThrottleState, nowMs: number, summaryIntervalMs: number): boolean {
  return state.suppressed > 0 && nowMs - state.lastSummaryMs >= summaryIntervalMs
}

export async function hashThrottleStoreKey(dedupeKeyStr: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dedupeKeyStr))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function applyCrossCallThrottle(
  records: AlertTailRecord[],
  store: ThrottleStore,
  nowMs: number,
  options: ThrottleOptions,
): Promise<AlertTailRecord[]> {
  const { windowMs, summaryIntervalMs } = options
  const toSend: AlertTailRecord[] = []

  for (const record of records) {
    const key = await hashThrottleStoreKey(dedupeKey(record))
    const existing = await store.get(key)
    const windowExpired = !existing || nowMs >= existing.windowStartMs + windowMs

    if (windowExpired) {
      if (existing && existing.suppressed > 0)
        toSend.push(buildSuppressedSummaryAlert(existing.template, existing.suppressed, nowMs))

      toSend.push(record)
      await store.put(key, {
        windowStartMs: nowMs,
        lastSummaryMs: nowMs,
        suppressed: 0,
        template: recordTemplate(record),
      })
      continue
    }

    const next: ThrottleState = {
      ...existing,
      suppressed: existing.suppressed + record.count,
    }

    if (shouldEmitPeriodicSummary(next, nowMs, summaryIntervalMs)) {
      toSend.push(buildSuppressedSummaryAlert(next.template, next.suppressed, nowMs))
      next.suppressed = 0
      next.lastSummaryMs = nowMs
    }

    await store.put(key, next)
  }

  return toSend
}

export function parseThrottleWindowSec(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_THROTTLE_WINDOW_SEC
  return parsed
}

export function parseThrottleSummaryIntervalSec(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_THROTTLE_SUMMARY_INTERVAL_SEC
  return parsed
}

export class MemoryThrottleStore implements ThrottleStore {
  private readonly map = new Map<string, ThrottleState>()

  async get(key: string): Promise<ThrottleState | null> {
    return this.map.get(key) ?? null
  }

  async put(key: string, state: ThrottleState): Promise<void> {
    this.map.set(key, state)
  }
}
