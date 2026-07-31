import type { Context } from 'hono'
import type { SimpleErrorResponse } from './hono.ts'
import { DrizzleError, entityKind, TransactionRollbackError } from 'drizzle-orm'
import { sendDiscordAlert500 } from './discord.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { capturePosthogException } from './posthog.ts'
import { backgroundTask } from './utils.ts'

const drizzleErrorNames = new Set(['DrizzleError', 'DrizzleQueryError', 'TransactionRollbackError'])
const filesUploadFunctionNames = new Set(['files', 'TUS handler'])
const queueRetryHeaderNames = {
  maxReads: 'x-capgo-queue-max-reads',
  name: 'x-capgo-queue-name',
  readCount: 'x-capgo-queue-read-count',
}
const sensitiveRequestBodyKeys = new Set([
  'captchaToken',
  'captcha_token',
  'invite_magic_string',
  'magic_invite_string',
  'password',
])

function redactSensitiveRequestBody(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(redactSensitiveRequestBody)

  if (!value || typeof value !== 'object')
    return value

  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
    key,
    sensitiveRequestBodyKeys.has(key) ? '[redacted]' : redactSensitiveRequestBody(entryValue),
  ]))
}

function isFilesDurableObjectStorageTimeout(functionName: string, error: unknown): boolean {
  if (!filesUploadFunctionNames.has(functionName) || !error || typeof error !== 'object' || !('message' in error))
    return false

  const { message } = error as { message?: unknown }
  if (typeof message !== 'string')
    return false

  const normalizedMessage = message.toLowerCase()
  return normalizedMessage.includes('storage operation exceeded timeout')
    && normalizedMessage.includes('object to be reset')
}

function readRequestHeader(c: Context, name: string): string | undefined {
  const fromHono = c.req.header?.(name)
  if (fromHono)
    return fromHono
  return c.req.raw.headers.get(name) ?? undefined
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value)
    return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0)
    return null
  return parsed
}

function shouldSuppressQueueRetryAlert(c: Context): boolean {
  const queueName = readRequestHeader(c, queueRetryHeaderNames.name)
  const readCount = parsePositiveInteger(readRequestHeader(c, queueRetryHeaderNames.readCount))
  const maxReads = parsePositiveInteger(readRequestHeader(c, queueRetryHeaderNames.maxReads))
  return Boolean(queueName) && readCount !== null && maxReads !== null && readCount < maxReads
}

