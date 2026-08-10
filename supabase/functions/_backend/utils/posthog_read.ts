import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

export type PosthogReadFailureReason = 'unconfigured' | 'timeout' | 'unavailable'

export interface PosthogReadResult {
  configured: boolean
  connected: boolean
  failureReason: PosthogReadFailureReason | null
  rows: Record<string, unknown>[]
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function isHogqlResponse(value: unknown): value is { columns: string[], results: unknown[][] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const { columns, results } = value as { columns?: unknown, results?: unknown }
  return Array.isArray(columns)
    && columns.every(column => typeof column === 'string')
    && Array.isArray(results)
    && results.every(row => Array.isArray(row) && row.length === columns.length)
}

export async function queryPosthogHogql(c: Context, query: string): Promise<PosthogReadResult> {
  const key = (getEnv(c, 'POSTHOG_READ_KEY') || '').trim()
  if (!key) {
    return {
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    }
  }

  const host = ((getEnv(c, 'POSTHOG_READ_HOST') || '').trim() || 'https://eu.posthog.com').replace(/\/+$/, '')
  const project = (getEnv(c, 'POSTHOG_READ_PROJECT_ID') || '').trim() || '22029'
  try {
    const res = await fetch(`${host}/api/projects/${project}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_failed', status: res.status })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }
    const json = await res.json() as unknown
    if (!isHogqlResponse(json)) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_invalid_response' })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }
    const rows = json.results.map((row) => {
      const result: Record<string, unknown> = {}
      json.columns.forEach((column, index) => { result[column] = row[index] })
      return result
    })
    return { configured: true, connected: true, failureReason: null, rows }
  }
  catch (error) {
    const failureReason = isTimeoutError(error) ? 'timeout' : 'unavailable'
    cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_error', error: serializeError(error), failureReason })
    return { configured: true, connected: false, failureReason, rows: [] }
  }
}
