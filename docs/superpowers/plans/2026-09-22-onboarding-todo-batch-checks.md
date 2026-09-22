# Onboarding Todo Batch Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing onboarding refresh queue complete evidence-backed todo items without checking steps already done or adding another queue.

**Architecture:** Keep the SQL producer, 25-app messages, four-message-per-minute consumer, and existing feature refresh intact. After the feature refresh, collect Postgres channel and finished-bundle evidence and bounded, grouped Cloudflare Analytics Engine device and `set` evidence for pending steps. Re-read and lock current app rows only for the final todo merge, preserving unrelated onboarding JSON and concurrent CLI reports.

**Tech Stack:** TypeScript, Hono, Drizzle/Postgres, Cloudflare Analytics Engine SQL API, Vitest.

---

## Boundaries and decisions

- `add_channel`: check any queued app with a supported v1/v2/v3/v4 todo list when that step is not done and the setup outcome is not skipped. Mark done on positive Postgres evidence only; never reopen a completed step when a channel is removed.
- `run_device`, `upload_bundle`, and `test_update`: check only v3 or v4 OTA v1 apps, only while each respective step is not done and the setup outcome is not skipped. Leave CLI-reported steps alone.
- Cloudflare `device_info`: require a nonempty `blob1` device ID for the app. Cloudflare `app_log`: require `blob2 = 'set'`, nonempty `blob1`, and a non-builtin/non-unknown `blob3` version name. Match the returned version name to the same app's non-revert `app_versions` in Postgres and require the event time to be no earlier than app creation.
- Group at most five app IDs per Analytics Engine query. Run no more than four queries concurrently, so one 25-app message normally uses at most five device queries and five `set` queries. Return at most 50 grouped `set` app/version pairs per group, ordered by most recent event. If a group reaches the cap, use at most five additional exact app-and-valid-version queries for unmatched apps; skip and log any exact query exceeding 8 KB. Thus one message makes at most 15 Analytics Engine requests, and only positive matches may change a step.
- Analytics Engine samples and retains data for three months. Missing evidence is never proof that a step should be undone. Use a three-month lookback floor to bound scans. Cloudflare query failures must remain distinguishable from empty results; log them and leave the affected steps pending so the next producer cycle can check again, without exhausting the queue's five-attempt retry budget.
- Do not hold an app-row lock or a database transaction open across a Cloudflare API request. After gathering evidence, lock selected `apps` rows in app-ID order, re-read current todo state, merge positive observations only, append step history, call `try_complete_pending_onboarding_if_setup_done`, and commit. A duplicate queue delivery remains idempotent.
- The existing feature refresh may already have advanced `refreshed_at` when todo refresh fails; todo checks must therefore run independently of its stale-message early return. No schema change, new queue, or new cron job.

## File map

- Create `supabase/functions/_backend/utils/app_onboarding_todo_evidence.ts`: candidate selection, batched Postgres evidence, bounded Analytics Engine query builders and reads.
- Create `supabase/functions/_backend/utils/app_onboarding_todo_refresh.ts`: final row-locking transaction, positive-only merge, history, completion, and system-originated change events.
- Modify `supabase/functions/_backend/triggers/cron_onboarding_refresh_apps.ts`: invoke the todo refresh after the existing feature refresh, even if the feature refresh returns zero.
- Modify `supabase/functions/_backend/utils/app_onboarding_posthog.ts`: allow a system-originated step event without attributing it to a human user.
- Add `tests/app-onboarding-todo-evidence.unit.test.ts` for filtering, SQL shape, bounds, and failures.
- Add `tests/cron-onboarding-todo-refresh.test.ts` for Postgres parity, locks, replay safety, version handling, and JSON preservation.

### Task 1: Establish the evidence contract

**Files:** Create `supabase/functions/_backend/utils/app_onboarding_todo_evidence.ts`; test `tests/app-onboarding-todo-evidence.unit.test.ts`.

