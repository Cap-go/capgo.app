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

  const host = ((getEnv(c, 'POSTHOG_READ_HOST') || 'https://eu.posthog.com').trim()).replace(/\/$/, '')
  const project = (getEnv(c, 'POSTHOG_READ_PROJECT_ID') || '22029').trim()
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
    const json = await res.json() as { columns?: string[], results?: unknown[][] }
    const cols = json.columns ?? []
    const rows = (json.results ?? []).map((row) => {
      const result: Record<string, unknown> = {}
      cols.forEach((column, index) => { result[column] = row[index] })
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
