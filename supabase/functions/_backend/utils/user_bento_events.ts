type TelemetryValue = string | number | boolean
type UserBentoDetails = Record<string, TelemetryValue>

type DetailField
  = | { key: string, type: 'boolean' }
    | { key: string, type: 'integer', min: number, max: number }
    | { key: string, type: 'string', maxLength: number }

interface UserBentoEventMapping {
  bentoEvent: UserBentoEventName
  fields: readonly DetailField[]
}

export const USER_BENTO_EVENT_NAMES = [
  'cli:command_invoked',
  'cli:login_successful',
  'cli:onboarding_run_started',
] as const

export type UserBentoEventName = typeof USER_BENTO_EVENT_NAMES[number]

const CLI_BENTO_EVENT_REGISTRY = {
  'CLI Command Invoked': {
    bentoEvent: 'cli:command_invoked',
    fields: [
      { key: 'command_path', type: 'string', maxLength: 128 },
      { key: 'flags', type: 'string', maxLength: 512 },
      { key: 'flags_count', type: 'integer', min: 0, max: 128 },
      { key: 'positional_arg_count', type: 'integer', min: 0, max: 128 },
    ],
  },
  'User CLI login': {
    bentoEvent: 'cli:login_successful',
    fields: [],
  },
  'onboarding-run-started': {
    bentoEvent: 'cli:onboarding_run_started',
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
} as const satisfies Record<string, UserBentoEventMapping>

type SourceEventName = keyof typeof CLI_BENTO_EVENT_REGISTRY

export interface MappedUserBentoEvent {
  bentoEvent: UserBentoEventName
  details: UserBentoDetails
}

export interface StoredUserBentoEvent {
  details: UserBentoDetails[]
  occurrence_count: number
  sent_at?: string
}

export type StoredUserBentoEvents = Partial<Record<UserBentoEventName, StoredUserBentoEvent>>

export const MAX_USER_BENTO_DETAILS = 5

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
  if (!Object.hasOwn(CLI_BENTO_EVENT_REGISTRY, event))
    return undefined
  return CLI_BENTO_EVENT_REGISTRY[event as SourceEventName]
}

function mappingForBentoEvent(event: UserBentoEventName) {
  return (Object.entries(CLI_BENTO_EVENT_REGISTRY) as Array<[
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
    if (field.type === 'string' && typeof value === 'string' && value.length > 0)
      target[field.key] = truncate(value, field.maxLength)
    else if (field.type === 'boolean' && typeof value === 'boolean')
      target[field.key] = value
    else if (
      field.type === 'integer'
      && typeof value === 'number'
      && Number.isInteger(value)
      && value >= field.min
      && value <= field.max
    )
      target[field.key] = value
  }
}

export function buildMappedUserBentoEvent(input: {
  appId?: string
  observedAt: string
  orgId?: string
  sourceEvent: string
  tags?: Record<string, TelemetryValue>
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
  return { bentoEvent: mapping.bentoEvent, details }
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
      occurrence_count: Math.max(storedCount, details.length),
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
  if (current?.sent_at)
    return events

  const details = [...(current?.details ?? []), observation.details]
  const retained = details.length <= MAX_USER_BENTO_DETAILS
    ? details
    : [details[0]!, ...details.slice(-(MAX_USER_BENTO_DETAILS - 1))]
  const currentCount = current?.occurrence_count ?? 0
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
    return state && !state.sent_at && state.details.length > 0
      ? [{ event, state }]
      : []
  })
}
