import type { Context } from 'hono'
import type { Hono } from 'hono/tiny'
import type { MiddlewareKeyVariables } from './hono.ts'
import { createHealthResponder, probe, readEnv, runProbes } from '@openstatus/health'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import { getEnv } from './utils.ts'
import { version as CapgoVersion } from './version.ts'

export type CapgoHealthOptions = {
  /** When true, probe Postgres via read replica routing (plugin worker). */
  databaseReadOnly?: boolean
  /** Resolve the connection string for the database probe (request-scoped). */
  getDatabaseURL?: (c: Context<MiddlewareKeyVariables>, readOnly: boolean) => string
}

export type HealthCtx = Context<MiddlewareKeyVariables>

const workerProbe = probe({
  name: 'worker',
  critical: true,
  run: async () => undefined,
})

const responderCache = new Map<string, ReturnType<typeof createHealthResponder<HealthCtx>>>()

function cacheKey(databaseReadOnly: boolean, databaseUrl: string) {
  return `${databaseReadOnly ? 'ro' : 'rw'}:${databaseUrl}`
}

const DATABASE_PROBE_CONNECT_TIMEOUT_MS = 2000

async function awaitAbortable<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
  onAbort?: () => void,
): Promise<T> {
  return await new Promise((resolve, reject) => {
    const onAbortHandler = () => {
      onAbort?.()
      reject(new Error('aborted'))
    }
    if (signal.aborted) {
      onAbortHandler()
      return
    }
    signal.addEventListener('abort', onAbortHandler, { once: true })
    run()
      .then((value) => {
        signal.removeEventListener('abort', onAbortHandler)
        resolve(value)
      })
      .catch((err) => {
        signal.removeEventListener('abort', onAbortHandler)
        reject(err)
      })
  })
}

/** True when this request has Postgres env vars or Hyperdrive bindings for a DB probe. */
export function hasDatabaseConfig(c: HealthCtx) {
  if (readEnv('SUPABASE_DB_URL') || readEnv('MAIN_SUPABASE_DB_URL'))
    return true
  const env = c.env as Record<string, unknown> | undefined
  if (!env)
    return false
  if (env.HYPERDRIVE_CAPGO_DIRECT_EU)
    return true
  for (const key of Object.keys(env)) {
    if (key.startsWith('HYPERDRIVE_CAPGO_READ_') && env[key])
      return true
  }
  return false
}

/** Run `SELECT 1`; destroy the checked-out client if the OpenStatus probe aborts. */
async function pingDatabase(databaseUrl: string, signal: AbortSignal) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: DATABASE_PROBE_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 1000,
  })
  let client: PoolClient | undefined
  try {
    client = await awaitAbortable(signal, () => pool.connect(), () => {
      void pool.end().catch(() => undefined)
    })
    await awaitAbortable(signal, () => client!.query('SET statement_timeout TO 2000'), () => {
      client?.release(true)
      client = undefined
    })
    if (!client)
      throw new Error('aborted')
    await awaitAbortable(signal, () => client!.query('SELECT 1'), () => {
      client?.release(true)
      client = undefined
    })
  }
  finally {
    if (client)
      client.release()
    await pool.end().catch(() => undefined)
  }
}

function getDatabaseResponder(databaseReadOnly: boolean, databaseUrl: string) {
  const key = cacheKey(databaseReadOnly, databaseUrl)
  let responder = responderCache.get(key)
  if (!responder) {
    responder = createHealthResponder<HealthCtx>({
      deadlineMs: 2500,
      cacheMs: 5000,
      cacheFailuresMs: 2000,
      probes: [
        workerProbe,
        probe({
          name: 'database',
          critical: true,
          run: signal => pingDatabase(databaseUrl, signal),
        }),
      ],
      extend: (_report, c) => ({
        version: CapgoVersion,
        worker: getEnv(c, 'ENV_NAME') || undefined,
      }),
    })
    responderCache.set(key, responder)
  }
  return responder
}

function skippedDatabaseResponder() {
  return createHealthResponder<HealthCtx>({
    cacheMs: 5000,
    probes: [
      workerProbe,
      probe({
        name: 'database',
        critical: true,
        skip: () => true,
        run: async () => undefined,
      }),
    ],
    extend: (_report, ctx) => ({
      version: CapgoVersion,
      worker: getEnv(ctx, 'ENV_NAME') || undefined,
    }),
  })
}

