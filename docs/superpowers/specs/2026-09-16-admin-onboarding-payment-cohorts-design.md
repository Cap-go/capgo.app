# Admin Onboarding: Rolling First-Payment Cohorts

## Goal

Add a read-only “Self-Serve Signup → First Payment Conversion” table to the existing admin onboarding dashboard. It reports the current UTC calendar month and the previous three calendar months, newest first, without hard-coded month labels or customer-specific fixtures.

The design was approved in conversation. This document records its metric definitions, data sources, implementation boundaries, and verification requirements.

## Cohort and cutoff

- Use the beginning of the current UTC day as the exclusive analysis cutoff. Include completed-day signup and payment data only.
- Compute the reporting start as the first day of the cutoff's calendar month minus three months. Return exactly four month rows, including empty months.
- Month selection is independent of the existing onboarding chart date filters.
- Assign each account to its auth.users.created_at signup month.
- Require a matching public.users row at analysis time.
- Apply the missing-public-row exclusion first, then exclude public.users.created_via_invite = true accounts.
- Document missing-public-row and org-invite exclusion counts separately for every month.
- Count unique user IDs, not organizations, PostHog signup events, invoices, or checkout sessions.

## Payment sources and attribution

Supabase is authoritative for signup timestamps, account exclusions, created organizations, and payment-confirmed credit grants. PostHog's synced Stripe invoices are authoritative for subscription payment timestamps.

A subscription payment qualifies only when the live Stripe invoice is paid, amount_paid is positive, its subscription reference is nonempty, and status_transitions.paid_at is a valid positive timestamp before the cutoff. Free or zero-dollar invoices, failed charges, trial events, and checkout starts do not qualify. Do not use public.stripe_info.paid_at alone: that field can be populated before the first charge.

A credits payment requires a positive public.usage_credit_grants grant with source = 'stripe_top_up'. The backend creates that grant after confirming a paid checkout; manual or complimentary grants do not qualify. Prefer the corresponding positive paid Stripe invoice's actual paid timestamp. If the invoice is unavailable for an individual asynchronous checkout but the payment-confirmed Supabase grant exists, use the grant timestamp and disclose that fallback in report metadata.

Link subscription payments through public.orgs.customer_id. Attribute both subscription and credits payments through public.orgs.created_by. This measures a signup user's own created organization becoming paying; it does not establish personal ownership of the payment card. Merely joining a paid organization is not conversion.

Take the earliest qualifying payment at or after signup across all created organizations and both payment types. Count a person who buys both once. Later cancellation or refund does not erase a historical gross first-payment conversion; this is not net revenue or current-paying-user reporting.

## Window semantics

Return cumulative first-payment conversion for 3, 7, and 14 elapsed 24-hour days, plus observed-to-cutoff “ever” conversion.

For each fixed window:

- Eligible denominator: signup + the full window is at or before the cutoff.
- Paid numerator: eligible people whose first qualifying payment is at or after signup and strictly before signup + the window.
- Percentage: paid / eligible × 100; return null when eligible is zero.

Exclude immature users from both numerator and denominator even if they have already paid. The same eligibility rule applies to all four months. Recent-month columns can have different eligible populations, so their absolute payer counts need not be monotonic.

“Ever” uses all included signups and qualifying payments strictly before the cutoff. Its follow-up duration varies by month and must be labeled accordingly.

## Backend architecture

Add a separate metric category to the existing authenticated, platform-admin-guarded admin_stats route. Keep this operation strictly read-only and return aggregate month rows and methodology/freshness metadata only.

Use a focused cohort loader for Supabase data, a bounded PostHog invoice query adapter, and a pure aggregation model. Reuse the existing PostHog read configuration and bounded response handling. Do not introduce an API key, customer identity, or financial event mutation path.

Start database work from the four-month auth signup range. Batch organization and credit-grant lookups using cohort-scoped identity keys and existing indexed ownership paths. Keep queries parameterized and handle database pool lifecycle explicitly. Verify auth schema access uses the appropriate primary/internal read connection, not a public-only replica.

Pre-aggregate and time-bound PostHog invoice queries. Scope results to cohort customer/payment-intent identifiers when practical, enforce explicit result/response limits, and detect truncation or incomplete metadata instead of displaying a partial count as complete. Avoid a per-user Stripe API fan-out.

Do not add a cron, schema table, new PostgreSQL extension, grant change, or published-CLI behavior change. The report operates on existing data.

## Frontend architecture

Render a full-width table card on src/pages/admin/dashboard/frontend-onboarding.vue, following the existing admin card and table styling. Columns are signup month, included self-serve signups, missing-public-row exclusions, org-invite exclusions, 3-day conversion, 7-day conversion, 14-day conversion, and ever conversion.

Conversion cells show paid / eligible and percentage. Zero-eligible windows display an explicit unavailable value, not 0%. Show the UTC cutoff, rolling-month scope, mature-cohort rule, payment attribution, and any credit timestamp fallback.

Use translation keys in messages/en.json, the existing locale number/date formatting, semantic table headings, and horizontal overflow support for smaller screens.

Load this report independently from the existing onboarding analytics response. A payment-source or database failure must show a table-specific unavailable/retry state without blanking other charts or replacing unavailable data with zero conversions. Keep the existing chart filters and loaders unchanged.

Expose invoice-source freshness when available. Do not claim up-to-the-second payments: report the completed-day cutoff, source sync coverage, or an explicit freshness-unavailable status. A failed global subscription lookup makes the report unavailable; an individual confirmed-credit grant fallback is distinct from that failure.

## Verification and PR workflow

Use test-first implementation. Cover UTC month/year rollover, leap dates, empty months, exact 3/7/14-day boundaries, immature payers, exclusion precedence, auth/profile timestamp differences, organization ownership attribution, multi-organization/payment deduplication, subscriptions versus credits, complimentary credits, malformed timestamps, and source failure/truncation handling.

Add database-level coverage for the cohort loader with isolated fake identities and frontend report/loading coverage. Run focused tests and the full relevant unit suite. Run repository frontend/backend lint before validation, dead-code checks, typecheck, and production build. Exercise relevant integration/UI coverage proportionately and validate source-generated read-only queries when a safe connected source is available.

Create a non-draft PR against main in Cap-go/capgo.app (the canonical repository behind this workspace's origin alias). Keep private customer context, analysis cohort counts, generated Graphify output, codedb.snapshot changes, release version/changelog edits, and unrelated worktree changes out of the PR.

Run pr-ready against the final pushed head. Require all applicable local/remote checks, reviews, mergeability, and repository requirements to pass in two unchanged-state observations at least five minutes apart. Do not merge or deploy without a separate request.

## Non-goals

No billing mutation, tracking-event change, platform-admin privilege expansion, replacement of existing onboarding charts, configurable historical month selector, new payment ingestion pipeline, or exact reconstruction of accounts deleted from both database user tables.
