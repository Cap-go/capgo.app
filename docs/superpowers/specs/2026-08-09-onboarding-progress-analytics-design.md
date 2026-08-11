# Onboarding Progress Analytics Design

## Goal

Measure movement and abandonment across the frontend app-onboarding flow with
stable semantic PostHog events. This is independent of the app-creation UI
redesign and can be implemented, reviewed, and released separately.

## Current Behavior

The onboarding wizard changes steps through local Vue state while keeping the
same route. PostHog pageviews therefore cannot distinguish steps. Autocaptured
button clicks can provide clues, but translated text and DOM structure make them
an unreliable funnel definition.

The flow currently emits `onboarding_intent_selected` after organization
creation. It does not emit explicit events when a step becomes visible or is
successfully completed.

## Events

Add two explicit frontend events:

- `onboarding_step_viewed`
- `onboarding_step_completed`

Autocaptured clicks and pageviews are not the source of truth for this funnel.

Both events include:

- `flow`: `pre_org` or `existing_org`;
- `onboarding_version`: a stable integer identifying the event and step semantics;
- `step`: the stable step ID (`intent`, `details`, `organization`, `choice`,
  `install`, or `setup`);
- `step_index` and `total_steps`;
- `previous_step` when known;
- `resumed`: whether the flow loaded an existing pending app or resumed step.

`onboarding_step_completed` additionally includes:

- `next_step` when one exists;
- `duration_ms`, measured from the most recent view of that step;
- `store_import_used` on the details step;
- `app_id` only after an app record exists;
- `intent` after the intent step has a selected value.

Do not include app names, store URLs, email addresses, or other user-entered
free text in analytics properties.

## Versioning

Define the onboarding analytics version once in frontend code and attach it to
every viewed and completed event. The first instrumented version is
`onboarding_version = 1`, representing the flow as it exists when this analytics
change ships.

Increment the version when a change would alter funnel interpretation, including:

- adding, removing, reordering, or renaming a step;
- changing what successful completion of a step means;
- splitting one step into multiple steps or merging steps;
- changing which users enter a flow or branch;
- adding or removing a required decision or materially changing the interaction
  being measured inside a step.

Do not increment it for copy edits, styling changes, bug fixes that preserve
event meaning, or additional non-semantic properties. The version is independent
of the Capgo release version.

The simplified app-creation redesign removes required decisions and changes the
interaction measured inside `details`, so that separate change must increment
the constant from version `1` to version `2`. This keeps conversion data from
the old and redesigned details steps separable even though the step ID remains
`details`.

## Event Timing

`onboarding_step_viewed` fires when a real step becomes visible after initial
loading or after a transition. It must not fire for the component's temporary
default state while resume data is loading. Returning to a previous step creates
a new view and starts a new duration measurement.

`onboarding_step_completed` fires only after that step's success boundary:

- `intent`: after a valid intent is selected and Continue is accepted;
- pre-organization `details`: after name and App ID validation succeeds;
- existing-organization `details`: after the app creation request succeeds;
- `organization`: after both the organization and app records exist;
- `choice`: after the user chooses the real-setup path;
- terminal `install` or `setup`: when the user takes the action that exits or
  finishes that step.

Validation failures, API failures, and disabled-button clicks do not emit a
completed event. Viewed-without-completed is the abandonment signal.

## Architecture

Create a small typed frontend helper that builds the shared event properties and
calls the existing `pushEvent` service. Keep the event names, flow names, and
step IDs as narrow string unions so accidental variants fail type checking.
Export the onboarding version as a single constant from this helper rather than
repeating numeric literals at call sites.

Centralize successful transitions in `AppOnboardingFlow.vue`. The transition
path emits `onboarding_step_completed` for the current step, changes `flowStep`,
then allows the new step to emit `onboarding_step_viewed`. Initial and resumed
loading use a separate initialization path so the temporary default step is
never reported.

Store the start time of the current visible step in memory. Each new view resets
that timestamp. Durations therefore describe the current visit to a step, not
the entire browser session. A refresh starts a new measurement.

Keep `onboarding_intent_selected` unchanged for compatibility with existing
reports. The new events supplement it rather than renaming or removing it.

## Failure And Edge Cases

- Local development continues to suppress PostHog through the existing
  `pushEvent` behavior.
- Analytics failures must never block navigation or app creation.
- Rapid or repeated clicks must not emit duplicate completed events for one
  successful transition.
- Back navigation emits a new viewed event and creates a new duration window.
- A resumed flow reports only the resolved resume step with `resumed = true`.
- If app creation retries with an alternative App ID, details completes only
  after the successful result and reports the final created `app_id`.

## Testing

Add focused unit coverage for the typed event builder and transition behavior.
Mock `pushEvent` and verify:

- the initial real step emits one viewed event after loading;
- each successful transition emits completed for the old step followed by viewed
  for the new step;
- validation and API failures never emit completed;
- duplicate clicks do not duplicate completed events;
- back navigation emits a new viewed event and resets duration measurement;
- resumed flows report the resolved step with `resumed = true` and do not report
  the temporary default step;
- the final created App ID is used after a conflict retry;
- analytics properties contain no app name, store URL, email, or other free text;
- every event carries the same expected `onboarding_version` constant;
- the existing `onboarding_intent_selected` event remains unchanged.

Run frontend lint, the focused unit tests, TypeScript type checking, and the
registration Playwright flow when its environment is available.

## Scope

This plan changes only frontend onboarding analytics and the transition code
needed to guarantee correct event timing. It does not change onboarding copy,
layout, store import behavior, database schema, backend APIs, or existing
PostHog reports.
