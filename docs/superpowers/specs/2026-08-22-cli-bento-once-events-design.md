# CLI Bento Once-Per-User Events Design

**Status:** Approved for implementation planning

**Date:** 2026-08-22

## Summary

Attempt delivery of exactly three existing CLI analytics events until the
database records one successful Bento acceptance for that user:

| Existing event | Bento event |
| --- | --- |
| `CLI Command Invoked` | `cli:command_invoked` |
| `User CLI login` | `cli:login_successful` |
| `onboarding-run-started` | `cli:onboarding_run_started` |

The backend records bounded event observations in
`public.users.onboarding.bento_events`, then schedules a second transaction that
locks the user row while calling Bento. A successful Bento response is followed
by `sent_at` and a commit. Failure rolls back only the delivery transaction, so
the previously committed observations remain available for a later attempt.

This deliberately provides at-least-once external delivery. A process may die
after Bento accepts an event but before PostgreSQL commits `sent_at`; the next
attempt can therefore send a duplicate. This is preferable to losing the event.

## Goals

- Send the three listed Bento events once per Capgo user during normal
  operation.
- Preserve observations before starting non-durable background work.
- Serialize concurrent deliveries by locking the complete `public.users` row.
- Retry pending events opportunistically when the user later produces any of
  the three mapped events.
- Make another event easy to add through one explicit mapping entry.
- Reuse the existing `/private/events` route, authenticated actor identity,
  PostgreSQL client, background execution adapter, and Bento transport.
- Keep changed production code below 1,000 lines, counting additions plus
  deletions and excluding tests and design/plan documents.

## Non-goals

- Handling Ctrl-C or adding any cancellation event.
- Forwarding arbitrary CLI or PostHog events to Bento.
- Changing the CLI event names, timing, or payloads.
- Providing exactly-once delivery across PostgreSQL and Bento.
- Adding an outbox table, pgmq queue, cron, sweeper, or autonomous retry worker.
- Backfilling users who produced these events before deployment.
- Changing the existing PostHog path or the existing organization-member Bento
  notification path.

## Existing Event Semantics

- `CLI Command Invoked` already carries privacy-safe command context. Login and
  init defer this event until their API key has been validated.
- The actor-scoped `User CLI login` event is emitted by
  `validateAndSaveKey()` only after successful API-key validation and local key
  persistence. Browser-login `notifyConsole` copies remain Realtime-only and
  must not enter this Bento path.
- `onboarding-run-started` is already emitted by the init telemetry helper after
  authentication is available. No CLI code needs to change.

## Stored State

Use the existing `public.users.onboarding` JSON object:

```json
{
  "bento_events": {
    "cli:onboarding_run_started": {
      "occurrence_count": 2,
      "details": [
        {
          "observed_at": "2026-08-22T10:00:00.000Z",
          "source_event": "onboarding-run-started",
          "onboarding_journey_id": "ij_first",
          "onboarding_run_id": "ir_first",
          "resume_available": false
        },
        {
          "observed_at": "2026-08-22T10:01:00.000Z",
          "source_event": "onboarding-run-started",
          "onboarding_journey_id": "ij_second",
          "onboarding_run_id": "ir_second",
          "resume_available": true
        }
      ],
      "sent_at": "2026-08-22T10:01:01.000Z"
    }
  }
}
```

`sent_at` is absent while an event is pending and is an ISO timestamp after
Bento accepts it. A present, valid `sent_at` is terminal and later occurrences
do not change the entry.

`occurrence_count` increments for every observation recorded before successful
delivery. `details` retains at most five objects: the first observation and the
four most recent observations. Every mapping owns a small allowlist of fields;
raw request bodies, secrets, API keys, email addresses, descriptions, and
`$session_id` are never copied into this JSON.

The initial mappings retain:

- Common fields: `observed_at`, `source_event`, and validated `org_id`/`app_id`
  when available.
- `cli:command_invoked`: `command_path`, `flags`, `flags_count`, and
  `positional_arg_count`.
- `cli:login_successful`: no event-specific fields.
- `cli:onboarding_run_started`: `onboarding_event_version`,
  `onboarding_journey_id`, `onboarding_run_id`, `resume_available`,
  `resume_journey_id`, `resumed_from_run_id`, `saved_step`, and `total_steps`.

