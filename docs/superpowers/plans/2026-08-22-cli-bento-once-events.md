# CLI Bento Once-Per-User Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `CLI Command Invoked`, `User CLI login`, and `onboarding-run-started` to their mapped Bento events once per user after a confirmed Bento acceptance, while durably retaining bounded observations across failures.

**Architecture:** `/private/events` will keep its current authentication, PostHog, notification, and response paths. A focused helper will recognize only the three registry entries, commit an additive `onboarding.bento_events` observation in Transaction 1, then schedule Transaction 2 through the existing background adapter; Transaction 2 locks the same user row across one existing Bento batch call and additively merges `sent_at` only after complete acceptance. Both writes use `jsonb_set` plus a nested JSONB merge and never replace the complete `users.onboarding` value.

**Tech Stack:** TypeScript, Hono, PostgreSQL JSONB and `node-postgres`, Supabase migrations, Bento batch API, Vitest, Vue 3.

---

## Scope and Change Budget

Implement only these mappings:

| Source event | Bento event |
| --- | --- |
| `CLI Command Invoked` | `cli:command_invoked` |
| `User CLI login` | `cli:login_successful` |
| `onboarding-run-started` | `cli:onboarding_run_started` |

Do not modify CLI production files. Do not add a queue, outbox, cron, sweeper,
table, column, index, RPC, database function, or PostgreSQL extension.

The production additions plus deletions must remain at or below 1,000 lines.
Use design commit `66a43ef09` as the implementation baseline. Tests and
`docs/superpowers` are excluded from the user's limit; the migration and every
other non-test file are included.

Expected production budget:

| Area | Target changed lines |
| --- | ---: |
| Constraint migration | 35 |
| Bento batch extension | 45 |
| Registry, state, and transaction helper | 350 |
| `/private/events` integration | 20 |
| Frontend preservation | 30 |
| Contingency | 120 |
| **Target total** | **600** |

## File Map

- Create `supabase/functions/_backend/utils/user_bento_events.ts`: exact event registry, safe detail extraction, stored-state parsing, additive Transaction 1, background scheduling, and locked Transaction 2.
- Modify `supabase/functions/_backend/utils/bento.ts`: expose a multi-event batch helper and keep `trackBentoEvent()` as its one-event wrapper.
- Modify `supabase/functions/_backend/private/events.ts`: pass the already-authenticated actor and verified context to the new helper after existing tracking is scheduled.
- Modify `src/services/userOnboardingWriteQueue.ts`: preserve a valid `bento_events` object when the frontend wizard performs its existing full-object compare-and-swap.
- Modify `src/components/dashboard/AppOnboardingFlow.vue`: apply that preservation helper during a conflict retry.
- Create one CLI-generated migration under `supabase/migrations/` with suffix `raise_users_onboarding_limit_for_bento_events.sql`: raise only `users_onboarding_valid` from 8,192 to 65,536 bytes.
- Create `tests/users-onboarding-size.test.ts`: real PostgreSQL coverage for the new constraint.
- Create `tests/user-bento-events.unit.test.ts`: registry and pure-state coverage.
- Create `tests/user-bento-event-delivery.unit.test.ts`: transaction, failure-window, locking, scheduling, and additive-SQL coverage.
- Create `tests/user-bento-events.test.ts`: authenticated `/private/events` integration with a dynamically created, isolated user.
- Modify `tests/bento-response-acceptance.unit.test.ts` and `tests/bento-abort-signal.unit.test.ts`: batch result and timeout-signal coverage.
- Modify `tests/user-onboarding-write-queue.unit.test.ts` and `tests/app-onboarding-progress-integration.unit.test.ts`: frontend preservation and call-site coverage.

### Task 1: Raise the `users.onboarding` constraint to 65,536 bytes

**Files:**
- Create: `tests/users-onboarding-size.test.ts`
- Create via Supabase CLI: the file under `supabase/migrations/` ending in `raise_users_onboarding_limit_for_bento_events.sql`

- [ ] **Step 1: Write the failing PostgreSQL test**

Create `tests/users-onboarding-size.test.ts`. Use a dynamically generated user
so no parallel test shares mutable state:

```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_PASSWORD_HASH, executeSQL } from './test-utils.ts'

const userId = randomUUID()
const email = `user-bento-size-${userId}@capgo.test`

describe('users.onboarding Bento storage limit', () => {
  beforeAll(async () => {
    await executeSQL(
      `INSERT INTO auth.users (
         id, email, encrypted_password, email_confirmed_at,
         created_at, updated_at, raw_user_meta_data
       ) VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
      [userId, email, USER_PASSWORD_HASH],
    )
    await executeSQL(
      `INSERT INTO public.users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [userId, email],
    )
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.users WHERE id = $1::uuid', [userId])
    await executeSQL('DELETE FROM auth.users WHERE id = $1::uuid', [userId])
  })

  it('defines the complete onboarding JSON limit as 65536 bytes', async () => {
    const [constraint] = await executeSQL<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'public.users'::regclass
         AND conname = 'users_onboarding_valid'`,
    )

    expect(constraint?.definition.replace(/\s+/g, ' ')).toContain(
      'octet_length((onboarding)::text) <= 65536',
    )
  })

  it('accepts a value below 65536 bytes and rejects one above it', async () => {
    const accepted = { payload: 'a'.repeat(65_000) }
    const rejected = { payload: 'b'.repeat(65_536) }

    await expect(executeSQL(
      'UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1::uuid',
      [userId, JSON.stringify(accepted)],
    )).resolves.toHaveLength(0)

    await expect(executeSQL(
      'UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1::uuid',
      [userId, JSON.stringify(rejected)],
    )).rejects.toMatchObject({ code: '23514' })
  })
})
```

- [ ] **Step 2: Run the focused test and verify the old constraint fails it**

Run:

```bash
bun run supabase:start
bun run supabase:with-env -- bunx vitest run tests/users-onboarding-size.test.ts
```

Expected: FAIL because `users_onboarding_valid` still contains `<= 8192`, and
the 65,000-character payload violates the old check.

- [ ] **Step 3: Create the single migration using the mandated CLI**

Run exactly:

```bash
bunx supabase migration new raise_users_onboarding_limit_for_bento_events
```

Edit only the new file printed by this command. Do not edit
`supabase/schemas/prod.sql`. Use this SQL:

```sql
ALTER TABLE public.users
DROP CONSTRAINT users_onboarding_valid;

