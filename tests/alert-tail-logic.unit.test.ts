import { describe, expect, it } from 'vitest'
import { isAllowedAlertWebhookUrl, redactSensitiveText } from '../cloudflare_workers/alert_tail/redact.ts'
import {
  applyCrossCallThrottle,
  buildSuppressedSummaryAlert,
  hashThrottleStoreKey,
  MemoryThrottleStore,
  parseThrottleSummaryIntervalSec,
  parseThrottleWindowSec,
} from '../cloudflare_workers/alert_tail/throttle_logic.ts'
import {
  capPostBodyAlerts,
  dedupeAlertRecords,
  dedupeKey,
  MAX_BATCH_ALERTS,
  MAX_POST_BODY_BYTES,
  MAX_STACK_CHARS,
  MIN_HTTP_ALERT_STATUS,
  normalizeTailEvent,
  processTailBatch,
  shouldKeepTailEvent,
  stripUrlQuery,
  truncateStack,
  type AlertTailRecord,
} from '../cloudflare_workers/alert_tail/tail_logic.ts'

function sampleRecord(message: string, count = 1): AlertTailRecord {
  return {
    functionName: 'capgo_plugin-na-prod',
    errorName: 'Error',
    message,
    stack: null,
    method: 'POST',
    url: 'https://plugin.na.capgo.app/updates',
    requestId: null,
    timestamp: '2026-10-27T22:00:00.000Z',
    environment: 'capgo_plugin-na-prod',
    userAgent: null,
    body: null,
    count,
  }
}

describe('shouldKeepTailEvent HTTP status filter', () => {
  it.concurrent('drops 404 and 499 without exceptions', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 404 } },
    })).toBe(false)
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 499 } },
    })).toBe(false)
  })

  it.concurrent('keeps exactly HTTP 500', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 500 } },
    })).toBe(true)
  })

  it.concurrent('keeps other 5xx above the minimum threshold', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 502 } },
    })).toBe(true)
  })

  it.concurrent('uses MIN_HTTP_ALERT_STATUS so 4xx never matches the HTTP path', () => {
    expect(MIN_HTTP_ALERT_STATUS).toBe(500)
    expect(404 >= MIN_HTTP_ALERT_STATUS).toBe(false)
    expect(499 >= MIN_HTTP_ALERT_STATUS).toBe(false)
    expect(500 >= MIN_HTTP_ALERT_STATUS).toBe(true)
  })
})

describe('shouldKeepTailEvent worker errors', () => {
  it.concurrent('keeps exception outcomes', () => {
    expect(shouldKeepTailEvent({ outcome: 'exception' })).toBe(true)
    expect(shouldKeepTailEvent({ outcome: 'exceededCpu' })).toBe(true)
    expect(shouldKeepTailEvent({ outcome: 'exceededMemory' })).toBe(true)
  })

  it.concurrent('drops successful responses without exceptions', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 200 } },
    })).toBe(false)
  })

  it.concurrent('keeps events with exception entries even when outcome is ok', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      exceptions: [{ name: 'Error', message: 'boom' }],
    })).toBe(true)
  })
})

describe('processTailBatch batch cap', () => {
  it.concurrent('caps deduped alerts at MAX_BATCH_ALERTS', () => {
    expect(MAX_BATCH_ALERTS).toBe(100)
    const events = Array.from({ length: 150 }, (_, index) => ({
      outcome: 'ok' as const,
      scriptName: 'capgo_api-prod',
      event: { response: { status: 500 } },
      exceptions: [{ name: 'Error', message: `unique-failure-${index}` }],
    }))
    const alerts = processTailBatch(events)
    expect(alerts).toHaveLength(MAX_BATCH_ALERTS)
    expect(alerts.length).toBeLessThan(events.length)
  })
})

