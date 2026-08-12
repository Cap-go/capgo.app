# API key hidden-scope notice

## Problem

The API keys page applies the current organization as a default scope filter.
Users can therefore arrive on the page with API keys omitted from the table,
while the only indication is the active-filter count on the Scope button. That
indicator does not clearly explain that additional API keys exist outside the
current table view.

## Design

Show an inline informational notice inside the API-key table card, immediately
below the table toolbar and above the column headers, only when the active scope
filters exclude API keys that would otherwise appear in the current view.

The notice copy is:

> 3 API keys are hidden by the current scope filter. Remove the filter

Use the correct singular form when exactly one key is hidden. Render “Remove
the filter” as a text-style button rather than navigation. Activating it clears
every organization and app scope selection, resets pagination to page 1, and
leaves the search query unchanged. With no scope selected, the table is in its
existing unfiltered, all-scopes state. The notice disappears immediately after
the scope filters are cleared.

Derive the hidden count from the current local API-key dataset in this order:

1. Apply the current search query without applying scope filters.
2. Apply the active organization and app scope filters to that searchable set.
3. Subtract the scoped result count from the searchable result count.

This makes the message exact: removing the scope filter adds the stated number
of rows to the current searched view. Do not show the notice when no scope is
active, when the hidden count is zero, while the API-key data is loading, or
when the user cannot access any additional matching keys.

Add an optional notice slot to the shared `DataTable` component at the boundary
between its toolbar and table. The API keys page owns the notice content and
visibility logic; other tables remain unchanged when the slot is unused.

## Accessibility and responsive behavior

Use a calm informational treatment that works in light and dark themes; this is
visibility guidance, not an error or destructive warning. Keep the message and
action readable on narrow screens by allowing them to wrap. The action must be
a semantic button with visible keyboard focus. Announce the notice as status
information without forcing an interruptive alert.

The visual treatment uses a neutral slate background, border, and body text so
the notice sits naturally inside the table card. A proper circled-information
icon identifies it as informational. Reserve blue for that icon, the text-style
action, and keyboard focus; do not use a cyan or turquoise banner background.
The icon is decorative because the message already conveys the notice meaning,
so hide it from assistive technology.

## Verification

Add focused coverage for these cases:

- An active scope hides matching API keys: show the exact pluralized count.
- An active scope hides one matching API key: show singular copy.
- An active scope hides no matching API keys: do not show the notice.
- A search query excludes keys independently of scope: do not count those keys
  as hidden by scope.
- “Remove the filter” clears all organization and app scopes, returns to page 1,
  preserves the search query, and removes the notice.
- The shared table renders unchanged when the optional notice slot is absent.

Run the focused frontend tests, frontend lint, typecheck, and production build.
