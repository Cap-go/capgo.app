# Frontend Onboarding Resume Telemetry Identities

## Goal

Preserve one logical frontend onboarding attempt across the persisted resume flow
introduced by PR #3062, while distinguishing each browser visit and recording
the resume dialog outcome without duplicating existing step events.

The design follows the CLI identity model from PR #3058 but retains the
frontend's existing `onboarding_attempt_id` nomenclature and underscore-style
event names.

## Problem

`createOnboardingProgressTracker()` currently creates a new
`onboarding_attempt_id` every time `AppOnboardingFlow` mounts. PR #3062 persists
the wizard's operational state in `users.onboarding`, but it does not persist
the analytics attempt identity.

As a result, a user can view and complete early steps under attempt A1, leave,
then continue the same saved wizard under attempt A2. PostHog reports an
abandoned A1 funnel and an unrelated resumed A2 funnel even though the database
correctly treats both visits as one onboarding journey.

## Scope

This change covers the persisted frontend create-app resume dialog and the
shared frontend onboarding event helper. It adds run identity to all events
produced by that helper and preserves attempt continuity when the user accepts
the persisted resume offered by the pre-organization flow.

It does not:

- change the resume dialog, wizard copy, or navigation behavior;
- change PostHog transport, retry, or delivery behavior;
- add frontend run-started or run-ended events;
- reconstruct identities for events captured before this change;
- change the database-backed admin wizard drop-off chart;
- change the existing-org pending-app resume behavior beyond attaching a run ID
  to events produced during that run.

## Identity Contract

Keep these identities distinct:

- `onboarding_attempt_id` is the existing frontend logical-attempt identity. It
  survives an accepted resume and remains the grouping key used by current
  PostHog funnel queries. It retains the existing raw UUID format.
- `onboarding_run_id` identifies one mount of `AppOnboardingFlow`. It uses the
  CLI-compatible `ir_<UUID>` format and is never replaced during that mount.
- `initial_onboarding_attempt_id` appears only on an accepted-resume event. It
  records the fresh attempt generated for the returning mount before that mount
  switches to the saved attempt.
- `resumed_from_run_id` is the previously persisted `last_run_id`, when valid.
  It links a returning run to the most recent run that worked on the saved
  attempt.
- `resume_onboarding_attempt_id` identifies the saved attempt offered by the
  resume dialog while the fresh attempt remains active.

Every mount creates a fresh attempt ID and run ID before inspecting saved
progress. Given saved attempt A1/run R1, the returning mount begins with fresh
attempt A2/run R2. A2 is allowed to remain ephemeral when the user continues
A1; it still identifies the pre-decision dialog event for that mount.

## Persistence Contract

Extend the existing `users.onboarding` JSON object with:

```json
{
  "onboarding_attempt_id": "A1",
  "last_run_id": "R2"
}
```

New writes always store the pair together:

- Fresh onboarding stores A1/R1 with its first progress snapshot.
- While a resume dialog is pending, the saved A1/R1 pair remains untouched.
- Continue retains A1 and replaces `last_run_id` with R2.
- Restart replaces both values with A2/R2.
- Later progress writes in the same run preserve the active pair.

`last_run_id` means the most recent run that worked on the persisted attempt.
Before it is replaced during a later accepted decision, its saved value is
reported as `resumed_from_run_id`.

Operational progress remains valid when telemetry fields are absent or
malformed. The parser ignores invalid telemetry metadata without rejecting the
saved wizard step or form fields. A valid saved attempt without a valid previous
run may still be continued; the next successful write repairs the pair.

The existing JSONB column, size check, and partial step index can contain these
fields without structural changes. To keep the implementation PR small, do not
add a comment-only migration, constraint, column, index, or Postgres test.

## Event Contract

All existing onboarding events emitted through the progress tracker gain
`onboarding_run_id`. They retain their existing names, properties,
`onboarding_attempt_id`, and `onboarding_version` semantics.

Add these lifecycle events:

### `onboarding_resume_dialog_viewed`

Emit at most once per mount, immediately after the valid resume dialog is
opened and before waiting for a decision.

Properties include:

- `onboarding_attempt_id: A2`;
- `onboarding_run_id: R2`;
- `resume_onboarding_attempt_id: A1` when saved metadata contains A1;
- `resumed_from_run_id: R1` when saved metadata contains R1;
- `flow`, `saved_step`, `step_index`, `total_steps`, and
  `onboarding_version`.

No step-view event is emitted while the dialog is pending.

### `onboarding_resume_continued`

When saved progress contains a valid A1, switch the active attempt to A1 before
emitting this event. Emit it at most once per mount.

Properties include:

- `onboarding_attempt_id: A1`, or A2 for legacy progress without a valid saved
  attempt;
- `onboarding_run_id: R2`;
- `initial_onboarding_attempt_id: A2` when the active attempt switched to A1;
- `resumed_from_run_id: R1` when available;
- `flow`, `saved_step`, `step_index`, `total_steps`, and
  `onboarding_version`.

Afterward, progress persistence stores A1/R2.

### `onboarding_resume_restarted`

Keep fresh A2 active and emit this event at most once per mount.

Properties include:

