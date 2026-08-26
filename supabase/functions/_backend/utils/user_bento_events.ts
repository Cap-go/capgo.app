import type { Context } from 'hono'
import { isBentoConfigured, trackBentoEvents } from './bento.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { backgroundTask } from './utils.ts'

export type TelemetryValue = string | number | boolean
type UserBentoDetails = Record<string, TelemetryValue>

type DetailField
  = | { key: string, type: 'boolean' }
    | { key: string, type: 'integer', min: number, max: number }
    | { key: string, type: 'string', maxLength: number }
    | { key: string, type: 'uuid' }

interface UserBentoEventMapping {
  bentoEvent: UserBentoEventName
  delivery: 'every' | 'once'
  fields: readonly DetailField[]
}

export const USER_BENTO_EVENT_NAMES = [
  'cli:command_invoked',
  'cli:login_successful',
  'cli:onboarding_run_started',
  'onboarding:resume_restarted',
  'onboarding:step_completed',
  'user:login',
] as const

export type UserBentoEventName = typeof USER_BENTO_EVENT_NAMES[number]

const USER_BENTO_EVENT_REGISTRY = {
  'CLI Command Invoked': {
    bentoEvent: 'cli:command_invoked',
    delivery: 'once',
    fields: [
      { key: 'command_path', type: 'string', maxLength: 128 },
      { key: 'flags', type: 'string', maxLength: 512 },
      { key: 'flags_count', type: 'integer', min: 0, max: 128 },
      { key: 'positional_arg_count', type: 'integer', min: 0, max: 128 },
    ],
  },
  'User CLI login': {
    bentoEvent: 'cli:login_successful',
    delivery: 'once',
    fields: [],
  },
  'User Login': {
    bentoEvent: 'user:login',
    delivery: 'every',
    fields: [],
  },
  'onboarding-run-started': {
    bentoEvent: 'cli:onboarding_run_started',
    delivery: 'once',
    fields: [
      { key: 'onboarding_event_version', type: 'integer', min: 1, max: 100 },
      { key: 'onboarding_journey_id', type: 'string', maxLength: 80 },
      { key: 'onboarding_run_id', type: 'string', maxLength: 80 },
      { key: 'resume_available', type: 'boolean' },
      { key: 'resume_journey_id', type: 'string', maxLength: 80 },
      { key: 'resumed_from_run_id', type: 'string', maxLength: 80 },
      { key: 'saved_step', type: 'integer', min: 0, max: 1_000 },
      { key: 'total_steps', type: 'integer', min: 0, max: 1_000 },
    ],
  },
  'onboarding_resume_restarted': {
    bentoEvent: 'onboarding:resume_restarted',
    delivery: 'every',
    fields: [
      { key: 'flow', type: 'string', maxLength: 32 },
      { key: 'onboarding_attempt_id', type: 'uuid' },
      { key: 'onboarding_run_id', type: 'string', maxLength: 80 },
      { key: 'onboarding_version', type: 'integer', min: 1, max: 100 },
      { key: 'resume_onboarding_attempt_id', type: 'uuid' },
      { key: 'resumed_from_run_id', type: 'string', maxLength: 80 },
      { key: 'saved_step', type: 'string', maxLength: 32 },
      { key: 'step_index', type: 'integer', min: 0, max: 100 },
      { key: 'total_steps', type: 'integer', min: 0, max: 100 },
    ],
  },
  'onboarding_step_completed': {
    bentoEvent: 'onboarding:step_completed',
    delivery: 'every',
    fields: [
      { key: 'app_id', type: 'string', maxLength: 255 },
      { key: 'app_name', type: 'string', maxLength: 255 },
      { key: 'duration_ms', type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER },
      { key: 'flow', type: 'string', maxLength: 32 },
      { key: 'intent', type: 'string', maxLength: 32 },
      { key: 'next_step', type: 'string', maxLength: 32 },
      { key: 'onboarding_attempt_id', type: 'uuid' },
      { key: 'onboarding_run_id', type: 'string', maxLength: 80 },
      { key: 'onboarding_version', type: 'integer', min: 1, max: 100 },
      { key: 'previous_step', type: 'string', maxLength: 32 },
      { key: 'resumed', type: 'boolean' },
      { key: 'step', type: 'string', maxLength: 32 },
      { key: 'step_index', type: 'integer', min: 0, max: 100 },
      { key: 'store_import_used', type: 'boolean' },
      { key: 'total_steps', type: 'integer', min: 0, max: 100 },
    ],
  },
} as const satisfies Record<string, UserBentoEventMapping>

type SourceEventName = keyof typeof USER_BENTO_EVENT_REGISTRY

export interface MappedUserBentoEvent {
  bentoEvent: UserBentoEventName
  delivery: UserBentoEventMapping['delivery']
  details: UserBentoDetails
}

