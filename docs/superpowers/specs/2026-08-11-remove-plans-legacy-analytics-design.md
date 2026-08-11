# Remove Plans Legacy Analytics Design

## Goal

Make exact `User visit` events tagged with `page = 'plans'` the only source of Plans-page openings. Remove the unused legacy pathname reconstruction algorithm and the dashboard warning that says legacy history is unavailable.

## Decision

Three approaches were considered:

1. Remove the legacy algorithm and its public contract. This is the selected approach because the algorithm is disabled, contributes no production data, and adds backend, frontend, test, documentation, and translation complexity.
2. Keep the algorithm but hide the warning. This would simplify the UI while retaining unreachable code and misleading response metadata.
3. Enable pathname reconstruction. Historical PostHog evidence could support it, but this adds inferred data that is no longer required because exact tracking will naturally populate the selected ranges over time.

## Backend Design

The Plans analytics behavior query will use the requested range start directly for `User visit` events. It will continue to select only visits whose event property is `page = 'plans'`. Checkout events retain their existing attribution window through 24 hours after the range end.

The behavior model will accept exact Plans openings only. Remove legacy path normalization, session-burst grouping, the 30-second threshold, and the `exact | legacy` source distinction. Opening deduplication, checkout attribution, billing-state classification, and chart construction otherwise remain unchanged.

Remove all legacy-only fields from the backend response's `dataQuality` object. Keep exact tracking metadata and the existing PostHog, billing, exclusion, and unmatched-checkout fields.

## Frontend Design

Update the shared frontend response type and runtime parser to match the smaller backend response. Remove the derived `showLegacyUnavailableWarning` presentation state and its warning block from the Plans analytics page.

Remove the unused English translation and translation context for the warning. Valid zero-valued historical days remain normal chart data and do not display a warning.

## Documentation

Update the existing Plans analytics design and implementation documents so they describe exact tracking as the sole source of Plans openings. Remove instructions, examples, response fields, and verification gates that refer to legacy reconstruction or its 30-second threshold.

## Compatibility and Data Behavior

This intentionally changes the internal admin-stats response contract for `plans_analytics`; the only known consumer is updated in the same change. It does not affect the customer-facing Plans page, checkout tracking, billing categories, or chart definitions.

Dates before exact tracking began remain zero. As time passes, standard date ranges such as 30 days will naturally contain more exact data.

## Testing

Tests will prove that:

- only exact `page = 'plans'` visits become openings;
- the behavior query no longer fetches a 30-second pre-range window;
- response parsing rejects removed legacy fields only by ignoring additional wire fields, while requiring the retained contract;
- presentation state contains no legacy-warning flag;
- the Plans page contains no legacy warning;
- checkout attribution and graph invariants remain unchanged;
- translations and documentation contain no Plans-analytics legacy references.

Run the focused model, orchestration, dashboard, translation, lint, typecheck, and production-build checks before opening the pull request.