- [ ] Write tests asserting these exact selections: v1/v2 only request a channel check; v3 and v4 OTA v1 request each missing evidence-backed step; done and skipped setups request none; unsupported v4 paths request none.
- [ ] Run `bunx vitest run tests/app-onboarding-todo-evidence.unit.test.ts`; expect failure because the evidence module does not exist.
- [ ] Implement a pure selector with this public contract:

```ts
export interface TodoEvidenceCandidate {
  appId: string
  createdAt: string
  onboarding: unknown
}
export interface TodoEvidenceNeeds {
  channel: boolean
  device: boolean
  bundle: boolean
  update: boolean
}
export function getTodoEvidenceNeeds(onboarding: unknown): TodoEvidenceNeeds
```

Use `parseAppOnboarding`, `getAppOnboardingStepIds`, and `hasSupportedOtaTodoList`; a step is needed only when its status is not `done`. Reject `outcome === 'skipped'`.
- [ ] Rerun that test file; expect all selector cases to pass.
- [ ] Commit the selector and its test as `feat(onboarding): select pending todo evidence checks`.

### Task 2: Gather bounded evidence

**Files:** Extend `supabase/functions/_backend/utils/app_onboarding_todo_evidence.ts`; extend `tests/app-onboarding-todo-evidence.unit.test.ts`.

- [ ] Write failing tests for zero Analytics Engine requests when no device/update step is pending, groups of at most five IDs, at most ten normal requests or fifteen with saturated-group fallback for 25 apps, escaped IDs, a 50-row `set` result cap, version matching, and explicit failure reporting. Verify that a full 50-row response never marks an unmatched app done.
- [ ] Run `bunx vitest run tests/app-onboarding-todo-evidence.unit.test.ts`; expect the new tests to fail.
- [ ] Implement query builders equivalent to:

```sql
SELECT index1 AS app_id FROM device_info
WHERE index1 IN ('app-a', 'app-b') AND blob1 != ''
GROUP BY index1 LIMIT 5
```

```sql
SELECT index1 AS app_id, blob3 AS version_name,
  max(timestamp) AS last_set_at
FROM app_log
WHERE index1 IN ('app-a', 'app-b')
  AND blob2 = 'set' AND blob1 != ''
  AND blob3 NOT IN ('builtin', 'unknown')
  AND timestamp >= toDateTime('2026-06-22 00:00:00')
GROUP BY index1, blob3
ORDER BY last_set_at DESC LIMIT 50
```

Use `escapeSqlString`, `formatDateCF`, and `runQueryToCFA` from `cloudflare.ts`. Bound the time filter to the later of the earliest candidate creation and the Analytics Engine retention floor. Implement concurrency four using a small fixed worker pool. If 50 grouped rows are returned, use an exact query for each unmatched app in that group, filtering `blob3 IN (<that app's non-revert version names>)`, with at most five such follow-ups per message. Return positive app-ID sets plus per-query errors/truncation metadata; do not call `readDevicesCF` or `readStatsCF` because they turn errors into empty arrays.
- [ ] Add one batched Postgres query for channel existence and another for finished bundles plus candidate version names. Match `hasPublishedBundle` semantics: live non-builtin/non-unknown, non-revert version and `manifest_count > 0`, nonempty `external_url`, or positive `app_versions_meta.size`. Query version names only for apps missing `test_update`; compare Cloudflare `last_set_at` with each app's `created_at`.
- [ ] Rerun the focused unit tests; expect all bounds and matching cases to pass.
- [ ] Commit as `feat(onboarding): batch todo evidence lookups`.

### Task 3: Merge observations without overwriting progress

**Files:** Create `supabase/functions/_backend/utils/app_onboarding_todo_refresh.ts`; modify `supabase/functions/_backend/utils/app_onboarding_posthog.ts`; test `tests/cron-onboarding-todo-refresh.test.ts`.

