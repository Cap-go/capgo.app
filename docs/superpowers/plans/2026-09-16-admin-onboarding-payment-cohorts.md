# Admin Onboarding Payment Cohorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved rolling four-month self-serve first-payment conversion report to the read-only admin onboarding dashboard and deliver a non-draft, verified PR.

**Architecture:** A pure aggregation model consumes cohort-scoped database rows and bounded, pre-aggregated PostHog invoice results. A separate category on the existing guarded admin statistics endpoint supplies an independently loaded Vue table. There are no migrations, billing mutations, or new privileges.

**Tech Stack:** Vue 3, TypeScript, Pinia, vue-i18n, PostgreSQL/pg, Hono, PostHog HogQL, Vitest, Playwright.

## Task 1: Backend report

**Files:**
- Create `supabase/functions/_backend/utils/onboarding_payment_cohorts_model.ts`: types, UTC period computation, exclusion precedence, ownership/payment deduplication and mature-window aggregation.
- Create `supabase/functions/_backend/utils/onboarding_payment_cohorts_data.ts`: parameterized, cohort-scoped primary database reads with explicit pool cleanup.
- Create `supabase/functions/_backend/utils/onboarding_payment_cohorts.ts`: bounded invoice queries, source validation, optional freshness and confirmed-credit timestamp fallback.
- Modify `supabase/functions/_backend/private/admin_stats.ts`: import, category enum, guarded dispatch.
- Create `tests/onboarding-payment-cohorts.unit.test.ts` and `tests/onboarding-payment-cohorts-data.unit.test.ts`: model, source adapter and query/lifecycle coverage.

- [ ] Write failing behavioral tests, including full-window eligibility:

```ts
const cutoff = new Date('2026-09-16T00:00:00Z')
const signup = new Date('2026-09-12T00:00:00Z')
expect(signup.getTime() + 14 * 86_400_000 <= cutoff.getTime()).toBe(false)
expect(signup.getTime() + 3 * 86_400_000 <= cutoff.getTime()).toBe(true)
```

The real model assertions must show the immature payer absent from both 14-day counts, present in ever, and eligible in 3-day. Also cover exact endpoint exclusion, year/leap rollover, empty months, missing-profile-before-invite precedence, auth/profile clock differences, multiple owned orgs, both payment types, pre-signup payments, malformed timestamps and no member-only attribution.

- [ ] Run `bun lint:backend` before validation; run `bunx vitest run tests/onboarding-payment-cohorts.unit.test.ts tests/onboarding-payment-cohorts-data.unit.test.ts`. Record the initial assertion failures before implementing the corresponding behavior.
- [ ] Implement the model's period and window rules:

```ts
const day = 86_400_000
const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
const start = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - 3, 1))
const eligible = signupAt + days * day <= cutoff.getTime()
const paid = eligible && firstPaidAt !== null && firstPaidAt < signupAt + days * day
const conversionPercent = eligibleCount === 0 ? null : paidCount / eligibleCount * 100
```

Return exactly four newest-first month rows with `month`, `signups`, `excluded_no_public_row`, `excluded_invite`, `days_3`, `days_7`, `days_14`, `ever`. Each cell has `paid`, `eligible`, `conversion_percent`. Metadata includes `cutoff`, `start`, `credit_timestamp_fallbacks`, `invoice_last_synced_at` and `invoice_sync_type` (both nullable). Return aggregates only.

- [ ] Implement parameterized reads starting with `auth.users.created_at >= $1 AND created_at < $2`, left joining `public.users` by primary key. Select owned orgs via `orgs.created_by = ANY($1::uuid[])`; select positive `stripe_top_up` grants via cohort-owned `org_id` values. Use `getPgClient(c, false)` because auth is not on the public replica. Reject over-limit or malformed source rows, and release/close the pool in `finally`.
- [ ] Implement actual paid-invoice timestamps, never `stripe_info.paid_at`:

```sql
SELECT customer_id, JSONExtractInt(status_transitions, 'paid_at') AS paid_at_seconds,
       count() OVER () AS total_rows
FROM stripe_2stripe_invoice
WHERE livemode AND paid AND amount_paid > 0
  AND subscription_id IS NOT NULL AND subscription_id != ''
  AND JSONExtractInt(status_transitions, 'paid_at') > 0
GROUP BY customer_id, paid_at_seconds
```