describe('normalizeTailEvent', () => {
  it.concurrent('strips query strings from URLs', () => {
    const record = normalizeTailEvent({
      scriptName: 'capgo_plugin-na-prod',
      outcome: 'exception',
      eventTimestamp: Date.parse('2026-10-27T22:00:00.000Z'),
      exceptions: [{
        name: 'Error',
        message: 'Connection terminated unexpectedly',
        stack: 'Error: Connection terminated unexpectedly\n    at pg',
      }],
      event: {
        request: {
          method: 'POST',
          url: 'https://plugin.na.capgo.app/updates?foo=1',
          headers: { 'user-agent': 'Capgo/1.0', 'cf-ray': 'abc123' },
        },
      },
    })

    expect(record).toMatchObject({
      functionName: 'capgo_plugin-na-prod',
      errorName: 'Error',
      message: 'Connection terminated unexpectedly',
      method: 'POST',
      url: 'https://plugin.na.capgo.app/updates',
      requestId: 'abc123',
      userAgent: 'Capgo/1.0',
      body: null,
      count: 1,
    })
    expect(record?.timestamp).toBe('2026-10-27T22:00:00.000Z')
  })

  it.concurrent('redacts emails and tokens in message, stack, url, and user-agent', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxIn0.signature'
    const record = normalizeTailEvent({
      outcome: 'exception',
      exceptions: [{
        name: 'Error',
        message: `failed for user@example.com bearer sk_live_abc apikey=secret123 ${jwt}`,
        stack: `Error: authorization: Bearer tok\n    at mail user@example.com`,
      }],
      event: {
        request: {
          url: 'https://plugin.na.capgo.app/users/user@example.com/updates',
          headers: { 'user-agent': 'Capgo user@example.com' },
        },
      },
    })
    expect(record?.message).not.toContain('user@example.com')
    expect(record?.message).toContain('[redacted-email]')
    expect(record?.url).not.toContain('user@example.com')
    expect(record?.userAgent).not.toContain('user@example.com')
    expect(record?.stack).toContain('[redacted]')
  })

  it.concurrent('truncates stack traces to 4KB', () => {
    const longStack = 'x'.repeat(MAX_STACK_CHARS + 50)
    const record = normalizeTailEvent({
      outcome: 'exception',
      exceptions: [{ name: 'Error', message: 'fail', stack: longStack }],
    })
    expect(record?.stack?.length).toBe(MAX_STACK_CHARS)
  })
})

describe('dedupeAlertRecords', () => {
  it.concurrent('merges duplicate scriptName+errorName+message within a batch', () => {
    const base = sampleRecord('PG Client Error')
    const merged = dedupeAlertRecords([
      { ...base, count: 1 },
      { ...base, count: 1, requestId: 'ray-1' },
      {
        ...sampleRecord('other'),
        functionName: 'capgo_plugin-af-prod',
        environment: 'capgo_plugin-af-prod',
      },
    ])

    expect(merged).toHaveLength(2)
    const na = merged.find(item => item.functionName === 'capgo_plugin-na-prod')
    expect(na?.count).toBe(2)
    expect(na?.requestId).toBe('ray-1')
    expect(dedupeKey(base)).toContain('capgo_plugin-na-prod')
  })
})

describe('processTailBatch', () => {
  it.concurrent('filters, normalizes, and dedupes a mixed batch', () => {
    const alerts = processTailBatch([
      { outcome: 'ok', event: { response: { status: 200 } } },
      {
        scriptName: 'capgo_plugin-hk-prod',
        outcome: 'exception',
        exceptions: [{ name: 'Error', message: 'same' }],
      },
      {
        scriptName: 'capgo_plugin-hk-prod',
        outcome: 'exception',
        exceptions: [{ name: 'Error', message: 'same' }],
      },
    ])

    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.count).toBe(2)
  })
})

describe('capPostBodyAlerts', () => {
  it.concurrent('caps using UTF-8 bytes of the full alerts envelope', () => {
    const cjkStack = '错'.repeat(MAX_STACK_CHARS)
    const alerts = Array.from({ length: 80 }, (_, index) => ({
      ...sampleRecord(`failure-${index}`),
      stack: cjkStack,
    }))

    const capped = capPostBodyAlerts(alerts)
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ alerts: capped })).length
    expect(bodyBytes).toBeLessThanOrEqual(MAX_POST_BODY_BYTES)
    expect(capped.length).toBeGreaterThan(0)
    expect(capped.length).toBeLessThan(alerts.length)
    if (capped.length < alerts.length) {
      const withNext = [...capped, alerts[capped.length]!]
      const nextBytes = new TextEncoder().encode(JSON.stringify({ alerts: withNext })).length
      expect(nextBytes).toBeGreaterThan(MAX_POST_BODY_BYTES)
    }
  })
})

