import type { Context } from 'hono'
import type { Hono } from 'hono/tiny'
import type { MiddlewareKeyVariables } from './hono.ts'
import { createHealthResponder, probe, readEnv } from '@openstatus/health'
import { Pool } from 'pg'
import { getEnv } from './utils.ts'
import { version as CapgoVersion } from './version.ts'

export type CapgoHealthOptions = {
  /** When true, probe Postgres via read replica routing (plugin worker). */
  databaseReadOnly?: boolean
  /** Resolve the connection string for the database probe (request-scoped). */
  getDatabaseURL?: (c: Context<MiddlewareKeyVariables>, readOnly: boolean) => string
}

type HealthCtx = Context<MiddlewareKeyVariables>

const responderCache = new Map<string, ReturnType<typeof createHealthResponder<HealthCtx>>>()

function cacheKey(databaseReadOnly: boolean, databaseUrl: string) {
  return `${databaseReadOnly ? 'ro' : 'rw'}:${databaseUrl}`
}

function hasDatabaseConfig(c: HealthCtx) {
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

async function pingDatabase(databaseUrl: string, signal: AbortSignal) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
  })
  try {
    const query = pool.query('SELECT 1')
    if (signal.aborted)
      throw new Error('aborted')
    signal.addEventListener('abort', () => {
      void pool.end().catch(() => undefined)
    }, { once: true })
    await query
  }
  finally {
    await pool.end().catch(() => undefined)
  }
}

function getResponder(databaseReadOnly: boolean, databaseUrl: string) {
  const key = cacheKey(databaseReadOnly, databaseUrl)
  let responder = responderCache.get(key)
  if (!responder) {
    responder = createHealthResponder<HealthCtx>({
      deadlineMs: 2500,
      cacheMs: 5000,
      cacheFailuresMs: 2000,
      probes: [
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

export function registerCapgoHealth(
  app: Hono<MiddlewareKeyVariables>,
  options: CapgoHealthOptions = {},
) {
  const databaseReadOnly = options.databaseReadOnly ?? false

  app.on(['GET', 'HEAD'], '/health', async (c) => {
    const healthCtx = c as HealthCtx
    if (!hasDatabaseConfig(healthCtx))
      return skippedDatabaseResponder().toResponse(healthCtx, c.req.method)

    let databaseUrl: string
    try {
      if (options.getDatabaseURL) {
        databaseUrl = options.getDatabaseURL(healthCtx, databaseReadOnly)
      }
      else {
        databaseUrl = (await import('./pg.ts')).getDatabaseURL(healthCtx, databaseReadOnly)
      }
    }
    catch {
      return skippedDatabaseResponder().toResponse(healthCtx, c.req.method)
    }

    const responder = getResponder(databaseReadOnly, databaseUrl)
    return responder.toResponse(healthCtx, c.req.method)
  })
}
