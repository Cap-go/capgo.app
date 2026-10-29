import { redactOptionalText, redactSensitiveText } from './redact.ts'

export const MAX_STACK_CHARS = 4096
export const MAX_BATCH_ALERTS = 100
export const MAX_POST_BODY_BYTES = 256 * 1024
/** HTTP status alerts use status >= this value (5xx only, not 4xx). */
export const MIN_HTTP_ALERT_STATUS = 500

export type TailException = {
  name?: string
  message?: unknown
  stack?: string
}

export type TailRequest = {
  url?: string
  method?: string
  headers?: Record<string, string> | Headers
  cf?: { rayId?: string }
}

export type TailTraceEvent = {
  scriptName?: string
  outcome?: string
  exceptions?: TailException[]
  eventTimestamp?: number
  event?: {
    request?: TailRequest
    response?: { status?: number }
  }
}

export type AlertTailRecord = {
  functionName: string
  errorName: string
  message: string
  stack: string | null
  method: string | null
  url: string | null
  requestId: string | null
  timestamp: string
  environment: string
  userAgent: string | null
  body: null
  count: number
}

const ERROR_OUTCOMES = new Set(['exception', 'exceededCpu', 'exceededMemory'])

function getHeaderFromRequest(
  request: TailRequest | undefined,
  name: string,
): string | null {
  if (!request?.headers)
    return null
  const lower = name.toLowerCase()
  if (request.headers instanceof Headers) {
    return request.headers.get(name) ?? request.headers.get(lower)
  }
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === lower)
      return value
  }
  return null
}

export function stripUrlQuery(rawUrl: string | undefined | null): string | null {
  if (!rawUrl)
    return null
  try {
    const parsed = new URL(rawUrl)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  }
  catch {
    const q = rawUrl.indexOf('?')
    return q === -1 ? rawUrl : rawUrl.slice(0, q)
  }
}

export function truncateStack(stack: string | undefined | null): string | null {
  if (!stack)
    return null
  if (stack.length <= MAX_STACK_CHARS)
    return stack
  return stack.slice(0, MAX_STACK_CHARS)
}

function stringifyMessage(message: unknown): string {
  if (message === null || message === undefined)
    return ''
  if (typeof message === 'string')
    return message
  try {
    return JSON.stringify(message)
  }
  catch {
    return String(message)
  }
}

export function shouldKeepTailEvent(event: TailTraceEvent): boolean {
  const outcome = event.outcome ?? ''
  if (ERROR_OUTCOMES.has(outcome))
    return true
  if ((event.exceptions?.length ?? 0) > 0)
    return true
  const status = event.event?.response?.status
  if (typeof status === 'number' && status >= MIN_HTTP_ALERT_STATUS)
    return true
  return false
}

function resolveErrorName(event: TailTraceEvent): string {
  const first = event.exceptions?.[0]
  if (first?.name)
    return first.name
  if (event.outcome && ERROR_OUTCOMES.has(event.outcome))
    return event.outcome
  const status = event.event?.response?.status
  if (typeof status === 'number' && status >= MIN_HTTP_ALERT_STATUS)
    return `HTTP_${status}`
  return 'WorkerError'
}

function resolveMessage(event: TailTraceEvent): string {
  const first = event.exceptions?.[0]
  if (first?.message !== undefined && first.message !== null && stringifyMessage(first.message) !== '')
    return stringifyMessage(first.message)
  const status = event.event?.response?.status
  if (typeof status === 'number' && status >= MIN_HTTP_ALERT_STATUS)
    return `HTTP response status ${status}`
  if (event.outcome && ERROR_OUTCOMES.has(event.outcome))
    return `Worker outcome ${event.outcome}`
  return 'Worker error'
}

function resolveRequestId(event: TailTraceEvent): string | null {
  const ray = event.event?.request?.cf?.rayId
  if (ray)
    return ray
  return getHeaderFromRequest(event.event?.request, 'cf-ray')
    ?? getHeaderFromRequest(event.event?.request, 'x-request-id')
    ?? getHeaderFromRequest(event.event?.request, 'request-id')
}

export function normalizeTailEvent(event: TailTraceEvent): AlertTailRecord | null {
  if (!shouldKeepTailEvent(event))
    return null

  const functionName = event.scriptName ?? 'unknown'
  const first = event.exceptions?.[0]
  const tsMs = event.eventTimestamp ?? Date.now()

  const message = redactSensitiveText(resolveMessage(event))
  const stackRaw = truncateStack(first?.stack ?? null)

  const rawUrl = stripUrlQuery(event.event?.request?.url)
  const rawUserAgent = getHeaderFromRequest(event.event?.request, 'user-agent')

  return {
    functionName,
    errorName: resolveErrorName(event),
    message,
    stack: stackRaw ? redactSensitiveText(stackRaw) : null,
    method: event.event?.request?.method ?? null,
    url: redactOptionalText(rawUrl),
    requestId: redactOptionalText(resolveRequestId(event)),
    timestamp: new Date(tsMs).toISOString(),
    environment: functionName,
    userAgent: redactOptionalText(rawUserAgent),
    body: null,
    count: 1,
  }
}

export function dedupeKey(record: Pick<AlertTailRecord, 'functionName' | 'errorName' | 'message'>): string {
  return `${record.functionName}\0${record.errorName}\0${record.message}`
}

export function dedupeAlertRecords(records: AlertTailRecord[]): AlertTailRecord[] {
  const merged = new Map<string, AlertTailRecord>()
  for (const record of records) {
    const key = dedupeKey(record)
    const existing = merged.get(key)
    if (existing) {
      existing.count += record.count
      if (!existing.requestId && record.requestId)
        existing.requestId = record.requestId
      continue
    }
    merged.set(key, { ...record })
  }
  return [...merged.values()]
}

export function processTailBatch(events: TailTraceEvent[]): AlertTailRecord[] {
  const normalized: AlertTailRecord[] = []
  for (const event of events) {
    const record = normalizeTailEvent(event)
    if (record)
      normalized.push(record)
  }
  const deduped = dedupeAlertRecords(normalized)
  return deduped.slice(0, MAX_BATCH_ALERTS)
}

export function capPostBodyAlerts(alerts: AlertTailRecord[]): AlertTailRecord[] {
  const encoder = new TextEncoder()
  const capped: AlertTailRecord[] = []
  for (const alert of alerts) {
    const candidate = [...capped, alert]
    const body = JSON.stringify({ alerts: candidate })
    if (encoder.encode(body).length > MAX_POST_BODY_BYTES)
      break
    capped.push(alert)
  }
  return capped
}
