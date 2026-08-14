# CLI Init Onboarding Telemetry Identities Design

## Goal

Give the classic `capgo init` onboarding flow stable identities for individual
CLI invocations, resumable onboarding journeys, and terminal replays. Add the
minimum lifecycle events needed to understand when a run starts, when resume is
offered, which resume choice is made, and how the run ends.

This design establishes the correlation contract required for a later, separate
project that will instrument granular prompts, decisions, automated checks, and
recovery paths.

## Scope

This design applies only to classic `capgo init` and its `onboarding-v2` event
channel.

It does not change:

- `capgo build init` or its existing Builder journey telemetry;
- frontend onboarding analytics or `onboarding_attempt_id`;
- terminal replay delivery;
- the existing authenticated event transport;
- PostHog, LogSnag, or Bento backend behavior;
- onboarding steps, questions, decisions, or recovery behavior;
- database schemas or backend endpoints.

Fine-grained prompt/check instrumentation is explicitly deferred to a future
design. This change provides the identities and typed telemetry context that
future instrumentation will reuse.

## Current Behavior

Classic `capgo init` emits milestone events through the `onboarding-v2` channel,
including events such as `onboarding-step-add-updater`,
`onboarding-step-upload`, `onboarding-step-done`, and `canceled`.

When terminal replay is active, the replay recorder creates a random
`$session_id` with the `init-` prefix. `markInitSnag` attaches that identifier to
onboarding events, which lets PostHog associate those events with the replay.
The replay identifier is not persisted, and replay-disabled runs have no
`$session_id`.

The current progress file persists operational state such as the completed
step, organization, app, selected paths, channel, platform, version, and
temporary onboarding summaries. It does not persist a telemetry journey or the
run that last updated progress.

The resume prompt appears only after authentication and validation of saved
progress. It is not literally the first operation in the CLI. Progress may be
absent, legacy, invalid, or inaccessible, in which case the prompt is not shown.

## Identity Model

The model has three independent identities.

### Terminal replay session

`$session_id` is owned by terminal replay. It is randomly generated for each
replay-enabled `init` invocation, remains unchanged for that invocation, and is
never saved in the progress file.

Its only responsibility is associating ordinary PostHog events with the
`$snapshot` events that make up one terminal replay. When replay is inactive,
events omit `$session_id`.

### Onboarding run

`onboarding_run_id` identifies exactly one `capgo init` process invocation,
including invocations without terminal replay. It uses the form:

```text
ir_<UUID>
```

It is generated when `init` begins and never changes during that invocation.

### Onboarding journey

`onboarding_journey_id` identifies one logical attempt to complete onboarding,
possibly across several accepted resumes. It uses the form:

```text
ij_<UUID>
```

Every invocation begins with a fresh run ID and a fresh journey ID. If valid
saved progress exists, the saved journey is held separately as
`resume_journey_id` until the user makes a resume decision.

- Choosing `restart` keeps the fresh journey active.
- Choosing `continue` replaces the fresh journey with the saved journey.
- The run ID and replay session ID never change when the journey changes.

The progress file stores the active journey and the run that most recently
accepted or wrote that progress:

```json
{
  "step_done": 2,
  "telemetry": {
    "journey_id": "ij_...",
    "last_run_id": "ir_..."
  }
}
```

On the next invocation, saved `last_run_id` becomes the in-memory
`resumed_from_run_id`. That relationship is included only on resume lifecycle
events; ordinary milestone events need only the active run and journey IDs.

Across multiple accepted resumes, the saved journey remains stable while each
invocation keeps its own fresh run identity:

```text
R1 starts with J1, reaches step 2, and saves J1/R1.
R2 starts with fresh J2, accepts resume from R1, switches to J1, and saves J1/R2.
R3 starts with fresh J3, accepts resume from R2, switches to J1, and completes.
```

The resulting journey is `J1` across runs `R1`, `R2`, and `R3`. The provisional
journeys `J2` and `J3` remain attached only to the pre-decision lifecycle events
from their respective invocations.

## Telemetry Context

Add a dedicated typed telemetry module for classic `init`. It owns:

- run and journey ID generation;
- the fresh journey and optional saved resume candidate;
- `resumed_from_run_id`;
- journey switching after an accepted resume;
- shared event-property construction;
- access to the active replay `$session_id`;
- duplicate guards for lifecycle events.

