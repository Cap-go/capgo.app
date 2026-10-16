# Generic Bento evaluation runner

Approved implementation specification. This replaces the prior invitation
partition/scheduled-reminder implementation in the open PR.

## Required behavior

- One dedicated Cloudflare Worker, one evaluation queue, one message per consumer
  invocation. The existing PostHog queue is reused for analytics.
- `bentoFlows.ts` declares every flow and named evaluation, its cadence in minutes,
  `findEligibleUsers`, and `handleEligibleUsers`. No JSON runtime workflow engine.
- The minutely producer consults durable evaluation-run history and publishes only
  due evaluations. No invitation ID partitions, portions, or pre-scheduled reminder
  rows. Different evaluations execute independently; the same evaluation does not
  overlap while its execution claim is valid.
- Queue bodies contain only a version, evaluation key, and stable run UUID.
- A finder evaluates the whole relevant population using indexed set-based SQL.
  It executes in a database read-only transaction, receives no mutation/provider
  capabilities, and returns recipients/context keys/reasons plus JSON metadata.
  Eligible actions include reminders and termination of obsolete/accepted flows.
- The engine persists the selection, publishes its complete eligibility report
  through the existing PostHog queue, then invokes the handler. Oversized lists are
  split into numbered analytics events with one run ID; never silently truncate.
- Handlers mutate only through shared helpers. Helpers claim and record sends,
  terminate flows, and record external facts. Their database changes and pending
  audit events commit together. Provider acknowledgement is not inbox delivery.
- Pending audit payloads reside in the two existing feature tables; no third
  outbox table or extra analytics queue. The cron retries pending analytics
  independently of expensive evaluation cadences. Analytics handoff failure after
  saved Bento acceptance must not cause another Bento send.
- Every business action records its reason and correlation IDs. Audit: eligibility,
  send attempt, provider acceptance/failure, flow termination, stale-action skip,
  evaluation completion/failure. Technical audit-handoff bookkeeping is not
  recursively audited. Do not export invitation tokens or credentials.
- Exactly two new private tables: `bento_event_dispatches` and
  `bento_evaluation_runs`. Configuration/cadence stays in TypeScript, activation in
  Vault-backed runtime settings, with explicit deployment-time overrides.
- Preserve one CLI-created migration for the feature while its PR is unmerged.
  Remove its new reminder enrollment trigger/function, `partition`, and `due_at`.
  Preserve the already-shipped initial-email queue and compatibility paths.
- The existing Cloudflare initial invitation sender records a `flow:started` fact
  in the same transaction as initial-provider acceptance. It does not enroll
  future reminders. A new generation is a new flow context.
- Active-flow queries exclude closed start records. Terminal reasons distinguish
  accepted, cancelled, expired, removed, superseded, and reminders completed. A
  missing source record alone must not be described as acceptance.
- Four invitation evaluations, each minutely: new/existing reminder 1 after two
  days; existing reminder 2 five days after reminder 1; new final reminder after
  reminder 1, one hour before the current seven-day token expiry. Preserve the four
  approved Bento event tags, template content, safe name escaping, URL checks,
  and distinct plain subject field. Bento edits/publication remain deferred.
- Runtime work and provider concurrency are bounded; no arbitrary fixed recipient
  groups. Unfinished recipients remain eligible for subsequent scheduled runs.
  Per-event and queue-backed delivery attempts never exceed five. Retain the
  accepted rare remote-acceptance/database-write ambiguity; do not claim Bento
  unique-key deduplication.

## Tables

Event ledger: ID; flow/context/recipient/email/tag; recorded/sending/accepted/failed
status; event timestamp; JSON details; claim token/expiry; attempt count/latest
attempt/error; initial-row closed timestamp; latest run ID; pending audit JSON;
created/updated timestamps. Unique flow/context/recipient/tag. Initial facts and
termination are recorded locally; `accepted` is reserved for Bento acknowledgement.

Evaluation runs: ID; evaluation key/scheduled time; pending-publication/queued/
running/completed/failed state; enqueued/started/finished timestamps; independent
publication and execution claim token/expiry/attempts; selection and evaluated
timestamp; outcome summary; last error; pending audit JSON; created timestamp.
Index latest per-evaluation history, unfinished runs, and pending audits.

## Validation

Meaningful unit and real PostgreSQL coverage: cadence, first scheduling and
overlapping cron calls; duplicate publication and execution; read-only enforcement;
whole-cohort selection; multipart PostHog reports and mutation ordering; retry
caps/fencing; both invitation variants; previous-event waits; obsolete/resend/
accepted/cancelled/expired flows; atomic event/audit state; audit replay without
resending; activation/configuration; queue/deployment wiring. Run project lint,
typecheck, unit suite, database/pgTAP integration, and Wrangler production dry-run.
Measure eligibility and run-history plans at representative scale. Finish through
the repository PR lifecycle and two stable-green observations 300 seconds apart.