- [ ] Write database tests with dedicated apps for v1, v2, v3, and v4 OTA v1. Set a completed step before the worker writes and assert its `at` and history survive. Assert v4 writes under `setup.steps.ota`, v3 writes under `setup.steps`, arbitrary JSON fields survive, and duplicate messages add no history entry. Simulate a concurrent CLI step report before lock acquisition and assert it survives.
- [ ] Run `bunx vitest run tests/cron-onboarding-todo-refresh.test.ts`; expect failure while the refresh module does not exist.
- [ ] Implement `refreshAppOnboardingTodoBatch(c, database, body)`: load candidates and gather Cloudflare/Postgres evidence outside a write transaction; begin one Drizzle transaction; set `lock_timeout = '5s'`; select current `apps` rows `ORDER BY app_id FOR UPDATE`; recompute needs from the locked JSON; create a patch containing only newly observed `status: 'done'` steps; use `applyAppOnboardingPatch` and `appendAppOnboardingStepHistory`; update only changed rows and invoke `public.try_complete_pending_onboarding_if_setup_done(app_id)`. Do not gate this function on `refreshed_at < queuedAt`.
- [ ] Emit step-history events after commit with a distinct app-scoped system identity and `auth_type: 'system'`, preserving human-authored endpoint events and PostHog insert-ID deduplication.
- [ ] Rerun database tests and the existing `tests/onboarding-progress-endpoint.unit.test.ts`; expect success.
- [ ] Commit as `feat(onboarding): persist observed todo milestones from queue`.

### Task 4: Connect the existing consumer and validate

**Files:** Modify `supabase/functions/_backend/triggers/cron_onboarding_refresh_apps.ts`; extend `tests/app-onboarding-refresh.unit.test.ts` and `tests/cron-onboarding-todo-refresh.test.ts`.

- [ ] Write a test that the handler calls the todo refresh after feature refresh, including when the feature refresh returns zero for a replayed message.
- [ ] Run the focused test and confirm it fails before wiring.
- [ ] Wire the endpoint in this order:

```ts
const refreshed = await refreshAppOnboardingBatch(database, parsed.data)
const todo = await refreshAppOnboardingTodoBatch(c, database, parsed.data)
cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh batch finished', requested: parsed.data.appIds.length, refreshed, todo })
return c.json(BRES)
```

- [ ] Run `bun lint:backend`, `bunx vitest run tests/app-onboarding-todo-evidence.unit.test.ts tests/app-onboarding-refresh.unit.test.ts tests/onboarding-progress-endpoint.unit.test.ts`, `bunx vitest run tests/cron-onboarding-refresh.test.ts tests/cron-onboarding-todo-refresh.test.ts` against local Supabase, and `bun typecheck`. Run `bun test:unit` and the relevant backend integration suite before PR creation. Expect all required checks to pass; inspect Supabase service logs before retrying any failing DB test.
- [ ] Inspect `git diff --check`, the feature/step paths in the final diff, and `graphify-out/` exclusion. Commit the endpoint wiring and tests as `feat(onboarding): refresh pending todo steps in cron batches`.

### Task 5: Open and prove the pull request

**Files:** Plan and code commits on `wolny/onboarding-todo-cron`.

- [ ] Push the branch and create a normal, non-draft PR against current `main`; explain that the producer and queue limits do not change, and that Cloudflare Analytics sampling/three-month retention can delay a positive match.
- [ ] Invoke the `pr-ready` skill. Inspect required checks, reviews, mergeability, and any unresolved threads. Fix actionable failures and restart the observation window after a push.
- [ ] Record two fresh stable-green observations at least five minutes apart on unchanged head and base SHAs before reporting the PR merge-ready.

## Self-review

- The selector covers channel checks across all supported todo versions and the three observed v3/v4 OTA milestones.
- The Analytics Engine reader is bounded by five IDs per grouped query, 50 grouped `set` rows, at most fifteen requests, four simultaneous requests, and a three-month time floor. It never interprets missing sampled data as a negative update.
- The final merge rechecks status under app-row locks, preserves unrelated JSON, and does not depend on the feature refresh replay check.
- Tests cover positive evidence, no evidence, Cloudflare errors, idempotency, concurrent CLI progress, version-specific JSON paths, and source event attribution.
