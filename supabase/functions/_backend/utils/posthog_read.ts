import type { Context } from 'hono'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv, trimTrailingSlashes } from './utils.ts'

export const MAX_POSTHOG_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_POSTHOG_READ_HOST = 'https://eu.posthog.com'
const DEFAULT_POSTHOG_READ_PROJECT_ID = '22029'

export type PosthogReadFailureReason = 'too_large' | 'unconfigured' | 'timeout' | 'unavailable'

export interface PosthogReadResult {
  configured: boolean
  connected: boolean
  failureReason: PosthogReadFailureReason | null
  rows: Record<string, unknown>[]
}

export interface PosthogReadOptions {
  maxResponseBytes?: number
}

interface PosthogReadConfig {
  key: string
  host: string
  project: string
}

function posthogReadConfig(c: Context): PosthogReadConfig | null {
  const key = getEnv(c, 'POSTHOG_READ_KEY').trim()
  const hostOverride = getEnv(c, 'POSTHOG_READ_HOST').trim()
  const projectOverride = getEnv(c, 'POSTHOG_READ_PROJECT_ID').trim()
  if (!key || Boolean(hostOverride) !== Boolean(projectOverride))
    return null

  const host = trimTrailingSlashes(hostOverride || DEFAULT_POSTHOG_READ_HOST)
  const project = projectOverride || DEFAULT_POSTHOG_READ_PROJECT_ID
  if (!host || !project)
    return null

  return { key, host, project }
}

export function isPosthogReadConfigured(c: Context): boolean {
  return posthogReadConfig(c) !== null
}

async function readBoundedResponse(response: Response, maxResponseBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes)
    return null

  if (!response.body)
    return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    totalBytes += value.byteLength
    if (totalBytes > maxResponseBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function queryPosthogHogql(c: Context, query: string, options: PosthogReadOptions = {}): Promise<PosthogReadResult> {
  const config = posthogReadConfig(c)
  if (!config) {
    return {
      configured: false,
      connected: false,
      failureReason: 'unconfigured',
      rows: [],
    }
  }

  try {
    const response = await fetch(`${config.host}/api/projects/${config.project}/query/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'posthog_query_failed', status: response.status })
      return { configured: true, connected: false, failureReason: 'unavailable', rows: [] }
    }

    const requestedMax = options.maxResponseBytes ?? MAX_POSTHOG_RESPONSE_BYTES
    const maxResponseBytes = Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, MAX_POSTHOG_RESPONSE_BYTES)
      : 0
    const responseBody = await readBoundedResponse(response, maxResponseBytes)
    if (responseBody === null)
      return { configured: true, connected: true, failureReason: 'too_large', rows: [] }

    const json = JSON.parse(responseBody) as { columns?: string[], results?: unknown[][] }
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
