# Plans Checkout Completion Analytics

The Plans analytics page counts checkout completion from server-side billing evidence already used for historical billing classification.

## Attribution

Completion uses the same checkout cohort as **Checkout intent**:

- A Plans opening is a `User visit` with `page = plans`.
- A checkout start is attributed to the latest preceding same-org opening within 24 hours (`CHECKOUT_ATTRIBUTION_MS`).
- Each organization is bucketed on the **attributed Plans-opening UTC day**, not the checkout or completion day.
- Same-day duplicate checkout starts dedupe to the earliest attributed checkout for that org/day.

## Completion signal

An attributed checkout is **completed** when the organization's billing timeline shows a `paid` transition strictly after the checkout timestamp and on or before the observation deadline.

That timeline merges:

- PostHog billing transitions (`User subscribe`, trusted `User update subscribe`, and related group updates) emitted from Stripe webhooks
- Postgres billing facts already loaded for Plans analytics (`stripe_info.paid_at`, revenue movements, and related history)

This captures new subscriptions and plan upgrades without requiring a dedicated `Checkout Completed` PostHog event or Stripe `checkout_attempt_id` metadata.

## Observation window

The observation window is 24 hours after checkout start (`CHECKOUT_COMPLETION_OBSERVATION_MS`, currently equal to the checkout attribution window).

Until that deadline passes, an unattributed paid transition remains **pending** instead of **not completed**.

## Limits

- Completion is inferred from org-level billing transitions, not per Stripe checkout session.
- Multiple checkout attempts in one attributed day collapse to the earliest start; a later successful payment still counts if it falls inside the observation window for that earliest start.
- Credit-only top-ups and non-subscription Stripe checkout sessions are out of scope for this chart.

A future `checkout_attempt_id` bridge in Stripe metadata would allow attempt-level joins but is not required for the current admin chart.