It does not own onboarding decisions, operational progress, event delivery,
queues, retries, timeouts, flushing, or backend transport.

The command flow calls semantic methods rather than manually reconstructing
identity tags. The intended responsibilities are equivalent to:

```text
recordRunStarted()
recordResumePromptViewed()
recordResumeDecision()
recordExistingMilestone()
recordRunEnded()
```

The exact implementation API may use different method names, but it must keep
the same boundaries and typed event contracts.

## Shared Event Properties

All new lifecycle events and existing `onboarding-v2` milestone events receive:

```text
onboarding_event_version: 1
onboarding_run_id
onboarding_journey_id
$session_id                 when terminal replay is active
```

`onboarding_event_version` versions this classic CLI event contract. It is
separate from backend `tracking_version: 2` and the frontend onboarding
analytics version.

Existing `org_id` and `app_id` continue to be included once known. The new
properties must not contain API keys, user-entered values, file paths, app
names, raw errors, prompt text, or other free-form user data.

## Lifecycle Events

All lifecycle events use the existing `onboarding-v2` channel and authenticated
`/private/events` delivery path.

### `onboarding-run-started`

Emit once after authentication and saved-progress validation, before displaying
the resume prompt or entering step one. Pre-authentication exits are
intentionally outside the measurable cohort.

Without resumable progress:

```text
onboarding_run_id: R1
onboarding_journey_id: J1
resume_available: false
$session_id: S1              when replay is active
```

With resumable progress:

```text
onboarding_run_id: R2
onboarding_journey_id: J2    fresh journey for this invocation
resume_available: true
resume_journey_id: J1        journey stored in progress
resumed_from_run_id: R1      last run stored in progress, when known
saved_step: 2
total_steps: 12
$session_id: S2              when replay is active
```

### `onboarding-resume-prompt-viewed`

Emit immediately before a valid resume prompt becomes visible. The event means
the prompt was genuinely shown, not merely that a local file existed.

```text
onboarding_run_id: R2
onboarding_journey_id: J2
resume_journey_id: J1
resumed_from_run_id: R1      when known
saved_step: 2
total_steps: 12
$session_id: S2              when replay is active
```

### `onboarding-resume-decision`

Emit after one valid `continue` or `restart` choice.

For `restart`, the fresh journey remains active:

```text
onboarding_run_id: R2
onboarding_journey_id: J2
resume_journey_id: J1
resumed_from_run_id: R1      when known
saved_step: 2
choice: restart
```

For `continue`, switch to the saved journey before emitting:

```text
onboarding_run_id: R2
onboarding_journey_id: J1
initial_journey_id: J2
resume_journey_id: J1
resumed_from_run_id: R1      when known
saved_step: 2
choice: continue
```

All later events in that invocation use `R2` and `J1`. The current replay
session remains `S2`.

### Existing milestone events

Retain existing names and success boundaries. Enrich events such as
`onboarding-step-add-app`, `onboarding-step-add-updater`,
`onboarding-step-upload`, `onboarding-step-done`, and `canceled` with the active
run, journey, replay, and event-version properties.

### `onboarding-run-ended`

Emit at most once before a normal CLI exit:

```text
outcome: completed | cancelled | failed
exit_code
```

This is a uniform run boundary and does not replace existing completion,
cancellation, or milestone events. An unflushable termination such as
`SIGKILL` or machine shutdown may leave a started run without an ended event.

## Resume And Progress Transitions

The telemetry context is created before replay and authentication with a fresh
run, fresh journey, and start timestamp. It gains authenticated delivery only
after the existing login path succeeds.

Resume processing then follows this sequence:

1. Read and validate operational progress.
2. Read optional telemetry metadata.
3. Emit `onboarding-run-started`.
4. If valid resumable progress exists, persist any legacy journey backfill.
5. Emit `onboarding-resume-prompt-viewed` immediately before the prompt.
6. Apply and emit the resume decision.

### Fresh progress

When no resumable progress exists, keep the fresh journey active. Do not create
a new step-zero progress file. Persist the journey and current run the first
time `markStepDone` writes meaningful progress.