String fields are length-bounded before persistence. Invalid or unexpected
properties are omitted.

The current database constraint limits the complete `onboarding` object to
8,192 bytes, while the frontend may already use approximately 8,000 bytes.
A small migration raises this limit to exactly 65,536 bytes (64 KiB). The event
history remains bounded; the larger limit guarantees ample room beside existing
wizard state and avoids another constraint migration as a few more deliberately
mapped lifecycle events are added later. No table, column, index, function, or
extension is added.

## Event Registry

Use one data-only registry. Each entry declares the Bento name and a typed,
bounded allowlist of properties copied from `trackedBody.tags`. A shared detail
builder adds `observed_at`, `source_event`, and validated request context, then
applies these descriptors. The following is the intended shape, not a separate
framework:

```ts
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
} as const
```

The lookup and detail-building flow is deliberately small:

```ts
const mapping = getCliBentoEventMapping(trackedBody.event)
if (!mapping)
  return

const details = buildMappedDetails(mapping, trackedBody.tags, {
  sourceEvent: trackedBody.event,
  observedAt,
  orgId: verifiedOrgId,
  appId,
})
```

`buildMappedDetails()` supports only bounded strings, integers, and booleans.
It ignores missing values, type mismatches, unknown properties, and non-finite
numbers. It does not receive or spread the full body. The lookup should use a
small type guard rather than weakening the request type with an unrestricted
index signature.

Unmapped events therefore perform no user-Bento database or network work.
Adding a future event with these primitive field types requires one registry
entry and tests. There is no generic name transformation because
`User CLI login` intentionally maps to the semantic name
`cli:login_successful`, and arbitrary forwarding would create volume and data
exposure risks. If a future event needs computed details, that requirement can
be designed then instead of adding an override mechanism now.

## Request and Delivery Flow

The user-Bento path is integrated after `/private/events` has authenticated the
request and resolved `trackingUserId`. It is independent of the existing
PostHog and organization-member notification payloads.

### Fast check

For a mapped event, read the actor's `public.users.onboarding` through one
primary-key lookup. If the current mapping has `sent_at` and no other mapped
entry is pending, stop all user-Bento work. This makes the steady-state cost one
bounded indexed read and avoids a row lock, write, or Bento call.

### Transaction 1: durable observation

When the current event is not already sent:

1. Begin a transaction using the existing PostgreSQL client.
2. Select the actor's `public.users` row `FOR UPDATE`.
3. Re-read `onboarding.bento_events[eventName].sent_at` under the lock.
4. If it now exists, commit without appending.
5. Otherwise append the sanitized detail, increment `occurrence_count`, preserve
   the first plus four latest details, update `onboarding`, and commit.

The API waits for this transaction to finish. PostgreSQL releases the row lock
at commit; no lock is expected to survive between transactions.

After Transaction 1 commits, or when the fast check found another pending
mapped entry, register Transaction 2 with the existing
`backgroundTask`/`waitUntil` adapter. Then the endpoint can return its existing
success response.

### Transaction 2: serialized Bento delivery

1. Begin a new transaction and select the same user's `email` and `onboarding`
   fields `FOR UPDATE`.
2. Collect all of the three mapped entries that have observations but no
   `sent_at`.
3. If none remain, commit and stop.
4. Send all pending entries to the locked row's email in one Bento batch while
   retaining the row lock. Each Bento event receives `occurrence_count` and the
   retained observations as its details. Apply a five-second request timeout.
5. Only when Bento reports the expected result count with zero failures, set
   `sent_at` on every event in that batch and commit.
6. On a false result, missing Bento configuration, timeout, thrown error, or
   partial batch failure, roll back. Transaction 1's observations remain.

Extend the existing Bento batch helper rather than introducing another HTTP
client. The existing single-event `trackBentoEvent()` delegates to the batch
form so current callers retain their behavior.

## Concurrency and Failure Semantics

- Concurrent Transaction 1 calls serialize on the user row, so observation
  counts and arrays do not overwrite each other.