export function onError(functionName: string) {
  return async (e: any, c: Context) => {
    let body = 'N/A'
    const rawReq = c.req.raw
    const method = c.req.method.toUpperCase()
    const shouldReadBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
    if (shouldReadBody) {
      try {
        if (rawReq?.bodyUsed) {
          body = 'Body already consumed'
        }
        else {
          const textBody = await rawReq?.clone().text()
          if (textBody) {
            try {
              body = JSON.stringify(redactSensitiveRequestBody(JSON.parse(textBody)))
            }
            catch {
              body = textBody
            }
          }
          else {
            body = '(empty body)'
          }
        }
        if (body.length > 1000) {
          body = `${body.substring(0, 1000)}... (truncated)`
        }
      }
      catch (failToReadBody) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'failToReadBody', failToReadBody })
        body = `Failed to read body (${JSON.stringify(failToReadBody)})`
      }
    }

    // const safeCause = e ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : undefined
    const defaultResponse: SimpleErrorResponse = {
      error: 'unknown_error',
      message: 'Unknown error',
      // cause: safeCause,
      moreInfo: {},
    }

    const isHttpException = e && typeof e === 'object' && typeof e.status === 'number' && typeof e.getResponse === 'function'
    // DrizzleError detection: check for known Drizzle error classes or entityKind
    const isDrizzleError
      = e instanceof DrizzleError
        || e instanceof TransactionRollbackError
        || (typeof e === 'object' && e !== null && ((
          typeof (e as any)[entityKind] === 'string' && drizzleErrorNames.has((e as any)[entityKind])
        ) || (
          typeof (e as any).name === 'string' && drizzleErrorNames.has((e as any).name)
        )))

    if (isHttpException) {
      // Extract error details from the cause (set by quickError)
      let res: SimpleErrorResponse = defaultResponse
      try {
        // First try to get details from cause (new approach from quickError)
        if (e.cause && typeof e.cause === 'object' && 'error' in e.cause) {
          const causeData = e.cause as any
          res = {
            error: typeof causeData.error === 'string' ? causeData.error : 'unknown_error',
            message: typeof causeData.message === 'string' ? causeData.message : e.message || 'Unknown error',
            moreInfo: causeData.moreInfo ?? {},
          }
        }
        // Fallback: try parsing response body (for backward compatibility)
        else if (e.res) {
          const parsed = await e.getResponse().json()
          res = {
            error: typeof parsed?.error === 'string' ? parsed.error : 'unknown_error',
            message: typeof parsed?.message === 'string' ? parsed.message : 'Unknown error',
            moreInfo: parsed?.moreInfo ?? (typeof parsed === 'object' ? parsed : {}),
          }
        }
      }
      catch {
        // ignore errors; fall back to default
      }
      // Single, structured error log entry
      cloudlogErr({
        requestId: c.get('requestId'),
        functionName,
        kind: 'http_exception',
        method: c.req.method,
        url: c.req.url,
        status: e.status,
        errorCode: res.error,
        errorMessage: res.message,
        moreInfo: res.moreInfo,
        stack: serializeError(e)?.stack ?? 'N/A',
      })
      const suppressDiscordAlert = e.cause
        && typeof e.cause === 'object'
        && (e.cause as { suppressDiscordAlert?: unknown }).suppressDiscordAlert === true
      const suppressBackendAlert = suppressDiscordAlert || shouldSuppressQueueRetryAlert(c)
      if (e.status === 429) {
        // Set rate-limit headers from moreInfo when available, but DO NOT
        // overwrite the response body. Several distinct conditions reach this
        // branch — `too_many_requests` from simpleRateLimit (IP failed-auth,
        // API-key flood), `native_build_concurrency_limit_exceeded` from
        // reserveNativeBuildSlot, and others — and collapsing them to a
        // generic "You are being rate limited" string strips the actual
        // errorCode/message/moreInfo (activeBuilds, limit, planName, reason,
        // …) that callers need to react correctly. Fall through to
        // `return c.json(res, e.status)` below so the thrower's real error
        // payload is preserved.
        const rateLimitResetAt = typeof res.moreInfo?.rateLimitResetAt === 'number' ? res.moreInfo.rateLimitResetAt : undefined
        let retryAfterSeconds = typeof res.moreInfo?.retryAfterSeconds === 'number' ? res.moreInfo.retryAfterSeconds : undefined
        if (typeof rateLimitResetAt === 'number' && Number.isFinite(rateLimitResetAt) && !(typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds))) {
          retryAfterSeconds = Math.max(0, Math.ceil((rateLimitResetAt - Date.now()) / 1000))
        }
        if (typeof rateLimitResetAt === 'number' && Number.isFinite(rateLimitResetAt)) {
          c.header('X-RateLimit-Reset', String(Math.ceil(rateLimitResetAt / 1000)))
        }
        if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
          c.header('Retry-After', String(Math.max(0, Math.floor(retryAfterSeconds))))
        }
      }
      if (e.status >= 500 && !suppressBackendAlert) {
        await backgroundTask(c, sendDiscordAlert500(c, functionName, body, e))
        void backgroundTask(c, capturePosthogException(c, {
          error: e,
          functionName,
          kind: 'http_exception',
          status: e.status,
        }))
      }
      return c.json(res, e.status)
    }
    if (isDrizzleError) {
      // Log Drizzle errors with more detailed information
      cloudlogErr({
        requestId: c.get('requestId'),
        functionName,
        kind: 'drizzle_error',
        method: c.req.method,
        url: c.req.url,
        errorMessage: e?.message ?? 'Unknown error',
        stack: serializeError(e)?.stack ?? 'N/A',
        moreInfo: {
          drizzleErrorCause: serializeError((e as Error).cause),
        },
      })
      await backgroundTask(c, sendDiscordAlert500(c, functionName, body, e))
      void backgroundTask(c, capturePosthogException(c, {
        error: e,
        functionName,
        kind: 'drizzle_error',
        status: 500,
      }))
      return c.json(defaultResponse, 500)
    }
    // Non-HTTP errors: log with stack and return 500
    const suppressQueueRetryAlert = shouldSuppressQueueRetryAlert(c)
    const suppressDiscordAlert = suppressQueueRetryAlert || isFilesDurableObjectStorageTimeout(functionName, e)
    cloudlogErr({
      requestId: c.get('requestId'),
      functionName,
      kind: 'unhandled_error',
      method: c.req.method,
      url: c.req.url,
      errorMessage: e?.message ?? 'Unknown error',
      stack: serializeError(e)?.stack ?? 'N/A',
    })
    if (!suppressDiscordAlert)
      await backgroundTask(c, sendDiscordAlert500(c, functionName, body, e))

    if (!suppressQueueRetryAlert) {
      void backgroundTask(c, capturePosthogException(c, {
        error: e,
        functionName,
        kind: 'unhandled_error',
        status: 500,
      }))
    }
    return c.json(defaultResponse, 500)
  }
}