function databaseUrlResolutionFailedResponder() {
  return createHealthResponder<HealthCtx>({
    cacheMs: 0,
    probes: [
      workerProbe,
      probe({
        name: 'database',
        critical: true,
        run: async () => {
          throw new Error('database_url_resolution_failed')
        },
      }),
    ],
    extend: (_report, ctx) => ({
      version: CapgoVersion,
      worker: getEnv(ctx, 'ENV_NAME') || undefined,
    }),
  })
}

/** Process liveness for legacy `/ok` — worker up, always returns 200 when isolate runs. */
export async function runCapgoWorkerLivenessProbe() {
  await runProbes([workerProbe], { timeoutMs: 1000 })
}

/** Build the OpenStatus `/health` response for this Hono request. */
export async function resolveCapgoHealthResponse(
  c: HealthCtx,
  options: CapgoHealthOptions = {},
) {
  const databaseReadOnly = options.databaseReadOnly ?? false

  if (!hasDatabaseConfig(c))
    return skippedDatabaseResponder().toResponse(c, c.req.method)

  let databaseUrl: string
  try {
    if (options.getDatabaseURL) {
      databaseUrl = options.getDatabaseURL(c, databaseReadOnly)
    }
    else {
      databaseUrl = (await import('./pg.ts')).getDatabaseURL(c, databaseReadOnly)
    }
  }
  catch {
    return databaseUrlResolutionFailedResponder().toResponse(c, c.req.method)
  }

  return getDatabaseResponder(databaseReadOnly, databaseUrl).toResponse(c, c.req.method)
}

/** Mount `GET /health` (HEAD is served implicitly by Hono v4). */
export function registerCapgoHealth(
  app: Hono<MiddlewareKeyVariables>,
  options: CapgoHealthOptions = {},
) {
  app.get('/health', async (c) => {
    return resolveCapgoHealthResponse(c as HealthCtx, options)
  })
}

/** Mount `POST /ok` with a worker liveness probe and legacy `{ status: 'ok' }` body. */
export function registerCapgoLivenessPostOk(app: Hono<MiddlewareKeyVariables>) {
  app.post('/ok', async (c) => {
    await runCapgoWorkerLivenessProbe()
    return c.json({ status: 'ok' })
  })
}

const OPENSTATUS_ADMIN_ADDITIVE_KEYS = ['checkedAt', 'checks', 'latencyMs'] as const

/** Run an OpenStatus-bounded admin probe; response body keeps Capgo `status` ok|ko (monitoring contract). */
export async function respondOpenStatusAdminCheck<C extends HealthCtx>(
  c: C,
  options: {
    probeName: string
    deadlineMs?: number
    runAssessment: () => Promise<{ capgoStatus: 'ok' | 'ko', legacyBody: Record<string, unknown>, httpStatus: number }>
    deadlineFallbackAssessment?: () => { capgoStatus: 'ok' | 'ko', legacyBody: Record<string, unknown>, httpStatus: number }
  },
) {
  let assessment: { capgoStatus: 'ok' | 'ko', legacyBody: Record<string, unknown>, httpStatus: number } | undefined
  let assessmentSelectionLocked = false

  const responder = createHealthResponder<C>({
    deadlineMs: options.deadlineMs ?? 10_000,
    cacheMs: 0,
    probes: [
      probe({
        name: options.probeName,
        critical: true,
        run: async () => {
          const result = await options.runAssessment()
          if (assessmentSelectionLocked)
            return
          assessment = result
          if (assessment.capgoStatus === 'ko')
            throw new Error(`${options.probeName}_unhealthy`)
        },
      }),
    ],
    extend: () => ({}),
  })

  const response = await responder.toResponse(c, c.req.method)
  assessmentSelectionLocked = true
  const finalAssessment = assessment ?? options.deadlineFallbackAssessment?.()
  if (!finalAssessment)
    return response

  const openStatusBody = await response.clone().json().catch(() => ({})) as Record<string, unknown>
  const additive: Record<string, unknown> = {}
  for (const key of OPENSTATUS_ADMIN_ADDITIVE_KEYS) {
    if (openStatusBody[key] !== undefined)
      additive[key] = openStatusBody[key]
  }

  const body = {
    ...finalAssessment.legacyBody,
    ...additive,
    status: finalAssessment.capgoStatus,
  }

  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: finalAssessment.httpStatus,
      headers: response.headers,
    })
  }

  return new Response(JSON.stringify(body), {
    status: finalAssessment.httpStatus,
    headers: response.headers,
  })
}
