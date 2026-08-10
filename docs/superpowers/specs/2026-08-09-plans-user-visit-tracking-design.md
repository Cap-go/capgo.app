# Plans User Visit Tracking Fix

## Goal

Make the existing `User visit` event a dependable signal that an authenticated organization member opened the organization Plans page.

## Current problem

The Plans page sends `User visit` from a reactive `watchEffect`, so unrelated reactive changes can emit the event repeatedly during one route visit. The Usage page contains a second emitter that also watches for the Plans route. Production PostHog data consequently contains same-organization bursts of duplicate events.

The event also has no event-level page identifier. Historical queries have relied on PostHog person properties such as `$pathname`, which are indirect and do not reliably identify the route that produced a server-side event.

## Design

Keep the existing event name so historical and future measurements remain one series.

The Plans page will emit `User visit` once for each activation of `/settings/organization/plans`, after the authenticated user and selected organization are available and billing permissions have been accepted. The event will retain tracking contract version 2 and its verified `org_id` organization grouping.

Add the event property `page: 'plans'`. New analytics queries will identify future Plans visits with this explicit property. Historical queries may use the existing event name because the repository's emitters are Plans-specific, while applying documented deduplication for the old reactive duplicates.

Remove the redundant Plans-route `User visit` emitter from the Usage page.

The implementation must prevent duplicate events when reactive organization or page data changes without a new Plans route activation. Navigating away and later returning to Plans should emit a new event.

## Testing

Add focused frontend unit coverage proving:

- A Plans route activation emits one `User visit` event with `page: 'plans'`, `org_id`, and tracking version 2.
- Reactive changes during the same activation do not emit another visit.
- Leaving and returning to Plans permits another visit.
- The Usage page no longer emits a Plans visit event.

Run the focused unit tests, frontend typecheck, and lint before handing off the pull request.

## Out of scope

- Historical PostHog deduplication queries.
- Billing-state properties or billing-state classification.
- The Plans analytics admin page.
- Checkout completion tracking.
- Renaming `User visit` or rewriting historical PostHog events.
