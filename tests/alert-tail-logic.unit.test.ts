import { describe, expect, it } from 'vitest'
import {
  capPostBodyAlerts,
  dedupeAlertRecords,
  dedupeKey,
  MAX_POST_BODY_BYTES,
  MAX_STACK_CHARS,
  normalizeTailEvent,
  processTailBatch,
  shouldKeepTailEvent,
  stripUrlQuery,
  truncateStack,
} from '../cloudflare_workers/alert_tail/tail_logic.ts'

describe('shouldKeepTailEvent', () => {
  it.concurrent('keeps exception outcomes', () => {
    expect(shouldKeepTailEvent({ outcome: 'exception' })).toBe(true)
    expect(shouldKeepTailEvent({ outcome: 'exceededCpu' })).toBe(true)
    expect(shouldKeepTailEvent({ outcome: 'exceededMemory' })).toBe(true)
  })

  it.concurrent('keeps HTTP 500+ responses', () => {
    expect(shouldKeepTailEvent({
      outcome: 'ok',
      event: { response: { status: 500 } },
    })).toBe(true)
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
    const base = {
      functionName: 'capgo_plugin-oc-prod',
      errorName: 'Error',
      message: 'PG Client Error',
      stack: null,
      method: 'POST',
      url: 'https://plugin.oc.capgo.app/updates',
      requestId: null,
      timestamp: '2026-10-27T22:00:00.000Z',
      environment: 'capgo_plugin-oc-prod',
      userAgent: null,
      body: null as null,
      count: 1,
    }

    const merged = dedupeAlertRecords([
      { ...base, count: 1 },
      { ...base, count: 1, requestId: 'ray-1' },
      {
        ...base,
        functionName: 'capgo_plugin-af-prod',
        environment: 'capgo_plugin-af-prod',
        message: 'other',
        count: 1,
      },
    ])

    expect(merged).toHaveLength(2)
    const oc = merged.find(item => item.functionName === 'capgo_plugin-oc-prod')
    expect(oc?.count).toBe(2)
    expect(oc?.requestId).toBe('ray-1')
    expect(dedupeKey(base)).toContain('capgo_plugin-oc-prod')
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
      functionName: 'capgo_plugin-na-prod',
      errorName: 'Error',
      message: `failure-${index}`,
      stack: cjkStack,
      method: 'POST',
      url: 'https://plugin.na.capgo.app/updates',
      requestId: null,
      timestamp: '2026-10-27T22:00:00.000Z',
      environment: 'capgo_plugin-na-prod',
      userAgent: null,
      body: null as null,
      count: 1,
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

describe('stripUrlQuery and truncateStack', () => {
  it.concurrent('handles invalid URLs without throwing', () => {
    expect(stripUrlQuery('not-a-url?x=1')).toBe('not-a-url')
    expect(truncateStack(undefined)).toBeNull()
  })
})