- `onboarding_attempt_id: A2`;
- `onboarding_run_id: R2`;
- `resume_onboarding_attempt_id: A1` when available;
- `resumed_from_run_id: R1` when available;
- `flow`, `saved_step`, `step_index`, `total_steps`, and
  `onboarding_version`.

Afterward, progress persistence stores A2/R2.

## Step-Event Ownership And Ordering

Resume lifecycle handlers do not emit `onboarding_step_viewed` directly and do
not add a watcher for `flowStep`.

Existing flow code remains the sole owner of step-view events:

- `initializeProgressTracking()` emits the first real visible step after
  hydration;
- `completeAndViewStep()` emits the next step during forward navigation;
- `viewPreviousStep()` emits the destination step during backward navigation.

The resume path must preserve this order:

### Continue

1. Open the dialog and emit `onboarding_resume_dialog_viewed` with A2/R2.
2. Switch the active identity to A1/R2.
3. Emit `onboarding_resume_continued` with
   `initial_onboarding_attempt_id: A2`.
4. Restore the saved form and `flowStep` and return `resumed = true`.
5. Let the existing `initializeProgressTracking(true)` call emit exactly one
   `onboarding_step_viewed` for the restored step with A1/R2 and
   `resumed: true`.

### Restart

1. Open the dialog and emit `onboarding_resume_dialog_viewed` with A2/R2.
2. Keep A2/R2 active and emit `onboarding_resume_restarted`.
3. Reset the form, set `flowStep` to `intent`, and return `resumed = false`.
4. Let the existing `initializeProgressTracking(false)` call emit exactly one
   `onboarding_step_viewed` for `intent` with A2/R2 and `resumed: false`.

This ordering prevents a temporary `intent` view before the resume decision and
prevents a duplicate restored-step or restart-step view afterward.

## Architecture

Create a small typed frontend identity context alongside the existing
onboarding analytics helper. It owns:

- fresh attempt and run generation;
- the optional saved resume candidate;
- the active-attempt switch on Continue;
- persisted identity metadata;
- shared resume-event properties;
- at-most-once guards for dialog and decision events;
- best-effort delegation to the existing `pushEvent` service.

`createOnboardingProgressTracker()` stops generating its own attempt ID. Its
caller supplies the active `onboarding_attempt_id` and `onboarding_run_id`, and
the tracker adds both values to existing step, interaction, copy, and dashboard
exploration events.

`AppOnboardingFlow.vue` remains the orchestration layer. It prepares the resume
candidate from parsed progress, records the dialog and decision, applies or
resets wizard state, and only then initializes the existing progress tracker.
It does not build identity properties itself.

`userOnboardingProgress.ts` parses, validates, builds, and clamps the two
optional persisted identity fields. Invalid identity fields are dropped rather
than invalidating otherwise resumable progress.

## Legacy Progress

Saved progress created before this change has no recoverable PostHog attempt or
run identity. Historical events cannot be joined retroactively.

For such progress, the returning mount's fresh A2/R2 pair becomes the active and
persisted pair after either Continue or Restart. The dialog and decision still
emit, but omit unavailable previous-attempt and previous-run properties. All
future resumes of that progress preserve A2 and advance the saved run ID.

## Failure And Race Handling

- Analytics remains best-effort and must never block the dialog, navigation, or
  progress writes.
- A failed progress write may prevent continuity on a later visit, but it must
  not alter the active in-memory identity for the current run.
- The existing `updated_at` compare-and-swap behavior remains authoritative for
  concurrent tabs. A stale tab does not overwrite newer progress merely to
  claim telemetry identity ownership.
- No identity pair is written while initial hydration or the resume decision is
  pending.
- Local development continues to suppress PostHog through `pushEvent`.
- New analytics properties contain only generated IDs, enums, and numeric step
  metadata; they do not include user-entered text.

## Testing

Add deterministic unit coverage for the identity context and integration
coverage for the component lifecycle:

- fresh onboarding creates and persists A1/R1;
- every existing tracker event contains the supplied attempt and run IDs;
- dialog-viewed uses A2/R2 while saved progress remains A1/R1;
- no `onboarding_step_viewed` occurs while the dialog is open;
- Continue emits with A1/R2 and
  `initial_onboarding_attempt_id: A2`;
- initialization emits exactly one restored-step view with A1/R2 and
  `resumed: true`;
- Restart emits with A2/R2;
- initialization emits exactly one `intent` view with A2/R2 and
  `resumed: false`;
- repeated resumes preserve the attempt while advancing R1 to R2 to R3;
- dialog and decision events cannot duplicate within one mount;
- legacy and malformed identity metadata do not break operational resume;
- persistence and capture failures do not interrupt onboarding;
- no new direct `viewStep()` call exists in either resume decision branch.

Extend the existing registration Playwright scenario to retain its functional
Continue/Restart assertions. Keep event-order assertions in deterministic unit
tests where PostHog capture can be injected and observed directly.

## Success Criteria

- A user who continues saved onboarding contributes one
  `onboarding_attempt_id` to the existing PostHog funnel across visits.
- Each browser visit is distinguishable by `onboarding_run_id`.
- Dialog view, Continue, and Restart are independently measurable.
- A pending dialog produces no false `intent` view.
- Continue and Restart each produce exactly one subsequent real step-view event
  through the existing navigation/initialization path.
- Existing PostHog funnel queries and the database-backed admin drop-off chart
  require no behavioral changes.
