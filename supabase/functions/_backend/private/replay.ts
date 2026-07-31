import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { schema } from '../utils/postgres_schema.ts'
import { capturePosthogReplaySnapshot } from '../utils/posthog.ts'

interface CliReplayBody {
  event?: unknown
  properties?: Record<string, unknown>
  timestamp?: unknown
}

interface ValidatedReplayPayload {
  currentUrl: string
  events: unknown[]
  lib: string
  libVersion: string
  sessionId: string
  snapshotBytes?: number
  timestamp: string
  windowId: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

function readProperties(body: CliReplayBody) {
  if (!body.properties || typeof body.properties !== 'object' || Array.isArray(body.properties))
    throw quickError(400, 'invalid_replay_payload', 'Invalid replay properties')

  return body.properties
}

function readRequiredString(properties: Record<string, unknown>, key: string) {
  const value = properties[key]
  if (typeof value !== 'string' || !value.trim())
    throw quickError(400, 'invalid_replay_payload', `Missing replay property ${key}`)

  return value.trim()
}

function readOptionalString(properties: Record<string, unknown>, key: string, fallback: string) {
  const value = properties[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readSnapshotBytes(properties: Record<string, unknown>) {
  const value = properties.$snapshot_bytes
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function validateReplayBody(body: CliReplayBody): ValidatedReplayPayload {
  if (body.event !== '$snapshot')
    throw quickError(400, 'invalid_replay_event', 'Invalid replay event')

  const properties = readProperties(body)
  const events = properties.$snapshot_data
  if (!Array.isArray(events) || events.length === 0)
    throw quickError(400, 'invalid_replay_payload', 'Missing replay snapshot data')

  return {
    currentUrl: readRequiredString(properties, '$current_url'),
    events,
    lib: readOptionalString(properties, '$lib', '@capgo/cli'),
    libVersion: readOptionalString(properties, '$lib_version', 'unknown'),
    sessionId: readRequiredString(properties, '$session_id'),
    snapshotBytes: readSnapshotBytes(properties),
    timestamp: typeof body.timestamp === 'string' && body.timestamp.trim() ? body.timestamp.trim() : new Date().toISOString(),
    windowId: readRequiredString(properties, '$window_id'),
  }
}

async function getAuthenticatedUserEmail(c: Context<MiddlewareKeyVariables>, userId: string) {
  let pgClient: ReturnType<typeof getPgClient> | null = null
  try {
    pgClient = getPgClient(c, true)
    const drizzle = getDrizzleClient(pgClient)
    const rows = await drizzle
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)

    return rows[0]?.email
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'replay_user_lookup_failed', userId, error: serializeError(error) })
    return undefined
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}

app.post('/', middlewareAuth(), async (c) => {
  const auth = c.get('auth')
  const userId = auth?.userId
  if (!userId)
    throw quickError(401, 'unauthorized', 'Unauthorized')

  const body = await parseBody<CliReplayBody>(c)
  const replay = validateReplayBody(body)
  const userEmail = await getAuthenticatedUserEmail(c, userId)
  if (!userEmail)
    throw quickError(500, 'missing_replay_user_email', 'Could not resolve replay user email')

  const sent = await capturePosthogReplaySnapshot(c, {
    ...replay,
    distinctId: userId,
    userEmail,
    userId,
  })

  if (!sent)
    throw quickError(502, 'posthog_replay_failed', 'Failed to send replay')

  return c.json(BRES)
})
