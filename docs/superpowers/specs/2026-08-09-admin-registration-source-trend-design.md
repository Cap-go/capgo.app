# Admin Registration Source Trend

## Problem

The admin users dashboard currently spreads registration and invitation activity
across the Onboarding Trend and Invite Join Trend line charts. Those charts mix
different events and cohorts, so they do not answer the simpler question: how
many authentication accounts were created each day, and what profile state did
each new account reach?

Using only `public.users` would omit authentication accounts that never created a
profile. Treating every missing profile as a normal registration would also
claim more certainty than the data provides. The chart therefore needs an
`auth.users`-based population and three explicit, mutually exclusive profile
states.

## Design

Add a new **Registrations by source** chart to the admin users dashboard. It is a
vertical stacked-column chart with one column per day in the active admin date
range. Each column contains three datasets:

1. **Normal registration** — the authentication user has a matching
   `public.users` row with `created_via_invite = false`.
2. **Organization invite** — the authentication user has a matching
   `public.users` row with `created_via_invite = true`.
3. **Without profile** — the authentication user has no matching
   `public.users` row.

Use blue for normal registrations, orange for organization invites, and neutral
gray for accounts without a profile. Tooltips show the selected segment's count
and percentage of that day's total. The legend keeps all three datasets visible
and uses the same order and colors throughout the date range.

The three datasets are exhaustive and do not overlap. Their sum for a day must
equal the number of `auth.users` rows created on that day.

## Data Contract

Extend the existing admin onboarding-funnel response with a
`registration_source_trend` array. Each item has this shape:

```ts
{
  date: string
  normal_registrations: number
  invite_registrations: number
  without_profile: number
}
```

Produce the array in `getAdminOnboardingFunnel` so the chart follows the existing
admin date filter and loading lifecycle. The query starts from `auth.users`,
left-joins `public.users` on the user ID, and groups by the authentication
account's `created_at::date`. It classifies each row using filtered counts:

- matching profile with `created_via_invite = false`;
- matching profile with `created_via_invite = true`;
- no matching profile.

Use the same inclusive start and exclusive end bounds as the existing admin
queries. Join the aggregated result to a generated date series so days with no
registrations are returned with zero values. No schema migration or new stored
function is required.

## Frontend

Add a focused reusable admin stacked-bar component rather than expanding
`AdminBarChart`, which is a horizontal single-dataset categorical chart. The new
component accepts daily labels and multiple named datasets, renders vertical
stacked bars, formats counts using the existing locale helpers, and supports the
dashboard's light and dark themes.

Place the chart in the onboarding analytics section near the existing
Onboarding Trend and Invite Join Trend charts. This is an additional diagnostic
view; it does not change or remove those charts or redefine their metrics.

Add translation keys to `messages/en.json` for the chart title, description,
and three dataset labels. Do not use inline translation fallbacks.

## Testing

Extend the admin statistics integration coverage with authentication users that
represent all three states on the same day:

- an auth user with a normal profile;
- an auth user with an invite-created profile;
- an auth user without a profile.

Assert that each user appears in exactly one dataset, that the daily sum equals
the number of new authentication users, that zero-count dates are retained, and
that start/end boundaries remain start-inclusive and end-exclusive. Update the
frontend types and add focused component coverage for dataset ordering, stacked
axes, colors, and tooltip percentage calculation.

Before handoff, run the focused backend and frontend tests, frontend lint, and
TypeScript checking.

## Scope

This change is read-only and limited to admin analytics. It does not alter the
registration flow, invitation flow, profile creation, existing onboarding
metrics, or organization membership behavior. The chart describes recorded
profile state; it does not infer that an auth-only account necessarily came from
normal registration.
