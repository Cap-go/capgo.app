# Onboarding v4 App-Step Funnel Design

## Goal

Expand the admin dashboard's Frontend onboarding funnel (v4) so it shows the
actual app-creation journey rather than collapsing all app details into one
stage.

The v4 funnel stages are:

1. Intent
2. App name
3. App ID
4. App icon
5. Organization details
6. Setup reached

This change is limited to onboarding v4. The v1-v3 funnels, daily conversion
charts, welcome-outcome chart, and journey graph keep their current behavior.

## Event Model

Use `onboarding_step_viewed` events from `console.capgo.app`, restricted to
`flow = pre_org` and `onboarding_version = 4`, as the source of stage reach.
The backend query records the earliest timestamp for the `app_name`, `app_id`,
and `app_icon` step values in addition to the existing intent, organization,
and setup timestamps.

Step-view events are the source of truth because fields such as the app icon
can be skipped. Inferring reach from field-entry or completion events would
undercount users who legitimately advanced without providing an optional
value.

## Funnel Semantics

The funnel is monotonic. An attempt that reaches a later stage also counts as
having reached every earlier stage, even when an intermediate view event is
missing. This protects the chart from telemetry loss and matches the existing
funnel behavior.

Each stage reports:

- absolute attempt or user count, depending on the existing de-duplication
  switch;
- conversion from the previous stage; and
- conversion from Intent.

The existing v4 de-duplication option continues to select one best attempt per
user. The best attempt is the one that reached the furthest of the six v4
stages; existing tie-break rules remain unchanged.

## Backend Changes

- Add `app_name_ms`, `app_id_ms`, and `app_icon_ms` to the analytics query and
  attempt model.
- Keep the legacy four-stage funnel builder for onboarding v1-v3.
- Add a v4-specific six-stage funnel builder and use it for v4 funnel output,
  v4 period summaries, and v4 best-attempt ranking.
- Preserve the current `details_ms` field for legacy funnels and daily
  conversion metrics.

## Frontend Changes

- Extend the admin analytics types and color mapping with `app_name`, `app_id`,
  and `app_icon`.
- Render the six backend-provided stages in the existing v4 funnel chart.
- Change only the v4 summary grid so six stage cards remain readable across
  desktop widths.
- Use the requested labels exactly: Intent, App name, App ID, App icon,
  Organization details, and Setup reached.

## Verification

Unit tests must cover:

- extraction of the three new step timestamps from the PostHog query result;
- monotonic six-stage counts and conversion values;
- v4 best-attempt de-duplication based on the furthest expanded stage;
- unchanged four-stage output for v1-v3; and
- frontend type/color/summary handling for all six v4 stages.

Run repository lint, backend and frontend typechecks, the unit suite, and a
production frontend build before opening the pull request.