ALTER TABLE public.users
ADD CONSTRAINT users_onboarding_valid CHECK (
  jsonb_typeof(onboarding) = 'object'
  AND octet_length(onboarding::text) <= 65536
  AND (
    NOT (onboarding ? 'status')
    OR (
      jsonb_typeof(onboarding -> 'status') = 'string'
      AND onboarding ->> 'status' = ANY (ARRAY['in_progress', 'completed', 'abandoned'])
    )
  )
  AND (
    NOT (onboarding ? 'step')
    OR (
      jsonb_typeof(onboarding -> 'step') = 'string'
      AND onboarding ->> 'step' = ANY (ARRAY['intent', 'details', 'organization', 'choice', 'install', 'setup'])
    )
  )
  AND (
    NOT (onboarding ? 'flow')
    OR (
      jsonb_typeof(onboarding -> 'flow') = 'string'
      AND onboarding ->> 'flow' = ANY (ARRAY['pre_org', 'existing_org'])
    )
  )
  AND (
    NOT (onboarding ? 'intent')
    OR (
      jsonb_typeof(onboarding -> 'intent') = 'string'
      AND onboarding ->> 'intent' = ANY (ARRAY['ota', 'builder', 'both', 'exploring'])
    )
  )
) NOT VALID;
```

This preserves every validation rule and changes only the byte ceiling.

- [ ] **Step 4: Format, reset, and verify the migration**

Run:

```bash
bunx sqlfluff fix --dialect postgres supabase/migrations/*_raise_users_onboarding_limit_for_bento_events.sql
bun run supabase:db:reset
bun run supabase:with-env -- bunx vitest run tests/users-onboarding-size.test.ts
```

Expected: PASS. Confirm `git diff` shows one migration and the new test, with no
change to `supabase/schemas/prod.sql`.

- [ ] **Step 5: Commit the constraint change**

```bash
git add supabase/migrations/*_raise_users_onboarding_limit_for_bento_events.sql tests/users-onboarding-size.test.ts
git commit -m "feat(db): raise user onboarding JSON limit"
```

### Task 2: Reuse Bento's existing transport for one multi-event batch

**Files:**
- Modify: `supabase/functions/_backend/utils/bento.ts:79`
- Modify: `tests/bento-response-acceptance.unit.test.ts`
- Modify: `tests/bento-abort-signal.unit.test.ts`

- [ ] **Step 1: Add failing batch-acceptance tests**

Import `trackBentoEvents` beside `trackBentoEvent` and add this block inside the
configured Bento suite:

```ts
describe('trackBentoEvents', () => {
  const events = [
    { event: 'cli:command_invoked', data: { occurrence_count: 1 } },
    { event: 'cli:login_successful', data: { occurrence_count: 2 } },
  ]

  it('sends one request and accepts the exact batch result count', async () => {
    queueAcknowledgement({ failed: 0, results: 2 })

    await expect(trackBentoEvents(
      createContext(),
      'event.user@example.com',
      events,
    )).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, request] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(request?.body))).toEqual({
      events: [
        {
          type: 'cli:command_invoked',
          email: 'event.user@example.com',
          details: { occurrence_count: 1 },
        },
        {
          type: 'cli:login_successful',
          email: 'event.user@example.com',
          details: { occurrence_count: 2 },
        },
      ],
    })
  })

  it.each([
    ['a short result count', { failed: 0, results: 1 }],
    ['a non-zero failure count', { failed: 1, results: 2 }],
    ['a malformed acknowledgement', null],
  ])('rejects %s', async (_label, acknowledgement) => {
    queueAcknowledgement(acknowledgement)
    await expect(trackBentoEvents(
      createContext(),
      'event.user@example.com',
      events,
    )).resolves.toBe(false)
  })
})
```

Extend `tests/bento-abort-signal.unit.test.ts` with a `trackBentoEvents` case and
assert its optional signal is passed as `RequestInit.signal`.

- [ ] **Step 2: Run the tests and verify the missing export fails**

```bash
bunx vitest run tests/bento-response-acceptance.unit.test.ts tests/bento-abort-signal.unit.test.ts
```

Expected: FAIL because `trackBentoEvents` is not exported.

- [ ] **Step 3: Implement the minimal reusable batch helper**

In `supabase/functions/_backend/utils/bento.ts`, add this interface and helper,
then make the existing one-event function delegate to it:

```ts
export interface BentoBatchEvent {
  data: Record<string, unknown>
  event: string
}

export async function trackBentoEvents(
  c: Context,
  email: string,
  events: readonly BentoBatchEvent[],
  signal?: AbortSignal,
) {
  if (!isBentoConfigured(c))
    return
  if (events.length === 0)
    return true

  try {
    const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
    const payload = {
      events: events.map(item => ({
        type: item.event,
        email,
        details: item.data,
      })),
    }
    const res = await bentoFetch(c, 'batch/events', siteUuid, payload, signal)
    if (!acceptedBentoBatchResult(res, payload.events.length)) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvents', error: res })
      return false
    }
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trackBentoEvents error', error: serializeError(error) })
    return false
  }
}

export async function trackBentoEvent(
  c: Context,
  email: string,
  data: Record<string, unknown>,
  event: string,
  signal?: AbortSignal,
) {
  return trackBentoEvents(c, email, [{ data, event }], signal)
}
```

Delete the old duplicate body of `trackBentoEvent`; do not change current
callers or the plugin-runtime Bento copy.

- [ ] **Step 4: Run the focused Bento tests**

```bash
bunx vitest run tests/bento-response-acceptance.unit.test.ts tests/bento-abort-signal.unit.test.ts
```

Expected: PASS, including existing one-event behavior.

- [ ] **Step 5: Commit the transport reuse**

```bash
git add supabase/functions/_backend/utils/bento.ts tests/bento-response-acceptance.unit.test.ts tests/bento-abort-signal.unit.test.ts
git commit -m "feat(bento): support user event batches"
```

### Task 3: Implement the exact registry and bounded pure state model

**Files:**
- Create: `supabase/functions/_backend/utils/user_bento_events.ts`
- Create: `tests/user-bento-events.unit.test.ts`

- [ ] **Step 1: Write failing registry and state tests**

Create `tests/user-bento-events.unit.test.ts` and cover the public pure helpers:

```ts
import { describe, expect, it } from 'vitest'
import {
  appendUserBentoObservation,
  buildMappedUserBentoEvent,
  getPendingUserBentoEvents,
  parseUserBentoEvents,
} from '../supabase/functions/_backend/utils/user_bento_events.ts'
import type { StoredUserBentoEvents } from '../supabase/functions/_backend/utils/user_bento_events.ts'

describe('CLI user Bento event registry', () => {
  it.each([
    ['CLI Command Invoked', 'cli:command_invoked'],
    ['User CLI login', 'cli:login_successful'],
    ['onboarding-run-started', 'cli:onboarding_run_started'],
  ])('maps %s to %s', (sourceEvent, bentoEvent) => {
    expect(buildMappedUserBentoEvent({
      sourceEvent,
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {},
    })?.bentoEvent).toBe(bentoEvent)
  })

  it('returns undefined for an unmapped event', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Succeeded',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: { command_path: 'init' },
    })).toBeUndefined()
  })

  it('copies only typed and bounded allowlisted details', () => {
    expect(buildMappedUserBentoEvent({
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:00.000Z',
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      appId: 'com.example.app',
      tags: {
        command_path: 'init',
        flags: 'verbose',
        flags_count: 1,
        positional_arg_count: 0,
        secret: 'must-not-leak',
      },
    })?.details).toEqual({
      observed_at: '2026-08-22T10:00:00.000Z',
      source_event: 'CLI Command Invoked',
      org_id: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      app_id: 'com.example.app',
      command_path: 'init',
      flags: 'verbose',
      flags_count: 1,
      positional_arg_count: 0,
    })
  })

  it('retains the first and four latest details while count keeps growing', () => {
    let events: StoredUserBentoEvents = {}
    for (let index = 1; index <= 7; index++) {
      const observation = buildMappedUserBentoEvent({
        sourceEvent: 'CLI Command Invoked',
        observedAt: `2026-08-22T10:00:0${index}.000Z`,
        tags: { command_path: `command-${index}` },
      })!
      events = appendUserBentoObservation(events, observation)
    }

    expect(events['cli:command_invoked'].occurrence_count).toBe(7)
    expect(events['cli:command_invoked'].details.map(detail => detail.command_path)).toEqual([
      'command-1',
      'command-4',
      'command-5',
      'command-6',
      'command-7',
    ])
  })

  it('does not append after a valid sent_at and does not trust malformed sent_at', () => {
    const observation = buildMappedUserBentoEvent({
      sourceEvent: 'User CLI login',
      observedAt: '2026-08-22T10:00:00.000Z',
      tags: {},
    })!
    const sent = parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          details: [observation.details],
          occurrence_count: 1,
          sent_at: '2026-08-22T10:00:01.000Z',
        },
      },
    })
    expect(appendUserBentoObservation(sent, observation)).toEqual(sent)

    const malformed = parseUserBentoEvents({
      bento_events: {
        'cli:login_successful': {
          details: [observation.details],
          occurrence_count: 1,
          sent_at: 'not-a-date',
        },
      },
    })
    expect(getPendingUserBentoEvents(malformed)).toHaveLength(1)
  })

  it('drops unknown stored events and unknown stored detail properties', () => {
    const parsed = parseUserBentoEvents({
      bento_events: {
        'cli:command_invoked': {
          occurrence_count: 1,
          details: [{
            observed_at: '2026-08-22T10:00:00.000Z',
            source_event: 'CLI Command Invoked',
            command_path: 'init',
            api_key: 'must-not-leak',
          }],
        },
        'attacker:event': {
          occurrence_count: 1,
          details: [{ token: 'must-not-leak' }],
        },
      },
    })

    expect(parsed).toEqual({
      'cli:command_invoked': {
        occurrence_count: 1,
        details: [{
          observed_at: '2026-08-22T10:00:00.000Z',
          source_event: 'CLI Command Invoked',
          command_path: 'init',
        }],
      },
    })
  })
})
```

- [ ] **Step 2: Run the test and verify the new module is missing**

```bash
bunx vitest run tests/user-bento-events.unit.test.ts
```

Expected: FAIL because `user_bento_events.ts` does not exist.

- [ ] **Step 3: Add the concrete registry and types**

Create `supabase/functions/_backend/utils/user_bento_events.ts` with these
constants and types:

```ts
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
```

Implement a type guard using `Object.hasOwn(CLI_BENTO_EVENT_REGISTRY, event)`.
Do not cast the incoming body to a registry-shaped object and do not add an
unrestricted index signature to `TrackEventBody`.

- [ ] **Step 4: Implement bounded detail extraction and stored-state helpers**

Add these pure functions to the same file:

```ts
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
```

For stored details, resolve the registry entry by Bento name, force
`source_event` to that entry's source name, accept only a valid `observed_at`,
reapply the same field descriptors, and retain only bounded `org_id` and
`app_id`. Add the complete state implementation:

```ts
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
```

This makes `appendUserBentoObservation()` terminal after a valid `sent_at`,
keeps a non-negative safe integer count, and makes pending delivery order stable.

- [ ] **Step 5: Run the pure unit test**

```bash
bunx vitest run tests/user-bento-events.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the registry and state model**

```bash
git add supabase/functions/_backend/utils/user_bento_events.ts tests/user-bento-events.unit.test.ts
git commit -m "feat(api): map CLI Bento lifecycle events"
```

### Task 4: Add the two additive transactions and failure semantics

**Files:**
- Modify: `supabase/functions/_backend/utils/user_bento_events.ts`
- Create: `tests/user-bento-event-delivery.unit.test.ts`

- [ ] **Step 1: Write failing transaction tests with mocked PostgreSQL and Bento**

Mock `getPgClient`, `closeClient`, `backgroundTask`, `trackBentoEvents`, and
logging using `vi.hoisted()`. Normalize whitespace before asserting SQL. Cover
these exact cases:

```ts
it('commits the observation before scheduling delivery', async () => {
  await recordUserBentoEvent(context(), {
    userId: USER_ID,
    sourceEvent: 'CLI Command Invoked',
    observedAt: OBSERVED_AT,
    tags: { command_path: 'init' },
  })

  expect(transactionQueries).toEqual([
    'BEGIN',
    expect.stringContaining('SELECT onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE'),
    expect.stringContaining("SET onboarding = jsonb_set(onboarding, '{bento_events}'"),
    'COMMIT',
  ])
  expect(transactionQueries[2]).toContain("COALESCE(onboarding -> 'bento_events', '{}'::jsonb) || $2::jsonb")
  expect(transactionQueries[2]).not.toContain('SET onboarding = $2')
  const commitCall = queryMock.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
  expect(commitCall).toBeGreaterThanOrEqual(0)
  expect(queryMock.mock.invocationCallOrder[commitCall]).toBeLessThan(
    backgroundTaskMock.mock.invocationCallOrder[0]!,
  )
})

it('uses one indexed read and no lock, write, or Bento call after all events are sent', async () => {
  fastQueryMock.mockResolvedValueOnce({ rows: [{ onboarding: ALL_SENT }] })
  await recordUserBentoEvent(context(), {
    userId: USER_ID,
    sourceEvent: 'CLI Command Invoked',
    observedAt: OBSERVED_AT,
    tags: { command_path: 'init' },
  })
  expect(connectMock).not.toHaveBeenCalled()
  expect(trackBentoEventsMock).not.toHaveBeenCalled()
  expect(backgroundTaskMock).not.toHaveBeenCalled()
})

it('locks the user across Bento acceptance and additively commits sent_at', async () => {
  const result = await deliverPendingUserBentoEvents(context(), USER_ID)
  expect(result).toBe(true)
  expect(callOrder).toEqual([
    'BEGIN',
    'SELECT email,onboarding FOR UPDATE',
    'BENTO',
    'ADDITIVE UPDATE',
    'COMMIT',
  ])
  expect(deliveryUpdateSql).toContain("COALESCE(onboarding -> 'bento_events', '{}'::jsonb) || $2::jsonb")
  expect(deliveryUpdateSql).not.toContain('SET onboarding = $2')
})

it.each([
  ['false acceptance', false],
  ['missing Bento configuration', undefined],
])('rolls back and leaves pending state on %s', async (_label, result) => {
  trackBentoEventsMock.mockResolvedValueOnce(result)
  await expect(deliverPendingUserBentoEvents(context(), USER_ID)).resolves.toBe(false)
  expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
  expect(updateCalls()).toHaveLength(0)
})

it('retries after Bento accepted but the sent_at update failed', async () => {
  updateQueryMock.mockRejectedValueOnce(new Error('connection died before sent_at'))
  await expect(deliverPendingUserBentoEvents(context(), USER_ID)).resolves.toBe(false)
  await expect(deliverPendingUserBentoEvents(context(), USER_ID)).resolves.toBe(true)
  expect(trackBentoEventsMock).toHaveBeenCalledTimes(2)
})

it('lets a different mapped event schedule every pending entry', async () => {
  fastQueryMock.mockResolvedValueOnce({ rows: [{ onboarding: LOGIN_PENDING_COMMAND_SENT }] })
  await recordUserBentoEvent(context(), {
    userId: USER_ID,
    sourceEvent: 'CLI Command Invoked',
    observedAt: OBSERVED_AT,
    tags: { command_path: 'app list' },
  })
  expect(backgroundTaskMock).toHaveBeenCalledOnce()
})

it('swallows observation errors so analytics requests can still succeed', async () => {
  fastQueryMock.mockRejectedValueOnce(new Error('database unavailable'))
  await expect(recordUserBentoEvent(context(), {
    userId: USER_ID,
    sourceEvent: 'User CLI login',
    observedAt: OBSERVED_AT,
    tags: {},
  })).resolves.toBeUndefined()
  expect(backgroundTaskMock).not.toHaveBeenCalled()
})
```

Also simulate two delivery calls by holding the second mocked `FOR UPDATE`
result until the first commits. Return pending state to the first and sent state
to the second; assert `trackBentoEvents` runs once. Add a fake-timer test where
the Bento promise waits for its signal, advance 5,000 ms, and assert rollback.

- [ ] **Step 2: Run the delivery test and verify missing exports fail**

```bash
bunx vitest run tests/user-bento-event-delivery.unit.test.ts
```

Expected: FAIL because the transaction functions do not exist.

- [ ] **Step 3: Add the shared additive update and primary-read SQL**

In `user_bento_events.ts`, import `Context`, `trackBentoEvents`, `cloudlogErr`,
`serializeError`, `closeClient`, `getPgClient`, and `backgroundTask`. Add:

```ts
const USER_BENTO_TIMEOUT_MS = 5_000

const FAST_STATE_SQL = `
  SELECT onboarding
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
    COALESCE(onboarding -> 'bento_events', '{}'::jsonb) || $2::jsonb,
    true
  )
  WHERE id = $1::uuid
`
```

The second parameter is always `JSON.stringify(eventPatch)`, where
`eventPatch` contains only the Bento event entries changed by that transaction.
Never bind or write the complete `onboarding` object.

Add the sanitized logger used by both phases:

```ts
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
```

Do not include the locked email or stored details in this log.

- [ ] **Step 4: Implement Transaction 1**

Add an internal `persistUserBentoObservation()` that:

1. Creates a primary pool with `getPgClient(c)`.
2. Connects one client, begins, and selects `onboarding` with `LOCK_USER_SQL`.
3. Parses the locked state and rechecks `sent_at`.
4. Builds the next event entry with `appendUserBentoObservation()`.
5. Calls `PATCH_BENTO_EVENTS_SQL` with `{ [observation.bentoEvent]: nextEntry }`.
6. Commits and returns whether any mapped entry is pending.
7. Rolls back on every failure, releases the connection, and closes the pool.

Use this transaction shape:

```ts
let transactionOpen = false
try {
  await client.query('BEGIN')
  transactionOpen = true
  const locked = await client.query(LOCK_USER_SQL, [userId])
  if (!locked.rows[0]) {
    await client.query('COMMIT')
    transactionOpen = false
    return false
  }

  const current = parseUserBentoEvents(locked.rows[0].onboarding)
  if (current[observation.bentoEvent]?.sent_at) {
    await client.query('COMMIT')
    transactionOpen = false
    return getPendingUserBentoEvents(current).length > 0
  }

  const next = appendUserBentoObservation(current, observation)
  await client.query(PATCH_BENTO_EVENTS_SQL, [userId, JSON.stringify({
    [observation.bentoEvent]: next[observation.bentoEvent],
  })])
  await client.query('COMMIT')
  transactionOpen = false
  return getPendingUserBentoEvents(next).length > 0
}
catch (error) {
  if (transactionOpen)
    await client.query('ROLLBACK').catch(() => {})
  logUserBentoError(c, 'observe', userId, observation.bentoEvent, error)
  return false
}
finally {
  client.release()
  await closeClient(c, pool)
}
```

`logUserBentoError()` must log request ID, user ID, Bento name, phase, and
`serializeError(error)`, but not email or details.

- [ ] **Step 5: Implement locked Transaction 2**

Export `deliverPendingUserBentoEvents(c, userId): Promise<boolean>`. Use the
same transaction cleanup structure, but keep the transaction and row lock open
through this exact Bento call:

```ts
const pending = getPendingUserBentoEvents(current)
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), USER_BENTO_TIMEOUT_MS)
let accepted: boolean | undefined
try {
  accepted = await trackBentoEvents(
    c,
    lockedUser.email,
    pending.map(item => ({
      event: item.event,
      data: {
        occurrence_count: item.state.occurrence_count,
        observations: item.state.details,
      },
    })),
    controller.signal,
  )
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
```

Commit after the additive update. If no pending entry exists, commit without a
Bento call. On any false result, timeout, thrown error, update failure, or commit
failure, attempt rollback, log phase `deliver`, return `false`, and leave
Transaction 1's state intact.

- [ ] **Step 6: Implement fast check and background orchestration**

Export this input and function:

```ts
export interface RecordUserBentoEventInput {
  appId?: string
  observedAt?: string
  orgId?: string
  sourceEvent: string
  tags?: Record<string, TelemetryValue>
  userId: string
}

export async function recordUserBentoEvent(
  c: Context,
  input: RecordUserBentoEventInput,
): Promise<void>
```

The function must:

1. Build the mapped observation before opening PostgreSQL. Unmapped events
   return immediately.
2. Use `input.observedAt ?? new Date().toISOString()`.
3. Query `FAST_STATE_SQL` on the primary database.
4. Return when the current event has `sent_at` and no other mapped entry is
   pending.
5. Run and await Transaction 1 only when the current event is not sent.
6. Schedule `deliverPendingUserBentoEvents(c, input.userId)` through the existing
   `await backgroundTask(c, promise)` when any entry is pending.
7. Catch and log fast-check errors as phase `observe`; never throw to the route.

Always close the fast-check pool. Do not use the read replica because stale
`sent_at` state could cause avoidable duplicates.

- [ ] **Step 7: Run transaction and pure tests together**

```bash
bunx vitest run tests/user-bento-events.unit.test.ts tests/user-bento-event-delivery.unit.test.ts
```

Expected: PASS. Inspect the SQL assertions to confirm both writes contain
`jsonb_set` plus nested `|| $2::jsonb` and neither replaces `onboarding`.

- [ ] **Step 8: Commit the transactional delivery helper**

```bash
git add supabase/functions/_backend/utils/user_bento_events.ts tests/user-bento-event-delivery.unit.test.ts
git commit -m "feat(api): deliver CLI Bento events once per user"
```

### Task 5: Integrate the helper into `/private/events`

**Files:**
- Modify: `supabase/functions/_backend/private/events.ts:449-478`
- Create: `tests/user-bento-events.test.ts`

- [ ] **Step 1: Write the failing authenticated endpoint integration test**

Create `tests/user-bento-events.test.ts`. In `beforeAll`, dynamically insert an
`auth.users` row and matching `public.users` row, then create a unique API key
using `createDirectApiKeyWithBindings({ userId, key: randomUUID(), name:
'user-bento-events', orgId: ORG_ID })`. In `afterAll`, delete that API key,
public profile, and auth user.

Use this concrete setup and cleanup:

```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  ORG_ID,
  USER_PASSWORD_HASH,
  createDirectApiKeyWithBindings,
  executeSQL,
  getEndpointUrl,
} from './test-utils.ts'

const userId = randomUUID()
const email = `user-bento-events-${userId}@capgo.test`
let apiKey = ''
let apiKeyId: number | undefined

beforeAll(async () => {
  await executeSQL(
    `INSERT INTO auth.users (
       id, email, encrypted_password, email_confirmed_at,
       created_at, updated_at, raw_user_meta_data
     ) VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
    [userId, email, USER_PASSWORD_HASH],
  )
  await executeSQL(
    `INSERT INTO public.users (id, email)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [userId, email],
  )

  const created = await createDirectApiKeyWithBindings({
    userId,
    key: randomUUID(),
    name: 'user-bento-events',
    orgId: ORG_ID,
  })
  if (!created.key)
    throw new Error('User Bento test API key was not returned')
  apiKey = created.key
  apiKeyId = created.id
})

afterAll(async () => {
  if (apiKeyId !== undefined)
    await executeSQL('DELETE FROM public.apikeys WHERE id = $1', [apiKeyId])
  await executeSQL('DELETE FROM public.users WHERE id = $1::uuid', [userId])
  await executeSQL('DELETE FROM auth.users WHERE id = $1::uuid', [userId])
})
```

Use sequential `it()` cases because this file intentionally mutates its own
dedicated user:

```ts
it('does not record a notifyConsole login copy', async () => {
  const response = await fetch(getEndpointUrl('/private/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', capgkey: apiKey },
    body: JSON.stringify({
      channel: 'user-login',
      event: 'User CLI login',
      notifyConsole: true,
      user_id: ORG_ID,
      tracking_version: 2,
    }),
  })
  expect(response.status).toBe(200)
  const [user] = await executeSQL<{ onboarding: Record<string, unknown> }>(
    'SELECT onboarding FROM public.users WHERE id = $1::uuid',
    [userId],
  )
  expect(user?.onboarding).not.toHaveProperty('bento_events')
})

it('records only the three mapped actor events and preserves unrelated JSON', async () => {
  const original = {
    status: 'in_progress',
    step: 'details',
    flow: 'pre_org',
    unrelated: { keep: true },
  }
  await executeSQL(
    'UPDATE public.users SET onboarding = $2::jsonb WHERE id = $1::uuid',
    [userId, JSON.stringify(original)],
  )

  const payloads = [
    {
      channel: 'cli-usage',
      event: 'CLI Command Invoked',
      tracking_version: 2,
      tags: { command_path: 'init', flags: 'verbose', flags_count: 1, positional_arg_count: 0 },
    },
    { channel: 'user-login', event: 'User CLI login', tracking_version: 2 },
    {
      channel: 'onboarding-v2',
      event: 'onboarding-run-started',
      tracking_version: 2,
      tags: {
        onboarding_event_version: 1,
        onboarding_journey_id: 'ij_11111111-1111-4111-8111-111111111111',
        onboarding_run_id: 'ir_22222222-2222-4222-8222-222222222222',
        resume_available: false,
      },
    },
    { channel: 'cli-usage', event: 'CLI Command Succeeded', tracking_version: 2 },
  ]

  for (const payload of payloads) {
    const response = await fetch(getEndpointUrl('/private/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', capgkey: apiKey },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
  }

  const [user] = await executeSQL<{ onboarding: Record<string, any> }>(
    'SELECT onboarding FROM public.users WHERE id = $1::uuid',
    [userId],
  )
  expect(user?.onboarding).toMatchObject(original)
  expect(Object.keys(user!.onboarding.bento_events).sort()).toEqual([
    'cli:command_invoked',
    'cli:login_successful',
    'cli:onboarding_run_started',
  ])
  expect(user!.onboarding.bento_events['cli:command_invoked']).toMatchObject({
    occurrence_count: 1,
    details: [expect.objectContaining({ command_path: 'init' })],
  })
})
```

Local placeholder Bento credentials must leave the entries pending; the test is
asserting durable Transaction 1, not external network delivery. Do not add this
raw-PostgreSQL/edge-function test to `tests/tinbase-db-tests.txt`.

- [ ] **Step 2: Run the integration test and verify no Bento state is written**

```bash
bun run supabase:with-env -- bunx vitest run tests/user-bento-events.test.ts
```

Expected: FAIL because `/private/events` does not invoke the helper.

- [ ] **Step 3: Add the narrow route call**

Import `recordUserBentoEvent` in
`supabase/functions/_backend/private/events.ts`. Keep the existing
`notifyConsole` early return untouched. Immediately after the existing
`sendEventToTracking()` call and before `return c.json(BRES)`, add:

```ts
await recordUserBentoEvent(c, {
  userId: trackingUserId,
  sourceEvent: trackedBody.event,
  tags: trackedBody.tags,
  orgId: verifiedOrgId,
  appId,
})
```

The helper itself no-ops for unmapped names and catches its own failures. Do not
alter `sentToBento`, `BentoTrackingPayload`, the PostHog payload, or any CLI
source file.

- [ ] **Step 4: Run endpoint, transaction, and existing events tests**

```bash
bun run supabase:with-env -- bunx vitest run tests/user-bento-events.test.ts tests/events.test.ts
bunx vitest run tests/user-bento-events.unit.test.ts tests/user-bento-event-delivery.unit.test.ts
```

Expected: PASS. Existing event responses remain `{ status: 'ok' }`.

- [ ] **Step 5: Commit the route integration**

```bash
git add supabase/functions/_backend/private/events.ts tests/user-bento-events.test.ts
git commit -m "feat(api): record mapped CLI Bento events"
```

### Task 6: Preserve backend Bento state during frontend onboarding writes

**Files:**
- Modify: `src/services/userOnboardingWriteQueue.ts`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:520-560`
- Modify: `tests/user-onboarding-write-queue.unit.test.ts`
- Modify: `tests/app-onboarding-progress-integration.unit.test.ts`

- [ ] **Step 1: Add failing preservation-helper tests**

Import `preserveUserBentoEvents` in
`tests/user-onboarding-write-queue.unit.test.ts` and add:

```ts
it.concurrent('preserves the current Bento subtree without replacing next progress', () => {
  const current = {
    status: 'in_progress',
    bento_events: {
      'cli:command_invoked': {
        details: [{ observed_at: '2026-08-22T10:00:00.000Z' }],
        occurrence_count: 1,
        sent_at: '2026-08-22T10:00:01.000Z',
      },
    },
  }
  const next = { status: 'completed', step: 'setup' }

  expect(preserveUserBentoEvents(next, current)).toEqual({
    ...next,
    bento_events: current.bento_events,
  })
})

it.concurrent('ignores a malformed Bento subtree', () => {
  expect(preserveUserBentoEvents(
    { status: 'completed' },
    { bento_events: ['not', 'an', 'object'] },
  )).toEqual({ status: 'completed' })
})
```

In `tests/app-onboarding-progress-integration.unit.test.ts`, extend the writer
source assertion so it requires `preserveUserBentoEvents` after
`preserveAdminDashboardMinimize` and before
`replaceUserOnboardingIfUnchanged`.

- [ ] **Step 2: Run the frontend unit tests and verify the export is missing**

```bash
bunx vitest run tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
```

Expected: FAIL because `preserveUserBentoEvents` does not exist.

- [ ] **Step 3: Add the small preservation helper**

In `src/services/userOnboardingWriteQueue.ts`, reuse a local JSON-object guard
and add:

```ts
function isJsonObject(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function preserveUserBentoEvents(
  nextOnboarding: Json,
  currentOnboarding: Json | undefined,
): Json {
  if (!isJsonObject(currentOnboarding))
    return nextOnboarding
  const bentoEvents = currentOnboarding.bento_events
  if (!isJsonObject(bentoEvents))
    return nextOnboarding
  const next = isJsonObject(nextOnboarding) ? nextOnboarding : {}
  return { ...next, bento_events: bentoEvents }
}
```

This helper does not parse Bento state for the UI; it only preserves the opaque
backend-owned object obtained in the compare-and-swap snapshot.

- [ ] **Step 4: Apply preservation in the wizard's conflict-retry write**

Import `preserveUserBentoEvents` from `userOnboardingWriteQueue.ts`. Change the
construction in `writeOnboardingProgress()` to:

```ts
const onboardingWithPreferences = preserveAdminDashboardMinimize(
  progress as unknown as Json,
  currentOnboarding,
  main.isAdmin,
)
const onboarding = preserveUserBentoEvents(
  onboardingWithPreferences,
  currentOnboarding,
)
```

Pass `onboarding` to the existing `replaceUserOnboardingIfUnchanged()` call.
Do not change its compare-and-swap filter or retry loop.

- [ ] **Step 5: Run the focused frontend tests**

```bash
bunx vitest run tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/user-onboarding-progress.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit frontend preservation**

```bash
git add src/services/userOnboardingWriteQueue.ts src/components/dashboard/AppOnboardingFlow.vue tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts
git commit -m "fix(frontend): preserve user Bento event state"
```

### Task 7: Format, verify, and enforce the production line budget

**Files:**
- Verify all files listed above
- Do not modify: `cli/src/**`
- Do not modify: `supabase/schemas/prod.sql`

- [ ] **Step 1: Format only touched files before validation**

Run targeted formatters so unrelated user changes are not rewritten:

```bash
bunx oxlint --fix supabase/functions/_backend/utils/bento.ts supabase/functions/_backend/utils/user_bento_events.ts supabase/functions/_backend/private/events.ts
bunx eslint --fix src/services/userOnboardingWriteQueue.ts src/components/dashboard/AppOnboardingFlow.vue
bunx sqlfluff fix --dialect postgres supabase/migrations/*_raise_users_onboarding_limit_for_bento_events.sql
```

Expected: no unrelated files change.

- [ ] **Step 2: Run all focused tests**

```bash
bunx vitest run tests/bento-response-acceptance.unit.test.ts tests/bento-abort-signal.unit.test.ts tests/user-bento-events.unit.test.ts tests/user-bento-event-delivery.unit.test.ts tests/user-onboarding-write-queue.unit.test.ts tests/app-onboarding-progress-integration.unit.test.ts tests/user-onboarding-progress.unit.test.ts
bun run supabase:with-env -- bunx vitest run tests/users-onboarding-size.test.ts tests/user-bento-events.test.ts tests/events.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run backend and frontend static checks**

```bash
bun run lint:backend
bun run lint
bun run typecheck:backend
bun run typecheck:frontend
```

Expected: all commands exit 0.

- [ ] **Step 4: Run the applicable repository suites**

```bash
bun run test:unit
bun run test:backend:integration
```

Expected: both suites PASS. If a Supabase integration test fails, inspect the
relevant database/function/worker logs before retrying, as required by repository
guidance.

- [ ] **Step 5: Verify additive SQL and forbidden-scope exclusions**

Run:

```bash
rg -n "SET onboarding =" supabase/functions/_backend/utils/user_bento_events.ts
rg -n "jsonb_set|bento_events" supabase/functions/_backend/utils/user_bento_events.ts
git diff --name-only 66a43ef09..HEAD
```

Expected:

- Both helper writes use `jsonb_set` and merge the existing nested object with
  `|| $2::jsonb`.
- No helper query assigns the complete `onboarding` value from a parameter.
- No `cli/src/**`, `supabase/schemas/prod.sql`, queue, cron, or outbox file is in
  the implementation diff.

- [ ] **Step 6: Calculate the production line count**

Run:

```bash
git diff --numstat 66a43ef09..HEAD -- . ':(exclude)tests/**' ':(exclude)docs/superpowers/**' | awk '{ added += $1; removed += $2 } END { print "production_changed_lines=" added + removed }'
```

Expected: `production_changed_lines` is at most `1000`. If it exceeds 1,000,
stop and simplify the implementation; do not waive the limit.

- [ ] **Step 7: Inspect the final diff and commit formatter-only corrections**

```bash
git diff --check
git status --short
git diff --stat 66a43ef09..HEAD
```

Expected: no whitespace errors, no unplanned files, and no uncommitted source
changes. If targeted formatting changed tracked files after their task commits:

```bash
git add supabase/functions/_backend/utils/bento.ts supabase/functions/_backend/utils/user_bento_events.ts supabase/functions/_backend/private/events.ts src/services/userOnboardingWriteQueue.ts src/components/dashboard/AppOnboardingFlow.vue supabase/migrations/*_raise_users_onboarding_limit_for_bento_events.sql
git commit -m "style: format CLI Bento event delivery"
```

Skip this final commit when formatting produced no tracked changes.

## Completion Criteria

- All three and only three source events map to the agreed Bento names.
- The actor-scoped login event remains post-validation; `notifyConsole` copies
  remain excluded.
- Transaction 1 commits bounded details before background work is scheduled.
- Transaction 2 holds the complete user-row lock through a maximum five-second
  Bento batch call.
- `sent_at` is committed only after the complete batch is accepted.
- A process death after Bento acceptance but before commit leaves the entry
  retryable and may produce an intentional duplicate.
- Later mapped events retry every pending mapped entry for that user.
- Both database writes additively merge only `onboarding.bento_events`; every
  unrelated JSON key survives.
- The database accepts up to 65,536 bytes for the complete onboarding JSON.
- PostHog and existing organization-member Bento behavior remain unchanged.
- Production changed lines are at most 1,000.