- Concurrent Transaction 2 calls serialize on the same row. After the first
  successful commit, later calls see `sent_at` and stop.
- If execution dies after Transaction 1 and before Transaction 2, details remain
  pending. Any later mapped event schedules delivery of every pending mapping.
- If Bento accepts the batch and execution dies before commit, PostgreSQL rolls
  back. A later request sends the batch again, intentionally allowing a
  duplicate instead of losing it.
- If Bento is unavailable or returns a partial failure, no `sent_at` value from
  that batch is committed. Retrying may duplicate entries Bento already
  accepted.
- If no later mapped request arrives, pending observations remain inspectable
  but are not retried autonomously. This is the accepted consequence of not
  adding a queue or sweeper.
- The five-second Bento timeout bounds how long the user row and database
  connection are held across the external request.

## Coexistence With Existing Onboarding Writers

Frontend onboarding persistence currently rebuilds and conditionally replaces
the complete `users.onboarding` JSON object. Its conflict retry correctly sees a
concurrent backend change, but it must also preserve the validated
`bento_events` subtree when constructing its next replacement value. Otherwise
it could erase `sent_at` and permit a duplicate delivery.

Add a small preservation helper alongside the existing onboarding-write
helpers, and apply it in the existing wizard replacement path in the same place
that admin dashboard metadata is preserved. Other known production writers
already spread the latest JSON object and therefore retain the subtree.

## Error Handling and Observability

- User-Bento failures never fail CLI telemetry or the CLI command.
- Transaction errors are logged with the request ID, source event, Bento event,
  user ID, phase (`observe` or `deliver`), and sanitized error. Details and
  email are not logged.
- Bento failures continue to use the existing Bento helper logging and also
  leave the entry pending.
- PostHog continues through the existing `sendEventToTracking()` path regardless
  of the user-Bento result.
- `sent_at` means Bento's batch endpoint accepted the event with the expected
  result count and zero failures. It does not claim that a downstream Bento
  automation completed.

## Components and Expected Change Size

Keep the implementation narrow:

- One focused backend helper containing the registry, state parsing, fast check,
  two transactions, and scheduling orchestration.
- A small batch extension to the existing Bento helper.
- A short call site in `/private/events` after authenticated actor resolution.
- One frontend preservation helper and one wizard call-site adjustment.
- One constraint-only migration.
- Focused tests.

No CLI production file should change. The expected production diff is well
below 1,000 changed lines. Before completion, calculate additions plus deletions
for non-test files while excluding `docs/superpowers/specs` and implementation
plans; the result must be at most 1,000.

## Testing

### Pure unit coverage

- Every exact source event maps to the expected Bento name.
- Unmapped names do no user-Bento work.
- Each detail builder retains only its allowed, validated, bounded properties.
- Details retain the first plus four latest observations while
  `occurrence_count` continues increasing.
- Invalid stored state is handled conservatively and never treated as a valid
  `sent_at` marker.
- The frontend preservation helper retains `bento_events` without exposing it
  as resumable wizard progress.

### Transaction and endpoint coverage

- A mapped event commits its observation before background delivery starts.
- A successful Bento batch sets `sent_at` once.
- A Bento failure, timeout, or partial result leaves details and omits
  `sent_at`.
- Failure after Bento acceptance but before commit leaves the event retryable.
- Two concurrent deliveries serialize and only the first successful transaction
  calls Bento after obtaining the row lock.
- A later different mapped event retries all pending entries for the user.
- An already-sent event performs no write or Bento call when nothing else is
  pending.
- `notifyConsole` login copies remain excluded.
- Existing PostHog delivery still runs when user-Bento recording or delivery
  fails.
- Frontend wizard conflict retry preserves a concurrently written
  `bento_events` subtree.

### Database coverage

- The revised constraint accepts a bounded wizard plus Bento payload below
  65,536 bytes and rejects a payload above the limit.
- Transaction tests use a dedicated user because they mutate
  `public.users.onboarding` and test files run in parallel.

### Completion gates

Run focused unit and backend integration tests, the required Postgres-level
migration test, backend/frontend lint and type checks for touched code, and the
production LoC calculation before handoff.