If the user exits before completing the first persisted step, the run remains
visible in analytics but there is no local progress to resume, matching current
operational behavior.

### Accepted resume

Switch the active journey to the saved `resume_journey_id` before emitting the
decision event. Immediately update the existing progress metadata so
`last_run_id` becomes the current run, while preserving every operational
field.

Updating immediately ensures that accepting resume and then closing before the
next completed step still leaves the correct previous-run relationship for the
following invocation.

### Restart

Delete existing progress as the CLI does today. Keep the fresh journey created
at run start. Persist that journey and current run with the first newly
completed step.

### Repeated prompt abandonment

If a user exits while viewing the resume prompt, the fresh journey remains only
in analytics and is not persisted. The saved progress continues to reference
the original saved journey and last accepted run. The next invocation creates
another fresh run/journey pair and offers the same saved journey again.

### Legacy and malformed metadata

Operational progress without a `telemetry` object remains valid. Generate a
journey ID for that existing progress and persist it before showing the prompt,
so repeated prompt abandonment refers to one stable saved journey.
`resumed_from_run_id` is omitted because legacy progress has no prior run ID.

Missing or malformed telemetry fields are ignored and regenerated. Telemetry
metadata must never cause otherwise valid operational progress to be rejected
or deleted.

## Analytics Opt-Out

`--no-analytics`, `CAPGO_DISABLE_TELEMETRY`, and `CAPGO_DISABLE_POSTHOG` retain
their existing meaning.

When telemetry is disabled:

- emit no new lifecycle or enriched milestone analytics;
- add no new telemetry identifiers to progress;
- preserve existing telemetry metadata whenever the operational progress file
  itself remains; normal restart and completion may still delete that file;
- do not advance `last_run_id` to an invocation that was not tracked.

## Delivery And Failure Handling

Reuse the existing `markSnag`/`sendEvent` delivery path exactly as current
`onboarding-v2` events do.

Do not add or change:

- event queues;
- flushing;
- retries;
- timeouts;
- abort behavior;
- network transport;
- backend event handling.

Existing milestone calls retain their current awaited delivery behavior. New
lifecycle events use the same behavior. The telemetry context's state
transitions do not depend on event delivery succeeding, and existing
best-effort error handling remains responsible for keeping analytics failures
out of the onboarding control flow.

A telemetry metadata persistence failure may produce the existing local
warning, but onboarding continues and the in-memory identities remain usable
for the current invocation.

## Testing

Add focused unit coverage for the telemetry context:

- fresh invocations generate unique `ir_` and `ij_` identifiers;
- `$session_id` is included only when replay provides one;
- a resume candidate adds `resume_journey_id`, `resumed_from_run_id`, and
  `saved_step`;
- `continue` switches to the saved journey before emitting its decision;
- `restart` retains the fresh journey;
- existing milestone events receive the active run and journey IDs;
- lifecycle events cannot accidentally emit twice;
- run completion uses the active journey after any resume decision.

Add progress compatibility coverage:

- new progress writes nested telemetry metadata;
- updating `last_run_id` preserves every operational field;
- accepting resume immediately advances `last_run_id`;
- restart deletes the old journey and later persists the fresh journey;
- legacy progress without telemetry remains resumable;
- a generated legacy journey stays stable across prompt abandonment;
- malformed telemetry does not invalidate operational progress;
- analytics opt-out neither adds nor advances telemetry metadata.

Add focused command-flow coverage:

- `onboarding-run-started` occurs after authentication;
- `onboarding-resume-prompt-viewed` occurs only when the prompt is shown;
- both resume choices carry the approved identity properties;
- existing `onboarding-step-*` and `canceled` events retain their names and gain
  the shared identity properties;
- `onboarding-run-ended` records completed, cancelled, and failed outcomes
  through the existing delivery path.

No new backend, database, or transport tests are required because delivery is
unchanged. Existing CLI analytics, replay, onboarding progress, and guardrail
suites remain part of verification, followed by the repository's CLI check
workflow.

## Future Work

A separate design will define granular instrumentation for user-visible
prompts, answers, automated checks, operation results, retries, manual
fallbacks, skips, support choices, and recovery branches. That work must reuse
the telemetry context and identity contract defined here rather than creating a
second correlation model.
