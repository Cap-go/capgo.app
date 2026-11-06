import { env } from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

interface Config {
  appId: string
  apiKey: string
  prNumber: string
  runNumber: string
  runAttempt: string
}

interface Dependencies {
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  log: (message: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
}

interface Bundle {
  id: number
  name: string
}

// Leave 30 seconds for reporting within the workflow's five-minute step.
const BUDGET_MS = 270_000
const REQUEST_MS = 30_000
const CONCURRENCY = 4
const ATTEMPTS = 3
const PREVIEW_VERSION = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?-pr\.([1-9]\d*)\.([1-9]\d*)\.([1-9]\d*)$/

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs: number) {
    super(`HTTP ${status}${code ? ` (${code})` : ''}`)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an API object')
  return value as Record<string, unknown>
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('PR number, run number and attempt must be positive safe integers')
  return Number(value)
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Invalid bundle/channel id')
  return value
}

function errorMessage(error: unknown): string {
  // Do not print raw network errors or API bodies, which can contain credentials.
  if (error instanceof ApiError)
    return error.message
  if (error instanceof TypeError)
    return 'network failure'
  if (error instanceof SyntaxError)
    return 'invalid JSON response'
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return 'request timed out'
  return error instanceof Error ? error.message : 'Unknown cleanup failure'
}

