# Optional billing in onboarding progress

`POST /private/onboarding_progress` accepts `includeBilling: true` alongside
`appId`, `N`, and optional `initial`. Omitting it or sending `false` preserves
the existing response and performs no billing checks.

An authorized response adds:

```json
{
  "billing": {
    "status": "available",
    "orgId": "11111111-1111-4111-8111-111111111112",
    "orgCreatedAt": "2030-01-01T03:04:05.123+00:00",
    "trialEndsAt": "2030-01-02T03:04:05.123+00:00",
    "hasPaid": false,
    "isPaying": false,
    "hasCredits": false
  }
}
```

`orgId` is the requested app's owning organization, suitable for the CLI's
organization plans link. `trialEndsAt` is the stored trial expiry timestamp
(nullable); the CLI calculates remaining time. `orgCreatedAt` is the
organization's creation time (nullable). A `trialEndsAt` within a day of
`orgCreatedAt` means the organization was created without a free trial (direct
offer from paid ads); the CLI then shows "choose a plan to start" copy instead
of trial copy. `hasPaid` is true once the organization has ever paid
(`stripe_info.paid_at` is set), so a churned organization is not treated as a
never-paid direct-offer one. Older servers omit `orgCreatedAt` and `hasPaid`;
clients must then keep the trial copy. `isPaying` matches
`is_paying_org` (`stripe_info.status = 'succeeded'`). `hasCredits` matches
`has_usage_credits_org` (the materialized `orgs.has_usage_credits` flag).
These fields describe stored billing state, not a fresh Stripe synchronization
or a calculated credit balance.

The backend reuses `owner_org` from its existing exact-app read, checks
`org.read_billing`, and makes one caller-authenticated, RLS-protected query of
that organization joined to `stripe_info` through its existing customer foreign
key. Billing starts alongside onboarding checks and remains outside the write
transaction. Both tasks must finish before the combined response is returned.

Denied billing access, missing organization/customer data, and billing errors
produce `"billing": { "status": "unavailable" }`; onboarding still succeeds.
Clients must treat this as unknown billing state and suppress billing-specific
notices. It does not mean the organization is unpaid or has no credits.

Unchanged observations now skip the onboarding write transaction entirely.
The preflight uses the same patch calculation as the writer, including source
promotion and channel deletion. Potential changes still acquire the existing
locks, recheck write permissions, and merge against the latest row. A concurrent
local scanner's updates are preserved. A no-op response is a read snapshot;
another request may update the checklist immediately afterward.

This is backend support only. A CLI follow-up must explicitly opt in to billing
and schedule its request alongside local scanning.