export interface StoredUserBentoEvent {
  details: UserBentoDetails[]
  occurrence_count: number
  sent_at?: string
}

export type StoredUserBentoEvents = Partial<Record<UserBentoEventName, StoredUserBentoEvent>>

export const MAX_USER_BENTO_DETAILS = 5

const USER_BENTO_TIMEOUT_MS = 5_000
const ONBOARDING_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FAST_STATE_SQL = `
  SELECT email, onboarding
  FROM public.users
  WHERE id = $1::uuid
`
const LOCK_USER_SQL = `
  SELECT email, onboarding
  FROM public.users
  WHERE id = $1::uuid
  FOR UPDATE
`
const PATCH_BENTO_EVENTS_SQL = `
  UPDATE public.users
  SET onboarding = jsonb_set(
    onboarding,
    '{bento_events}',
    CASE
      WHEN jsonb_typeof(onboarding -> 'bento_events') = 'object'
        THEN onboarding -> 'bento_events'
      ELSE '{}'::jsonb
    END || $2::jsonb,
    true
  )
  WHERE id = $1::uuid
`

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maxLength: number) {
  return Array.from(value).slice(0, maxLength).join('')
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string')
    return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function sourceMapping(event: string) {
  if (!Object.hasOwn(USER_BENTO_EVENT_REGISTRY, event))
    return undefined
  return USER_BENTO_EVENT_REGISTRY[event as SourceEventName]
}

function mappingForBentoEvent(event: UserBentoEventName) {
  return (Object.entries(USER_BENTO_EVENT_REGISTRY) as Array<[
    SourceEventName,
    UserBentoEventMapping,
  ]>).find(([, mapping]) => mapping.bentoEvent === event)
}

function copyMappedFields(
  target: UserBentoDetails,
  tags: Record<string, unknown> | undefined,
  fields: readonly DetailField[],
) {
  for (const field of fields) {
    const value = tags?.[field.key]
    if (field.type === 'string' && typeof value === 'string' && value.length > 0) {
      target[field.key] = truncate(value, field.maxLength)
    }
    else if (field.type === 'boolean' && typeof value === 'boolean') {
      target[field.key] = value
    }
    else if (field.type === 'uuid' && typeof value === 'string' && ONBOARDING_ATTEMPT_ID_PATTERN.test(value)) {
      target[field.key] = value
    }
    else if (
      field.type === 'integer'
      && typeof value === 'number'
      && Number.isInteger(value)
      && value >= field.min
      && value <= field.max
    ) {
      target[field.key] = value
    }
  }
}

export function buildMappedUserBentoEvent(input: {
  appId?: string
  observedAt: string
  orgId?: string
  sourceEvent: string
  tags?: Record<string, unknown>
}): MappedUserBentoEvent | undefined {
  const mapping = sourceMapping(input.sourceEvent)
  if (!mapping || !validIsoDate(input.observedAt))
    return undefined

  const details: UserBentoDetails = {
    observed_at: input.observedAt,
    source_event: input.sourceEvent,
  }
  if (input.orgId)
    details.org_id = truncate(input.orgId, 64)
  if (input.appId)
    details.app_id = truncate(input.appId, 255)
  copyMappedFields(details, input.tags, mapping.fields)
  return { bentoEvent: mapping.bentoEvent, delivery: mapping.delivery, details }
}

function sanitizeStoredDetail(
  event: UserBentoEventName,
  value: unknown,
): UserBentoDetails | undefined {
  if (!isJsonObject(value) || !validIsoDate(value.observed_at))
    return undefined
  const mapped = mappingForBentoEvent(event)
  if (!mapped)
    return undefined
  const [sourceEvent, mapping] = mapped
  const details: UserBentoDetails = {
    observed_at: value.observed_at,
    source_event: sourceEvent,
  }
  if (typeof value.org_id === 'string' && value.org_id.length > 0)
    details.org_id = truncate(value.org_id, 64)
  if (typeof value.app_id === 'string' && value.app_id.length > 0)
    details.app_id = truncate(value.app_id, 255)
  copyMappedFields(details, value, mapping.fields)
  return details
}

export function parseUserBentoEvents(onboarding: unknown): StoredUserBentoEvents {
  if (!isJsonObject(onboarding) || !isJsonObject(onboarding.bento_events))
    return {}

  const result: StoredUserBentoEvents = {}
  for (const event of USER_BENTO_EVENT_NAMES) {
    const raw = onboarding.bento_events[event]
    if (!isJsonObject(raw))
      continue
    const sanitizedDetails = (Array.isArray(raw.details) ? raw.details : [])
      .map(detail => sanitizeStoredDetail(event, detail))
      .filter((detail): detail is UserBentoDetails => detail !== undefined)
    const details = sanitizedDetails.length <= MAX_USER_BENTO_DETAILS
      ? sanitizedDetails
      : [
          sanitizedDetails[0]!,
          ...sanitizedDetails.slice(-(MAX_USER_BENTO_DETAILS - 1)),
        ]
    const sentAt = validIsoDate(raw.sent_at) ? raw.sent_at : undefined
    const storedCount = typeof raw.occurrence_count === 'number'
      && Number.isSafeInteger(raw.occurrence_count)
      && raw.occurrence_count >= 0
      ? raw.occurrence_count
      : 0
    if (!sentAt && details.length === 0)
      continue
    result[event] = {
      details,
      occurrence_count: Math.max(storedCount, sanitizedDetails.length),
      ...(sentAt ? { sent_at: sentAt } : {}),
    }
  }
  return result
}

export function appendUserBentoObservation(
  events: StoredUserBentoEvents,
  observation: MappedUserBentoEvent,
): StoredUserBentoEvents {
  const current = events[observation.bentoEvent]
  if (validIsoDate(current?.sent_at))
    return events

  const details = [...(current?.details ?? []), observation.details]
  const retained = details.length <= MAX_USER_BENTO_DETAILS
    ? details
    : [details[0]!, ...details.slice(-(MAX_USER_BENTO_DETAILS - 1))]
  const storedCount = typeof current?.occurrence_count === 'number'
    && Number.isSafeInteger(current.occurrence_count)
    && current.occurrence_count >= 0
    ? current.occurrence_count
    : 0
  const currentCount = Math.max(storedCount, current?.details.length ?? 0)
  const occurrenceCount = Math.min(Number.MAX_SAFE_INTEGER, currentCount + 1)
  return {
    ...events,
    [observation.bentoEvent]: {
      details: retained,
      occurrence_count: occurrenceCount,
    },
  }
}

export function getPendingUserBentoEvents(
  events: StoredUserBentoEvents,
): Array<{
  event: UserBentoEventName
  state: StoredUserBentoEvent
}> {
  return USER_BENTO_EVENT_NAMES.flatMap((event) => {
    const state = events[event]
    return state && !validIsoDate(state.sent_at) && state.details.length > 0
      ? [{ event, state }]
      : []
  })
}

export interface RecordUserBentoEventInput {
  appId?: string
  observedAt?: string
  orgId?: string
  sourceEvent: string
  tags?: Record<string, unknown>
  userId: string
}

function logUserBentoError(
  c: Context,
  phase: 'observe' | 'deliver',
  userId: string,
  event: UserBentoEventName | undefined,
  error: unknown,
) {
  cloudlogErr({
    requestId: c.get('requestId'),
    message: 'user Bento event delivery failed',
    phase,
    userId,
    event,
    error: serializeError(error),
  })
}

async function deliverEveryUserBentoEvent(
  c: Context,
  email: string,
  observation: MappedUserBentoEvent,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), USER_BENTO_TIMEOUT_MS)
  try {
    await trackBentoEvents(c, email, [{ event: observation.bentoEvent, data: observation.details }], controller.signal)
  }
  finally {
    clearTimeout(timeout)
  }
}

function rollbackReleaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error('PostgreSQL rollback failed')
}

async function persistUserBentoObservation(
  c: Context,
  userId: string,
  observation: MappedUserBentoEvent,
): Promise<boolean> {
  let pool: ReturnType<typeof getPgClient> | undefined
  try {
    pool = getPgClient(c)
    const client = await pool.connect()
    let transactionOpen = false
    let rollbackError: Error | undefined
    try {
      await client.query('BEGIN')
      transactionOpen = true
      const result = await client.query<{ onboarding: unknown }>(LOCK_USER_SQL, [userId])
      const lockedUser = result.rows[0]
      if (!lockedUser) {
        await client.query('COMMIT')
        transactionOpen = false
        return false
      }

      const storedEvents = parseUserBentoEvents(lockedUser.onboarding)
      if (validIsoDate(storedEvents[observation.bentoEvent]?.sent_at)) {
        await client.query('COMMIT')
        transactionOpen = false
        return getPendingUserBentoEvents(storedEvents).length > 0
      }

      const nextEvents = appendUserBentoObservation(storedEvents, observation)
      const changedEvent = nextEvents[observation.bentoEvent]
      await client.query(PATCH_BENTO_EVENTS_SQL, [
        userId,
        JSON.stringify({ [observation.bentoEvent]: changedEvent }),
      ])
      await client.query('COMMIT')
      transactionOpen = false
      return getPendingUserBentoEvents(nextEvents).length > 0
    }
    catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
          transactionOpen = false
        }
        catch (error) {
          rollbackError = rollbackReleaseError(error)
          logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
        }
      }
      logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
      return false
    }
    finally {
      try {
        client.release(rollbackError)
      }
      catch (error) {
        logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
      }
    }
  }
  catch (error) {
    logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
    return false
  }
  finally {
    if (pool) {
      try {
        await closeClient(c, pool)
      }
      catch (error) {
        logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
      }
    }
  }
}