export async function cleanupPreviewBundles(config: Config, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { fetch, log: console.log, sleep, now: Date.now, ...overrides }
  if (!/^[a-z0-9]+(?:\.[\w-]+)+$/i.test(config.appId) || !config.apiKey.trim())
    throw new Error('APP_ID and CAPGO_TOKEN are required; APP_ID must be a reverse domain')
  const pr = positiveInteger(config.prNumber)
  const run = positiveInteger(config.runNumber)
  const attempt = positiveInteger(config.runAttempt)
  const deadline = deps.now() + BUDGET_MS
  const summary = { scanned: 0, candidates: 0, linked: 0, deleted: 0, protected: 0, absent: 0, failed: 0, unfinished: 0 }

  async function request(path: 'bundle' | 'channel', query: Record<string, string>, version?: string): Promise<unknown> {
    // Missing/empty version means app-wide deletion on this API. Fail before constructing a DELETE.
    if (version !== undefined && (!version.trim() || !PREVIEW_VERSION.test(version)))
      throw new Error('Refusing DELETE with an invalid preview version')
    const method = version === undefined ? 'GET' : 'DELETE'
    const label = `${method} /${path}${version === undefined ? ` page=${query.page ?? 'lookup'}` : ` ${version}`}`
    for (let n = 1; n <= ATTEMPTS; n++) {
      const remaining = deadline - deps.now()
      if (remaining <= 0)
        throw new Error('Cleanup budget exhausted')
      const url = new URL(`https://api.capgo.app/${path}`)
      if (method === 'GET')
        url.search = new URLSearchParams({ app_id: config.appId, ...query }).toString()
      try {
        const response = await deps.fetch(url, {
          method,
          headers: { 'Authorization': config.apiKey, 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(REQUEST_MS, remaining)),
          ...(method === 'DELETE' ? { body: JSON.stringify({ app_id: config.appId, version }) } : {}),
        })
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null)
          const errorCode = body && typeof body === 'object' && 'error' in body ? body.error : undefined
          const code = typeof errorCode === 'string' && /^[a-z_]+$/.test(errorCode) ? errorCode : ''
          const retryAfter = response.headers.get('retry-after')
          const retryAfterMs = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - deps.now()
          throw new ApiError(response.status, code, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0)
        }
        // The request's abort signal also bounds reading the response body.
        return await response.json()
      }
      catch (error) {
        const transient = error instanceof ApiError
          ? [408, 429, 500, 502, 503, 504].includes(error.status)
          : error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        if (!transient || n === ATTEMPTS)
          throw error
        const delay = Math.max(1000 * 2 ** (n - 1), error instanceof ApiError ? error.retryAfterMs : 0)
        deps.log(`${label}: ${errorMessage(error)}; retry ${n + 1}/${ATTEMPTS} in ${delay}ms`)
        if (deps.now() + delay >= deadline)
          throw new Error('Cleanup budget cannot accommodate retry')
        await deps.sleep(delay)
      }
    }
    throw new Error('Request attempts exhausted')
  }

  async function list(path: 'bundle' | 'channel', visit: (row: Record<string, unknown>) => void) {
    const seen = new Set<number>()
    // The existing API has fixed-size, zero-based pages. Read through the empty page,
    // rather than depending on a response wrapper or hard-coding its current page size.
    for (let page = 0; ; page++) {
      const rows = await request(path, { page: String(page) })
      if (!Array.isArray(rows))
        throw new Error(`GET /${path}: expected an array`)
      if (!rows.length)
        return
      const before = seen.size
      for (const value of rows) {
        const row = object(value)
        if (row.app_id !== config.appId)
          throw new Error(`GET /${path}: unexpected app_id`)
        const rowId = id(row.id)
        if (!seen.has(rowId)) {
          visit(row)
          seen.add(rowId)
        }
      }
      if (seen.size === before)
        throw new Error(`GET /${path}: pagination made no progress`)
      deps.log(`Listed /${path} page=${page}: ${rows.length} rows`)
    }
  }

  const candidates = new Map<string, Bundle>()
  // Snapshot every candidate before mutations: soft deletion changes page offsets.
  await list('bundle', (row) => {
    summary.scanned++
    if (typeof row.name !== 'string' || !row.name.trim() || typeof row.deleted !== 'boolean')
      throw new Error('GET /bundle: invalid version name/deleted flag')
    const match = PREVIEW_VERSION.exec(row.name)
    if (!match || row.deleted)
      return
    const [, prText, runText, attemptText] = match
    const [bundlePr, bundleRun, bundleAttempt] = [prText!, runText!, attemptText!].map(positiveInteger)
    if (bundlePr === pr && (bundleRun < run || (bundleRun === run && bundleAttempt < attempt)))
      candidates.set(row.name, { id: id(row.id), name: row.name })
  })
  async function linkedChannelVersions() {
    const linked = new Set<number>()
    await list('channel', (row) => {
      if (row.version !== null)
        linked.add(id(object(row.version).id))
      if (row.rollout_version !== null)
        linked.add(id(row.rollout_version))
    })
    return linked
  }
  const linked = await linkedChannelVersions()
  const selected = [...candidates.values()].filter((bundle) => {
    if (!linked.has(bundle.id))
      return true
    summary.linked++
    return false
  })
  summary.candidates = selected.length
  deps.log(`Snapshot: scanned=${summary.scanned}, linked=${summary.linked}, candidates=${selected.length}`)
  async function deleteBundle(bundle: Bundle) {
    try {
      const result = object(await request('bundle', {}, bundle.name))
      if (result.status !== 'ok')
        throw new Error('DELETE /bundle: expected status=ok')
      summary.deleted++
      deps.log(`Deleted ${bundle.name}`)
    }
    catch (error) {
      if (error instanceof ApiError && error.code === 'cannot_delete_linked_version') {
        // The existing server guard can also reject links added after our recheck.
        summary.protected++
        deps.log(`Preserved ${bundle.name}: ${errorMessage(error)}`)
        return
      }
      // A DELETE may commit before its response is lost. A retry then reports missing.
      if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) || (error instanceof ApiError && error.code === 'cannot_delete_version')) {
        try {
          const rows = await request('bundle', { version: bundle.name })
          if (Array.isArray(rows) && rows.length === 0) {
            summary.absent++
            deps.log(`Confirmed absent ${bundle.name} after ${errorMessage(error)}`)
            return
          }
        }
        catch (lookupError) {
          deps.log(`Cannot confirm absence of ${bundle.name}: ${errorMessage(lookupError)}`)
        }
      }
      summary.failed++
      deps.log(`Failed ${bundle.name}: ${errorMessage(error)}`)
    }
  }
  let next = 0
  while (next < selected.length && deps.now() < deadline) {
    // Recheck every channel page before each batch. The server's fallback guard
    // has a row cap, so it cannot replace this complete, fresh inventory.
    const currentLinks = await linkedChannelVersions()
    const batch = selected.slice(next, next + CONCURRENCY)
    next += batch.length
    await Promise.all(batch.map(async (bundle) => {
      if (currentLinks.has(bundle.id)) {
        summary.protected++
        deps.log(`Preserved ${bundle.name}: linked since snapshot`)
        return
      }
      await deleteBundle(bundle)
    }))
  }
  summary.unfinished = selected.length - next
  deps.log(`Cleanup summary: ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(', ')}`)
  if (summary.failed || summary.unfinished)
    throw new Error(`Preview cleanup incomplete: ${summary.failed} failed, ${summary.unfinished} unfinished`)
  return summary
}

if (import.meta.main) {
  cleanupPreviewBundles({
    appId: env.APP_ID ?? '',
    apiKey: env.CAPGO_TOKEN ?? '',
    prNumber: env.PR_NUMBER ?? '',
    runNumber: env.GITHUB_RUN_NUMBER ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
  }).catch((error) => {
    console.error(`PR preview cleanup failed: ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
