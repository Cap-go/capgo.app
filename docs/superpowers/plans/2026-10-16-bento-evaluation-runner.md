# Generic Bento evaluation runner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement task-by-task.

**Goal:** Replace invitation partitions and database reminder scheduling with the approved generic TypeScript evaluation runner.

**Architecture:** The minutely producer schedules due named evaluations using run history. Each queue invocation selects read-only, queues the complete eligibility audit, and handles candidates through durable audited mutation helpers. Exactly two private tables store event history and evaluation runs; pending analytics shares those tables.

**Tech Stack:** TypeScript, Cloudflare Worker/Queues/Hyperdrive, PostgreSQL, existing Bento transport and PostHog queue, Vitest and pgTAP.

## Task 1: Contracts, schema, and storage

- [x] Define evaluation, eligible-user metadata, run, ledger, audit, and helper contracts under `cloudflare_workers/bento_dispatch/`.
- [x] Rewrite `supabase/migrations/20261015164155_bento_invitation_dispatches.sql` into the two-table private schema described by the approved specification. Remove the enrollment SQL trigger/function and schedule/partition columns; add explicit grants, RLS denial, unique keys, active-flow/run/pending-audit indexes.
- [x] Implement transactional schedule/publication/execution claims, read-only database execution, selection persistence, event claims/acknowledgements, termination, audit append/handoff in `store.ts`.
- [x] Replace pgTAP and real PostgreSQL tests; prove 1/5-minute cadence, overlap/fencing, max-five attempts, read-only SQL rejection, and mutation/audit atomicity.

## Task 2: Generic runner and audited helpers

- [x] Write failing tests for registry dispatch, unknown jobs, pure finder capability boundary, eligibility audit before handling, empty cohorts, full multipart lists, handler failure, duplicate replay, and audit-only replay.
- [x] Implement `bentoFlows.ts`, `scheduler.ts`, `consumer.ts`, shared helpers/audit serialization, and Worker entrypoints. Validate audit envelopes using existing PostHog schema and byte accounting.
- [x] Keep each queue message as `{ version: 1, evaluationKey, runId }`, validate against the registry, and use the same generic consumer for every evaluation.
- [x] Preserve bounded runtime/provider concurrency with no fixed invitation divisions. Persist outcomes per logical event and retry pending analytics without replaying accepted sends.

## Task 3: Invitation definitions and initial-send fact

- [x] Implement four whole-cohort read-only queries in `flows/invitations.ts`, each following prior event history and current source state. Return both send and termination candidates with decision metadata.
- [x] Implement handlers using shared helpers only; preserve approved reminder timing, tags, body escaping, plain subject field, and HTTPS-origin URL validation.
- [x] Record the initial flow fact inside `cloudflare_workers/api/triggers/org_invitation_email.ts`'s existing acceptance transaction, with durable pending audit. No new database trigger schedules reminders.
- [x] Test both variants end-to-end, acceptance/deletion distinction, resend generations, expiry and previous-reminder timestamps, and terminal completion.

## Task 4: Wiring, documentation, and verification

- [x] Bind the existing PostHog queue in Worker configuration and update deployment dependency matching. Retain one evaluation queue with batch size one and at most five delivery attempts.
- [x] Update feature/cutover documentation and remove obsolete plan descriptions that suggest partitions or enrollment triggers. Keep deferred Bento recreation assets clearly distinguished from executable TypeScript definitions.
- [x] Run lint before validation, then targeted feature tests and real database tests/pgTAP; inspect indexed plans. Run full UTC unit suite, typecheck, and production Worker dry-run.
- [ ] Obtain separate specification and quality reviews, address findings, commit/push, update PR description, pass CI, undraft for automatic review, and establish stable-green twice 300 seconds apart. Preserve unrelated `codedb.snapshot` and exclude generated Graphify changes.

Local verification: 3,954 UTC unit tests, 31 real PostgreSQL integration tests,
24 pgTAP checks, frontend/backend lint, full typecheck and production Worker
dry-run pass. Independent specification and code-quality reviews are clear.
Remote CI, automatic review and stable-green verification remain the final PR
gates. Local draft-schema rows were preserved before local replacement; no
remote database or live Bento configuration was changed.
