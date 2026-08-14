# CLI Init Onboarding Telemetry Identities

## Scope

This contract applies only to classic `capgo init` and the `onboarding-v2`
channel. It excludes build init, frontend onboarding, prompt-level telemetry,
and delivery, backend, or terminal-replay changes. Fine-grained prompt,
decision, check, and recovery instrumentation remains future work.

## Identity and Progress Contract

- `$session_id` belongs to terminal replay, is per replay-enabled invocation,
  and is never persisted.
- `onboarding_run_id` (`ir_<UUID>`) is unique to each invocation.
- `onboarding_journey_id` (`ij_<UUID>`) represents a logical onboarding
  attempt and survives accepted resumes.
- Each invocation starts with a fresh run and journey. Saved progress supplies
  a separate `resume_journey_id` and optional `resumed_from_run_id`.
- Before the resume prompt, lifecycle events use the fresh journey. Selecting
  `continue` switches to the saved journey before recording the decision;
  `restart` keeps the fresh journey. Repeated continues retain the journey and
  advance the saved previous-run reference to the current run.

Progress writes nest telemetry without replacing operational fields:

```json
{ "telemetry": { "journey_id": "ij_...", "last_run_id": "ir_..." } }
```

Existing/legacy progress remains resumable; malformed telemetry metadata is
ignored rather than invalidating operational progress. When analytics is opted
out, do not emit this telemetry, add metadata, or advance `last_run_id`; retain
any existing telemetry metadata while the progress file remains.

## Events

All lifecycle events and existing milestone events share:
`onboarding_event_version: 1`, `onboarding_run_id`,
`onboarding_journey_id`, and `$session_id` when replay is active. Existing
`org_id` and `app_id` continue once known.

Record these lifecycle events at most once per invocation:

- `onboarding-run-started` after authentication and saved-progress validation;
- `onboarding-resume-prompt-viewed` immediately before a valid prompt is shown;
- `onboarding-resume-decision` for `continue` or `restart`, including resume
  metadata, the choice, and `initial_journey_id` for continue;
- `onboarding-run-ended` with `outcome` (`completed`, `cancelled`, or `failed`)
  and `exit_code`.

Existing `onboarding-step-*`, completion, and cancellation milestones keep
their names and success boundaries, gaining the shared identity properties.

## Delivery

Lifecycle and enriched milestone events keep the existing best-effort
`markSnag`/`sendEvent` path. No queue, retry, timeout, flush, transport,
backend, replay-delivery, or control-flow changes are part of this work.