Add generated start/cutoff and escaped cohort customer scopes. Credit lookup groups by `payment_intent`, uses the same paid/positive/live conditions, scopes to confirmed-grant intents, and prefers that paid timestamp over the grant timestamp. Enforce explicit aggregate limits and total-row completeness; global invoice lookup failures throw. Query optional freshness with `system.source_schemas.table_id IN (SELECT id FROM system.data_warehouse_tables WHERE name = 'stripe_2stripe_invoice' AND NOT deleted)`; require enabled, nondeleted schema rows. Expose its sync type and timestamp, with an explicit frontend warning that append/incremental sync may miss later invoice updates. Optional metadata failure returns null, not a fabricated timestamp. Require a post-signup first payment; early payments must not conceal later valid ones.

- [ ] Add `onboarding_payment_cohorts` to the existing enum and dispatch, without touching the platform-admin check or honoring chart filters for this report.
- [ ] Re-run focused tests, inspect read-only generated SQL/HogQL against safe connected sources, and run real database-level fixture coverage using isolated fake identities where a local database is available. No production mutations.
- [ ] Complete fresh spec review, then quality review; fix findings and commit only task files using `feat(admin): add rolling payment cohort report`.

## Task 2: Independently loaded dashboard table

**Files:**
- Create `src/services/adminOnboardingPaymentCohorts.ts`: strict aggregate response validation, locale display helpers, independent loading/error state.
- Create `src/components/admin/AdminOnboardingPaymentCohorts.vue`: full-width semantic responsive table card and methodology/freshness/retry states.
- Modify `src/pages/admin/dashboard/frontend-onboarding.vue`: mount the independently loaded component outside the existing analytics failure branch.
- Modify `src/stores/adminDashboard.ts`: add the category and a UTC-day, filter-independent cache/request identity for this report.
- Modify `messages/en.json`: translation keys for every new label and methodology explanation.
- Create `tests/admin-onboarding-payment-cohorts.unit.test.ts`: response/display/loading and mounted rendering coverage with synthetic report data.

- [ ] Write and run failing tests for response rejection, zero-eligible unavailable display, localized months/numbers, successful render, delayed load, source error/retry, stale-response handling and chart-filter independence. Use real component rendering with mocked network/store boundary rather than only static source checks.
- [ ] Define the frontend contract to match Task 1, validating four unique consecutive UTC months, finite nonnegative counts, paid <= eligible, and null percentages only for zero eligibility. Reject invalid responses as unavailable.
- [ ] Render the table with this semantic shape:

```vue
<section :aria-label="t('onboarding-payment-cohorts-title')">
  <h2>{{ t('onboarding-payment-cohorts-title') }}</h2>
  <div class="overflow-x-auto">
    <table class="table w-full">
      <thead><tr><th scope="col">{{ t('onboarding-payment-cohorts-month') }}</th></tr></thead>
      <tbody><tr v-for="row in report.rows" :key="row.month"><th scope="row">{{ formatMonth(row.month) }}</th></tr></tbody>
    </table>
  </div>
</section>
```

Complete all eight approved columns; cells show paid / eligible and percentage, or explicit unavailable when eligibility is zero. Format dates with UTC and the active locale. Show cutoff, last-four-month independence, complete-day eligibility, owned-org attribution, observed-to-cutoff ever caveat, invoice freshness/unavailable and credit fallback count. Use translation keys only and existing admin styling.
- [ ] Keep component loading/error/retry separate from existing analytics. Gate requests to an authenticated platform-admin page, hide stale report while reloading, prevent late unmounted responses, and offer retry/refresh without changing other charts.
- [ ] Add the category to Pinia. For this category use a canonical current UTC-day cache key and rolling period request dates, omit selected app/org filters; keep every other category unchanged.
- [ ] Run `bun lint`, then focused Vitest tests. Inspect a local browser render using synthetic data and verify horizontal scrolling at a narrow viewport.
- [ ] Complete fresh spec review, then quality review; fix findings and commit only task files using `feat(admin): show self-serve payment conversion cohorts`.

## Task 3: Verification and public PR

- [ ] Run `bun lint`, `bun lint:backend`, `bun lint:deadcode`, `bun typecheck`, `bun build`, and `bun test:unit` on the final intended tree; run proportionate integration/UI coverage.
- [ ] Request a fresh whole-feature review and address critical/important findings.
- [ ] Verify `git diff --name-only origin/main...HEAD` excludes `graphify-out/`, `codedb.snapshot`, release files and unrelated paths. All test identities must be synthetic; no private analysis counts in public files.
- [ ] Push `wolny/admin-onboarding-payment-cohorts`, create an open non-draft PR against `Cap-go/capgo.app` main, with generic methodology and honest verification evidence. Do not merge/deploy.
- [ ] Invoke `pr-ready`: inspect fresh remote checks, effective reviews, unresolved conversations, rules and mergeability; fix in-scope failures.
- [ ] Record two all-green observations with unchanged head/base/reviews/check suite at least 300 seconds apart. Only then hand off stable-green evidence and the PR URL.