describe('hashThrottleStoreKey', () => {
  it.concurrent('uses a fixed-length hex key under KV limits', async () => {
    const longMessage = 'x'.repeat(2000)
    const key = await hashThrottleStoreKey(`fn\0err\0${longMessage}`)
    expect(key).toHaveLength(64)
    expect(key.length).toBeLessThan(512)
  })
})

describe('applyCrossCallThrottle', () => {
  it.concurrent('sends the first alert per signature then periodic summaries', async () => {
    const store = new MemoryThrottleStore()
    const options = { windowMs: 60_000, summaryIntervalMs: 10_000 }
    const record = sampleRecord('PG timeout')

    const first = await applyCrossCallThrottle([record], store, 0, options)
    expect(first).toHaveLength(1)
    expect(first[0]?.message).toBe('PG timeout')

    const suppressed = await applyCrossCallThrottle([record], store, 2_000, options)
    expect(suppressed).toHaveLength(0)

    const summary = await applyCrossCallThrottle([record], store, 11_000, options)
    expect(summary).toHaveLength(1)
    expect(summary[0]?.errorName).toBe('AlertTailSuppressedSummary')
    expect(summary[0]?.count).toBe(2)
  })

  it.concurrent('flushes suppressed counts when the window rolls over', async () => {
    const store = new MemoryThrottleStore()
    const options = { windowMs: 5_000, summaryIntervalMs: 60_000 }
    const record = sampleRecord('same', 3)

    await applyCrossCallThrottle([record], store, 0, options)
    await applyCrossCallThrottle([record], store, 1_000, options)

    const rolled = await applyCrossCallThrottle([record], store, 6_000, options)
    expect(rolled).toHaveLength(2)
    expect(rolled[0]?.errorName).toBe('AlertTailSuppressedSummary')
    expect(rolled[0]?.count).toBe(3)
    expect(rolled[1]?.message).toBe('same')
  })
})

describe('buildSuppressedSummaryAlert', () => {
  it.concurrent('includes suppressed count in the summary message', () => {
    const summary = buildSuppressedSummaryAlert(recordTemplateFromSample(), 42, Date.parse('2026-10-27T22:00:00.000Z'))
    expect(summary.count).toBe(42)
    expect(summary.message).toContain('42')
  })
})

function recordTemplateFromSample() {
  const record = sampleRecord('disk full')
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

describe('redactSensitiveText and webhook URL policy', () => {
  it.concurrent('redacts common secret patterns including Basic auth', () => {
    const input = 'user@example.com Authorization: Basic dXNlcjpwYXNz apikey=xyz'
    const redacted = redactSensitiveText(input)
    expect(redacted).not.toContain('dXNlcjpwYXNz')
    expect(redacted).not.toContain('user@example.com')
    expect(redacted).toContain('[redacted-email]')
  })

  it.concurrent('allows https webhook URLs only', () => {
    expect(isAllowedAlertWebhookUrl('https://alerts.example.com/ingest')).toBe(true)
    expect(isAllowedAlertWebhookUrl('http://alerts.example.com/ingest')).toBe(false)
    expect(isAllowedAlertWebhookUrl('ftp://alerts.example.com/x')).toBe(false)
    expect(isAllowedAlertWebhookUrl('not-a-url')).toBe(false)
  })
})

describe('parseThrottleWindowSec', () => {
  it.concurrent('falls back to defaults for invalid values', () => {
    expect(parseThrottleWindowSec(undefined)).toBe(300)
    expect(parseThrottleSummaryIntervalSec('0')).toBe(60)
    expect(parseThrottleWindowSec('120')).toBe(120)
  })
})

describe('stripUrlQuery and truncateStack', () => {
  it.concurrent('handles invalid URLs without throwing', () => {
    expect(stripUrlQuery('not-a-url?x=1')).toBe('not-a-url')
    expect(truncateStack(undefined)).toBeNull()
  })
})
