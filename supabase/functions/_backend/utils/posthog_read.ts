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
    const response = await fetch(`${host}/api/projects/${project}/query/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_failed', status: response.status })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }

    const json = await response.json() as { columns?: string[], results?: unknown[][] }
    const columns = json.columns ?? []
    const rows = (json.results ?? []).map((result) => {
      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        row[column] = result[index]
      })
      return row
    })
    return { configured: true, connected: true, failureReason: null, rows }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_error', error: serializeError(error) })
    const name = error instanceof Error ? error.name : ''
    const failureReason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable'
    return { configured: true, connected: false, failureReason, rows: [] }
  }
}