export async function deliverPendingUserBentoEvents(
  c: Context,
  userId: string,
): Promise<boolean> {
  if (!isBentoConfigured(c))
    return false

  let pool: ReturnType<typeof getPgClient> | undefined
  try {
    pool = getPgClient(c)
    const client = await pool.connect()
    let transactionOpen = false
    let rollbackError: Error | undefined
    try {
      await client.query('BEGIN')
      transactionOpen = true
      const result = await client.query<{ email: string, onboarding: unknown }>(LOCK_USER_SQL, [userId])
      const lockedUser = result.rows[0]
      if (!lockedUser) {
        await client.query('COMMIT')
        transactionOpen = false
        return true
      }

      const pending = getPendingUserBentoEvents(parseUserBentoEvents(lockedUser.onboarding))
      if (pending.length === 0) {
        await client.query('COMMIT')
        transactionOpen = false
        return true
      }

      // Keep this per-user lock through the bounded Bento request intentionally:
      // concurrent deliveries must observe sent_at before deciding to send again.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), USER_BENTO_TIMEOUT_MS)
      let accepted: boolean | undefined
      try {
        accepted = await trackBentoEvents(c, lockedUser.email, pending.map(item => ({
          event: item.event,
          data: {
            occurrence_count: item.state.occurrence_count,
            observations: item.state.details,
          },
        })), controller.signal)
      }
      finally {
        clearTimeout(timeout)
      }
      if (accepted !== true)
        throw new Error('Bento did not accept the complete user event batch')

      const sentAt = new Date().toISOString()
      const sentPatch = Object.fromEntries(pending.map(item => [
        item.event,
        { ...item.state, sent_at: sentAt },
      ]))
      await client.query(PATCH_BENTO_EVENTS_SQL, [userId, JSON.stringify(sentPatch)])
      await client.query('COMMIT')
      transactionOpen = false
      return true
    }
    catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
          transactionOpen = false
        }
        catch (error) {
          rollbackError = rollbackReleaseError(error)
          logUserBentoError(c, 'deliver', userId, undefined, error)
        }
      }
      logUserBentoError(c, 'deliver', userId, undefined, error)
      return false
    }
    finally {
      try {
        client.release(rollbackError)
      }
      catch (error) {
        logUserBentoError(c, 'deliver', userId, undefined, error)
      }
    }
  }
  catch (error) {
    logUserBentoError(c, 'deliver', userId, undefined, error)
    return false
  }
  finally {
    if (pool) {
      try {
        await closeClient(c, pool)
      }
      catch (error) {
        logUserBentoError(c, 'deliver', userId, undefined, error)
      }
    }
  }
}

export async function recordUserBentoEvent(
  c: Context,
  input: RecordUserBentoEventInput,
): Promise<void> {
  const observation = buildMappedUserBentoEvent({
    appId: input.appId,
    observedAt: input.observedAt ?? new Date().toISOString(),
    orgId: input.orgId,
    sourceEvent: input.sourceEvent,
    tags: input.tags,
  })
  if (!observation)
    return

  try {
    let fastPool: ReturnType<typeof getPgClient> | undefined
    let fastEmail: string | undefined
    let fastState: StoredUserBentoEvents
    try {
      fastPool = getPgClient(c)
      const result = await fastPool.query<{ email: string, onboarding: unknown }>(FAST_STATE_SQL, [input.userId])
      fastEmail = result.rows[0]?.email
      fastState = parseUserBentoEvents(result.rows[0]?.onboarding)
    }
    finally {
      if (fastPool)
        await closeClient(c, fastPool)
    }

    const fastPending = getPendingUserBentoEvents(fastState)
    if (observation.delivery === 'every') {
      if (fastEmail)
        await backgroundTask(c, deliverEveryUserBentoEvent(c, fastEmail, observation))
      else
        logUserBentoError(c, 'deliver', input.userId, observation.bentoEvent, new Error('User email unavailable'))
      if (fastPending.length > 0)
        await backgroundTask(c, deliverPendingUserBentoEvents(c, input.userId))
      return
    }

    const currentSent = validIsoDate(fastState[observation.bentoEvent]?.sent_at)
    if (currentSent && fastPending.length === 0)
      return

    const hasPending = currentSent
      ? fastPending.length > 0
      : await persistUserBentoObservation(c, input.userId, observation)
    if (hasPending)
      await backgroundTask(c, deliverPendingUserBentoEvents(c, input.userId))
  }
  catch (error) {
    logUserBentoError(c, 'observe', input.userId, observation.bentoEvent, error)
  }
}
