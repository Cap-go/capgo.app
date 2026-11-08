# Untangle phase 1 decision log

Cap-go/capgo.app monorepo. This commit changes no product code. It records where coupling hides, what should move together, and a small PR sequence for later phases.

## Additions chosen

- Comments: yes on later passes. Remove comments that only restate the next line. Keep comments that document off-code contracts (Cloudflare snippet, Hyperdrive, RLS, product security triage). Drop workaround comments only when the redesign removes the workaround.
- Tests: no changes on this pass. Tests stay the safety net.

## Evidence (scripts)

Run from repo root with Node or Bun:

| Script | Output |
| --- | --- |
| `node scripts/untangle/import-graph.mjs` | `scripts/untangle/import-graph-summary.json` |
| `node scripts/untangle/cochange.mjs` | `scripts/untangle/cochange-summary.json` |
| `node scripts/untangle/skeleton.mjs` | `.context/untangle/skeleton/` (gitignored) |
| `node scripts/untangle/comment-estimate.mjs` | stdout JSON |
| `node scripts/untangle/find-candidates.mjs` | heuristic special-case scan |
| `node scripts/untangle/compare-mirrors.mjs origin/main` | stdout or `scripts/untangle/mirror-verification-main.json` |

### Import graph summary

- Scanned 1342 TypeScript/Vue files under `src/`, `cli/src`, `supabase/functions/_backend`, `cloudflare_workers/`. 5913 import edges.
- Console must not import Supabase directly. Eight `src/` files still reach into `supabase/functions/` (contracts and shared math). CLI has zero backend imports in the graph; two test modules import `cliMinVersion` and `appOnboarding` from backend utils.
- `plugin_runtime/utils/` mirrors 41 basenames under `_backend/utils/`. Twelve files are byte-identical today; 29 have diverged (largest: `supabase.types.ts`, `cloudflare.ts`, `pg.ts`).

### Co-change frequency (last 500 commits, focused prefixes)

Top pairs (should these change together?):

1. `plugin_runtime/utils/supabase.types.ts` + `utils/supabase.types.ts` (12 commits)
2. `plugin_runtime/utils/pg.ts` + `utils/pg.ts` (6)
3. `plugin_runtime/utils/cloudflare.ts` + `utils/cloudflare.ts` (5)
4. `src/services/stripe.ts` + `private/stripe_billing.ts` + `utils/stripe.ts` + `utils/stripe_trial_plan.ts` (5 to 7 each)
5. `cli/src/index.ts` + `cli/src/mcp/server.ts` + `cli/src/mcp/tool-schemas.ts` + `cli/src/sdk.ts` (4 to 9)

### Skeleton pass

713 skeleton files under `.context/untangle/skeleton/` for `plugin_runtime`, `_backend/utils`, `src/services`, `src/stores`, `cli/src`.

## Problem inventory

Each line asks: should these pieces change together?

### Hidden links

Copied logic or values; cross-folder features; call order; undeclared conventions.

| ID | Location | Should these change together? |
| --- | --- | --- |
| H-01 | `supabase/functions/_backend/plugin_runtime/utils/api_version.ts:1` and `supabase/functions/_backend/utils/api_version.ts:1` | Mirror pair (DIFF). |
| H-02 | `supabase/functions/_backend/plugin_runtime/utils/appStatus.ts:1` and `utils/appStatus.ts:1` | Mirror pair (DIFF). Plugin copy drops `helper.available` guard at `buildAppStatusRequest`. |
| H-03 | `plugin_runtime/utils/bento.ts:1` and `utils/bento.ts:1` | Mirror pair (DIFF). |
| H-04 | `plugin_runtime/utils/cache.ts:1` and `utils/cache.ts:1` | Mirror pair (DIFF). |
| H-05 | `plugin_runtime/utils/channelSelfStore.ts:1` and `utils/channelSelfStore.ts:1` | Mirror pair (DIFF). |
| H-06 | `plugin_runtime/utils/cloudflare.ts:1` and `utils/cloudflare.ts:1` | Mirror pair (DIFF, ~700 line drift). |
| H-07 | `plugin_runtime/utils/deviceDataCollection.ts:1` and `utils/deviceDataCollection.ts:1` and `src/services/deviceDataCollection.ts:5` | Same concept in three trees. |
| H-08 | `plugin_runtime/utils/discord.ts:1` and `utils/discord.ts:1` | Mirror pair (DIFF). |
| H-09 | `plugin_runtime/utils/hono.ts:1` and `utils/hono.ts:1` | Mirror pair (DIFF). |
| H-10 | `plugin_runtime/utils/invalids_ip.ts:1` and `utils/invalids_ip.ts:1` | Mirror pair (DIFF). |
| H-11 | `plugin_runtime/utils/legacyDownloadFail.ts:1` and `utils/legacyDownloadFail.ts:1` | Mirror pair (DIFF). |
| H-12 | `plugin_runtime/utils/logging.ts:1` and `utils/logging.ts:1` | Mirror pair (DIFF). |
| H-13 | `plugin_runtime/utils/manifest_size.ts:1` and `utils/manifest_size.ts:1` | Mirror pair (DIFF). |
| H-14 | `plugin_runtime/utils/notifications.ts:1` and `utils/notifications.ts:1` | Mirror pair (DIFF). |
| H-15 | `plugin_runtime/utils/on_error.ts:1` and `utils/on_error.ts:1` | Mirror pair (DIFF). |
| H-16 | `plugin_runtime/utils/org_email_notifications.ts:1` and `utils/org_email_notifications.ts:1` | Mirror pair (DIFF). |
| H-17 | `plugin_runtime/utils/pg.ts:1` and `utils/pg.ts:10` | Mirror pair (DIFF). Main `pg.ts` imports `pg_transaction_mode` from plugin tree while duplicating the rest. |
| H-18 | `plugin_runtime/utils/pg_errors.ts:1` and `utils/pg_errors.ts:1` | Mirror pair (DIFF). |
| H-19 | `plugin_runtime/utils/plugin_compatibility.ts:1` and `utils/plugin_compatibility.ts:1` | Mirror pair (DIFF). |
| H-20 | `plugin_runtime/utils/plugin_stats.ts:1` and `utils/plugin_stats.ts:1` | Mirror pair (DIFF). |
| H-21 | `plugin_runtime/utils/postgres_schema.ts:1` and `utils/postgres_schema.ts:1` | Mirror pair (DIFF). |
| H-22 | `plugin_runtime/utils/posthog.ts:1` and `utils/posthog.ts:1` | Mirror pair (DIFF). |
| H-23 | `plugin_runtime/utils/rate_limit.ts:1` and `utils/rate_limit.ts:1` | Mirror pair (DIFF). |
| H-24 | `plugin_runtime/utils/s3.ts:1` and `utils/s3.ts:1` | Mirror pair (DIFF). |
| H-25 | `plugin_runtime/utils/schema_validation.ts:1` and `utils/schema_validation.ts:1` and `cli/src/schemas/schema_validation.ts:1` | Shared validation shape in three places. |
| H-26 | `plugin_runtime/utils/supabase.types.ts:1` and `utils/supabase.types.ts:1` and `src/types/database.types.ts:1` | Types generated once, copied once, third copy drifts (co-change rank 1). |
| H-27 | `plugin_runtime/utils/types.ts:1` and `utils/types.ts:1` | Mirror pair (DIFF). |
| H-28 | `plugin_runtime/utils/utils.ts:19` and `utils/utils.ts:19` | Identical regex and semver helpers duplicated (SAME today, fork risk). |
| H-29 | `plugin_runtime/utils/version.ts:1` and `utils/version.ts:1` | Mirror pair (DIFF). |
| H-30 | `plugin_runtime/utils/channelSelfRateLimit.ts:1` and `utils/channelSelfRateLimit.ts:1` | Mirror pair (SAME). |
| H-31 | `plugin_runtime/utils/supabase_write_guard.ts:1` and `utils/supabase_write_guard.ts:1` | Mirror pair (SAME). Write-guard flags must match worker middleware. |
| H-32 | `cloudflare_workers/plugin/index.ts:17` | Sets `skipSupabaseStatsFallback`, `requireReadReplica`, and related `c.set` flags before routes. Handlers assume this order. |
| H-33 | `cloudflare_workers/snippet/index.js:50` and `plugin_runtime/utils/providerAsns.ts:8` | Provider ASN set copied literally into snippet JS. |
| H-34 | `cloudflare_workers/snippet/index.js:12` and `plugin_runtime/utils/rateLimitInfo.ts:31` | Snippet timeout and 429 body shape must match worker responses. |
| H-35 | `plugin_runtime/utils/rateLimitInfo.ts:50` and `snippet/index.js` on-prem cache detection | Shared `on_premise_app` / `need_plan_upgrade` contract. |
| H-36 | `plugin_runtime/utils/snippetEdgeAnswer.ts:18` and `plugins/stats.ts:128` | Edge fill metadata and stats handler branches. |
| H-37 | `supabase/functions/updates/index.ts:4` and `cloudflare_workers/plugin/index.ts:5` | Same Hono app wired through Deno entry vs worker router. |
| H-38 | `plugin_runtime/plugins/stats_actions.ts:1` imported from `plugin_validation.ts:4` and `snippetEdgeAnswer.ts:2` | Action allowlist split across plugin handler and edge utils. |
| H-39 | `scripts/getTypes.mjs:75` | Copies types to `utils/supabase.types.ts` only, not `plugin_runtime` copy. |
| H-40 | `src/services/consoleClient.ts:1` and `private/console_data.ts` + `utils/console_contract.ts` | Console transport types live in backend; browser imports them. |
| H-41 | `src/services/appOnboarding.ts:5` and `utils/appOnboarding.ts` | Console onboarding state machine imported from backend file. |
| H-42 | `src/services/bundleCompatibility.ts:6` and `utils/bundle_compatibility.ts` | Same. |
| H-43 | `src/services/stripe.ts:7` and `supabase/functions/shared/stripe-amount.ts` | Stripe amount math shared via relative import into `supabase/functions`. |
| H-44 | `src/services/signupAttribution.ts:1` and `supabase/functions/shared/signup-attribution.ts` | Same pattern. |
| H-45 | `src/services/planPrices.ts:5` | Same `stripe-amount` dependency. |
| H-46 | `utils/console_query_allowlist.ts:5` and every `src/` `from('...')` / `.rpc(` | Allowlist must match console queries by convention; enforced only by unit test. |
| H-47 | `src/services/console.ts:11` | Module singleton `consoleClient` mutated by `useConsole()` init order. |
| H-48 | `plugin_runtime/utils/update.ts:467` and `update_response.ts:55` and `channelSelfStore.ts:102` | `isDeprecatedPluginVersion` thresholds repeated per feature. |
| H-49 | `utils/stripe.ts:1` and `utils/stripe_billing.ts:1` and `private/stripe_billing.ts:10` | Billing split across utils and private route. |
| H-50 | `cli/test/test-min-cli-version.mjs:4` and `utils/cliMinVersion.ts:1` | Published CLI floor defined in backend, tested from CLI package via relative import. |

### Needless links

Callers depend on internals; stable code imports volatile code; shallow modules.

| ID | Location | Note |
| --- | --- | --- |
| N-01 | `supabase/functions/_backend/utils/pg.ts:10` | Primary backend imports `pg_transaction_mode` from plugin_runtime while maintaining a full duplicate `pg.ts`. |
| N-02 | `plugin_runtime/plugins/channel_self.ts:19` | Hot handler imports wide surface from `pg.ts` (20+ symbols) instead of a narrow plugin DB facade. |
| N-03 | `plugin_runtime/plugins/updates.ts` (via `update.ts:26` edges) | Update orchestration imports half of `plugin_runtime/utils/`. |
| N-04 | `utils/stripe.ts:9` | 1600+ line module re-exports and consumes `stripe_billing.ts` internals. |
| N-05 | `src/services/capgoApi.ts:4` | API layer imports `useConsole()` singleton from `console.ts`. |
| N-06 | `cli/src/index.ts:1` | 1900+ line command registrar imports entire CLI surface (co-changes with MCP/SDK). |
| N-07 | `plugin_runtime/utils/plugin_stats.ts:155` | Stats helper logs and encodes HTTP semantics callers must know. |
| N-08 | `src/stores/*` importing `~/services/console` | Pinia stores reach console client before auth bootstrap ordering is obvious. |
| N-09 | `utils/hono.ts` (both copies) | God module for CORS, errors, body parse, middleware keys. |
| N-10 | `plugin_runtime/utils/utils.ts:119` | `isDeprecatedPluginVersion` used by unrelated features with different min version args. |
| N-11 | `cloudflare_workers/api/index.ts:1` (graph out-degree 123) | API worker entry fans in most private/public routes. |
| N-12 | `tests/stats.test.ts:6` | Integration tests import `stats_actions` from plugin_runtime (test coupling acceptable, but documents public-ish export). |

### Surplus

Pass-through wrappers, unused extension points, dead duplication.

| ID | Location | Note |
| --- | --- | --- |
| S-01 | `supabase/functions/_backend/plugin_runtime/private/latency.ts:1` and `private/latency.ts:1` | Near-duplicate latency apps (try/finally vs linear). |
| S-02 | `supabase/functions/_backend/plugin_runtime/public/ok.ts:1` and `public/ok.ts:1` | Duplicate health apps. |
| S-03 | `utils/pg.ts:11` | Re-export only for `BEGIN_WRITE_TRANSACTION_SQL` from plugin tree. |
| S-04 | `utils/stripe.ts:28` | Re-export block from `stripe_billing.ts`. |
| S-05 | `cloudflare_workers/plugin/index.ts:28` | Deprecated `/plugin/*` prefix routes duplicated beside canonical paths. |
| S-06 | `supabase/functions/updates_debug/index.ts:1` | Second Deno entry reusing same updates app. |
| S-07 | `src/services/builderOnboardingChecklist.ts:3` | Re-exports `BUILDER_STEP_IDS` already imported on line 1. |
| S-08 | `plugin_runtime/utils/hono.ts` vs `utils/hono.ts` | Parallel error helpers (`BRES`, `quickError`) maintained twice. |
| S-09 | 12 SAME mirror files under H-30, H-31, etc. | Byte-identical copies still cost double review and double comment sweeps. |
| S-10 | `utils/ab_tests.ts:14` | Re-export from `ab_test_allocation.ts` only. |

### Special cases

Branches for one customer/version; swallowed errors; retries; skipped tests (documented only, no test edits this phase).

| ID | Location | Note |
| --- | --- | --- |
| X-01 | `plugin_runtime/utils/utils.ts:119` | Version floor parameters differ per call site. |
| X-02 | `plugin_runtime/plugins/channel_self.ts:205` | Channel self min versions local constants. |
| X-03 | `plugin_runtime/utils/appStatus.ts:33` | Cancelled apps treated as cloud when Stripe not configured. |
| X-04 | `utils/appStatus.ts:33` | Divergent guard vs plugin copy. |
| X-05 | `plugin_runtime/utils/updateOracleGuard.ts:236` | Oracle-safe fake `on_premise_app` 429. |
| X-06 | `plugin_runtime/plugins/stats.ts:179` | `need_plan_upgrade` string message branch. |
| X-07 | `src/services/consoleClient.ts:39` | `QUERY_RETRIES = 2` for read queries. |
| X-08 | `src/services/consoleClient.ts:192` | Empty `catch` returns `'retry'` for SSE pump. |
| X-09 | `src/services/capgoApi.ts:29` | Retries 429/5xx for idempotent methods. |
| X-10 | `src/services/stripe.ts:35` | Swallows loadStripe failure by deleting map entry. |
| X-11 | `cloudflare_workers/snippet/index.js:32` | `EDGE_ANSWERS_ENABLED` kill switch. |
| X-12 | `cloudflare_workers/snippet/index.js:42` | `STATS_ANSWER_ALL` feature flag. |
| X-13 | `tests/updates.test.ts:126` | `describe.skipIf(!USE_CLOUDFLARE)` dual harness. |
| X-14 | `tests/stats.test.ts:57` | Same Cloudflare guard pattern. |
| X-15 | `playwright/e2e/email-verification.spec.ts:59` | Conditional skip when CAPTCHA absent. |
| X-16 | `plugin_runtime/utils/pg.ts:1848` | Commented failure mode mapping to 503 vs cached 429. |
| X-17 | `utils/platform_admin_access.ts:1` | Platform admin impersonation-only path (must stay narrow). |
| X-18 | `console.ts:50` | Spoof admin JWT storage key convention. |

### Restating comments (estimate)

`node scripts/untangle/comment-estimate.mjs` on focus areas:

- 12810 line comments scanned
- **701** estimated restating (comment text overlaps the next code line)
- 318 likely external-context (keep across sweeps)

## Redesign (fixes)

Behavior stays unchanged. Stable layers depend on slower-changing layers. Pieces that co-change land in one module; unrelated pieces get explicit boundaries.

### Fix 1: Single source for plugin worker utils

Pieces that change together: everything under `plugin_runtime/utils/` that is not primary-DB-only.

Unrelated pieces untied: `_backend/utils/` keeps console, Stripe webhooks, queue, Drizzle console, and primary writes. Plugin worker imports a compiled subgraph only.

Depends on: generated types and shared contracts (Fix 2), not on console Pinia.

**Solves:**

- H-01 through H-31 (mirror inventory except items that are primary-only)
- N-01, N-02, N-03
- S-01, S-02, S-08, S-09
- X-04 (merge appStatus behavior deliberately once)

### Fix 2: One type generation pipeline for Database

Pieces that change together: `src/types/database.types.ts`, backend consumers, plugin worker types, CLI types.

Unrelated: hand-written `console_contract.ts`.

Depends on: Supabase CLI gen only.

**Solves:**

- H-26, H-39
- Co-change pair rank 1

### Fix 3: `supabase/functions/shared/` as the only cross-surface import target

Pieces that change together: pure functions used by console, CLI, and backend (stripe amounts, signup attribution, bundle column keys, device data shapes).

Unrelated: Hono handlers and RLS.

Depends on: Fix 2 for DB row types, not on `plugin_runtime`.

**Solves:**

- H-43, H-44, H-45, H-07 (console and CLI halves)
- N-05 (indirect, via typed shared modules)

### Fix 4: Console contract package boundary

Pieces that change together: `console_contract.ts`, `consoleClient.ts`, `console_auth_proxy.ts`, `console_data.ts`, allowlist.

Unrelated: plugin endpoints.

Depends on: API host env, not Supabase SDK in browser.

**Solves:**

- H-40, H-46
- N-08
- X-07, X-08

### Fix 5: Edge cache and snippet contract module

Pieces that change together: `rateLimitInfo.ts`, `snippetEdgeAnswer.ts`, `providerAsns.ts`, `cloudflare_workers/snippet/index.js`, `snippetEdgeReplay.ts`.

Unrelated: console billing.

Depends on: Fix 1 plugin utils export surface.

**Solves:**

- H-33, H-34, H-35, H-36
- X-11, X-12
- N-07 (stats logging tied to contract tests instead of ad hoc strings)

### Fix 6: Plugin worker request context

Pieces that change together: `cloudflare_workers/plugin/index.ts` middleware `c.set` block and `supabase_write_guard.ts` readers.

Unrelated: Supabase Deno deploy without worker.

Depends on: Fix 1.

**Solves:**

- H-32, H-31
- S-05 (route aliases documented or collapsed after metric check)

### Fix 7: Updates vertical slice

Pieces that change together: `plugins/updates.ts`, `update.ts`, `update_response.ts`, `updateReadCache.ts`, `updatesEdgeCache.ts`, Deno `supabase/functions/updates/index.ts`.

Unrelated: channel_self store.

Depends on: Fix 1, Fix 5.

**Solves:**

- H-37, H-48
- X-01 thresholds centralized in `plugin_version_policy.ts` (new internal module, no behavior change)

### Fix 8: Stats and channel_self vertical slices

Pieces that change together: each plugin handler plus its `stats_actions` / validation / rate-limit helpers.

Unrelated: private stats API `private/stats.ts`.

Depends on: Fix 1, Fix 6.

**Solves:**

- H-38
- `private/stats.ts` vs `plugins/stats.ts` name collision (H inventory stats naming)

### Fix 9: Stripe billing facade

Pieces that change together: `utils/stripe_billing.ts`, `utils/stripe_in_app.ts`, `utils/stripe_trial_plan.ts`, `private/stripe_billing.ts`, `triggers/stripe_event.ts`.

Unrelated: plugin endpoints.

Depends on: Vault Stripe keys.

**Solves:**

- H-49, N-04, S-04
- Co-change stripe cluster

### Fix 10: Console onboarding and bundle rules from shared, not backend path imports

Pieces that change together: `appOnboarding.ts`, `bundle_compatibility.ts`, `onboardingMissedSteps.ts`, console services.

Unrelated: plugin parser.

Depends on: Fix 3.

**Solves:**

- H-41, H-42
- CLI test import H-50 moves to shared or code-generated constants file

### Fix 11: CLI command surface split

Pieces that change together: `cli/src/index.ts`, `mcp/server.ts`, `mcp/tool-schemas.ts`, `sdk.ts`.

Unrelated: backend.

Depends on: CLI schemas package.

**Solves:**

- N-06
- Co-change CLI MCP cluster

### Fix 12: Primary `pg.ts` owns transaction mode

Pieces that change together: `utils/pg.ts`, `plugin_runtime/utils/pg.ts`, `pg_transaction_mode.ts`.

Unrelated: console Drizzle logger.

Depends on: Fix 1.

**Solves:**

- N-01, H-17
- S-03 (delete re-export shim after move)

### Fix 13: Comment sweep by area (after structural PRs)

Pieces that change together: comments within one directory per PR.

Unrelated: product logic.

Depends on: Fixes 1 to 12 landing to avoid churn.

**Solves:**

- 701 estimated restating comments (per-area targets in PR plan)

### Fix 14: Document dual test harness skips, no removal

Pieces that change together: `USE_CLOUDFLARE` guards in plugin tests only docs.

Unrelated: production code.

**Solves:**

- X-13, X-14 (document why skips exist; out of scope to merge harnesses)

## Byte-identical mirrors (verified at `origin/main`)

Command: `node scripts/untangle/compare-mirrors.mjs origin/main` (byte equality and SHA-256 of each file at that ref). Artifact: `scripts/untangle/mirror-verification-main.json`.

Live plugin traffic (`/updates`, `/stats`, `/channel_self`) is served by `cloudflare_workers/plugin/index.ts`, which imports only `supabase/functions/_backend/plugin_runtime/`. Supabase Deno entries `supabase/functions/updates`, `stats`, and `channel_self` also import `plugin_runtime/plugins/*`. All other Supabase function bundles import `supabase/functions/_backend/utils/`.

| File (both paths under `.../utils/`) | SHA-256 (both copies identical) |
| --- | --- |
| `channelSelfRateLimit.ts` | `a7c525832fad440056b7e5178c7815691f502ac294e9a30994df2606027068b3` |
| `deviceComparison.ts` | `4d2d20d757a582acbd4e9f576cee66c0828acd0a15e8590b42447d83880f8090` |
| `downloadUrl.ts` | `3d223d91cf0746ae1e5684653480eb74f729df286b08ca2d5f976f4661710faa` |
| `geolocation.ts` | `f667ac8e8e2290ec0dbec1a5403d83cf3a5c25ef0b987382bfdda2a4e6b6c696` |
| `manifest_encoding.ts` | `d0ce7ded74e77bec5e1867cd094309a37a373d8fb4bb94dab76ef5a94b2b5183` |
| `plugin_notification_queue.ts` | `de674c3cc4bf90f4d66ed280baf64dd3ddb1016c53997c913c5aa4a9cb94b725` |
| `queryHelpers.ts` | `579561b9bf1b4960c867190c4395dd32a5c8be1e04a861a7a04a0bf1753976bc` |
| `rateLimitInfo.ts` | `ce4809313988a1de01d678f11eb3dc023c933506d428a3a2d72e5b6e66124151` |
| `rollout.ts` | `607dbc1ebc2ea92b82ea1e629d815c76eb06383fe4ad565404f3154f63fa1e3d` |
| `statsInsights.ts` | `97bc1bf5863e671ce65d1a80dee0829cdec175b496bdc9704f4d4f5bbd8852fd` |
| `supabase_write_guard.ts` | `f711f08424d12056f2907c95307efd39e89d631aff68a9520cca371e66424592` |
| `version_manifest_sql.ts` | `3986b456ffcc8e89730e4b6fe4a535d9a47c2633b4f93deaf5fee7ce5da501ce` |

PR 7 collapses these twelve by keeping one file and redirecting imports.

## PR 8: diverged mirrors (29 files)

Goal: one canonical module per basename without changing behavior. Winner picks which copy survives when both trees still import the basename today.

Routing note: plugin worker and plugin Deno functions use `plugin_runtime/utils/*`. API, private, public, and trigger functions use `_backend/utils/*` (see `supabase/functions/private/index.ts:64`, `cloudflare_workers/api/*`).

| File | What differs | Winner if merge proceeds | Why |
| --- | --- | --- | --- |
| `api_version.ts` | Plugin copy drops console and upload CORS negotiation helpers present in main. | needs Martin decision | Plugin `public/ok.ts` and API worker both expose version headers from different copies. |
| `appStatus.ts` | Main checks `helper.available` synchronously and skips cache when false; plugin always builds cache keys and passes `updatesCacheTags` on `setAppStatus`. | needs Martin decision | `/updates`, `/stats`, `channel_self` use plugin copy; `public/app/put.ts:476` calls `deleteAppStatus` on main copy. |
| `bento.ts` | Main includes org lifecycle and marketing email paths; plugin copy is a reduced worker subset. | needs Martin decision | Main triggers and private jobs import main copy only. |
| `cache.ts` | Plugin adds `Cache-Tag`, `purgeLocalTaggedKeys`, and tagged `putJson`; main lacks purge-by-tag emulation. | needs Martin decision | Plugin hot paths tag app status; console and API rate limits use main copy. |
| `channelSelfStore.ts` | Main keeps `pg_rls` sync helpers and imports version constants from `plugin_compatibility`; plugin inlines constants and drops primary DB sync on write. | needs Martin decision | Affects legacy channel_self store bridge and whether primary writes run from Supabase routes. |
| `cloudflare.ts` | Main adds admin analytics, legacy download fail SQL, `versionCompare`, queue bindings; plugin trims bindings and analytics for worker bundle size. | needs Martin decision | `plugin_stats` and `nativeNotifications` split across copies. |
| `deviceDataCollection.ts` | Main file is a re-export barrel only. | `plugin_runtime` | Main already re-exports plugin implementation (`utils/deviceDataCollection.ts:1`). |
| `discord.ts` | Main redacts URLs via `sensitive_url.ts`; plugin logs raw `c.req.url` in 500 alerts. | needs Martin decision | Alert content changes if one copy wins. |
| `hono.ts` | Main keeps console upload CORS headers, `triggerValidator`, richer JWT claim types; plugin copy is minimal for device traffic. | needs Martin decision | Every Supabase route vs plugin worker entry diverge. |
| `invalids_ip.ts` | Provider ASN handling and block list logic diverge (plugin larger). | needs Martin decision | Imported on plugin hot paths and security tests reference both trees. |
| `legacyDownloadFail.ts` | Main implements download fail accounting integrated with `cloudflare.ts` stats; plugin stub is tiny. | needs Martin decision | Stats correctness on main private analytics if plugin stub wins. |
| `logging.ts` | Main exports `accessLog` with URL redaction; plugin uses shared `formatLogArgs` only. | needs Martin decision | Console access logging uses main hono logger wiring. |
| `manifest_size.ts` | Plugin adds batching and caps aimed at worker CPU limits; main keeps older sizing path. | needs Martin decision | Upload finalization touches both trees in tests. |
| `notifications.ts` | Main supports `recordDelivery` uniq ids; plugin drops `helper.available` sync guard. | needs Martin decision | Org retention and delivery gates differ. |
| `on_error.ts` | Plugin shortens PostHog capture and error mapping; main keeps extra branches for console. | needs Martin decision | `hono.ts` in each tree wires `onError` from its local copy. |
| `org_email_notifications.ts` | Plugin removes primary DB and RLS paths present in main; async cache guard pattern matches plugin `cache.ts`. | needs Martin decision | Billing and lifecycle emails use main copy on primary. |
| `pg.ts` | Different types (`PluginPgClient` vs `PgClient`), lazy connect, Hyperdrive fresh reads, vs checkout or release and Drizzle logger on main. | needs Martin decision | Co-change rank 2; both runtimes depend on different transaction and pool semantics. |
| `pg_errors.ts` | Regex character classes for SQLSTATE detection only (`\d` vs `[0-9]`). | Either copy | Equivalent acceptance rules; tests in `tests/pg-errors.unit.test.ts` should stay green. |
| `plugin_compatibility.ts` | Main file is a re-export barrel only. | `plugin_runtime` | Main already re-exports plugin (`utils/plugin_compatibility.ts:1`). |
| `plugin_stats.ts` | Small Cloudflare stats write and error surface differences. | needs Martin decision | `/stats` uses plugin copy; one main importer remains for internal stats helpers. |
| `postgres_schema.ts` | Drizzle table map drift between copies. | needs Martin decision | Both `pg.ts` copies import local `postgres_schema.ts`. |
| `posthog.ts` | Main wires queue and worker admin analytics env bindings; plugin copy is slimmer. | needs Martin decision | Error pipeline and triggers use main bindings. |
| `rate_limit.ts` | Main uses `>` vs plugin `>=` for API key limits, fixed window reset, and `RateLimit-Policy` headers. | needs Martin decision | Plugin endpoints and console API keys do not share semantics today. |
| `s3.ts` | Main keeps multipart and console upload helpers; plugin copy drops large sections. | needs Martin decision | Bundle and file routes on API worker need main behaviors. |
| `schema_validation.ts` | Main keeps Zod `numericStringSchema` helpers; plugin forbids Zod import for bundle size. | needs Martin decision | Console and private parsers use Zod helpers on main. |
| `supabase.types.ts` | Generated Database type line count differs (5788 vs 6622 lines at main). | Single generator output | Not runtime logic; fix is typegen parity (PR 2), not picking one handwritten file. |
| `types.ts` | Main exports analytics helper types (`VersionCompareFilter`, `NativeActiveDevicesByPlatformRow`, optional `version_name` on insights). | needs Martin decision | `cloudflare.ts` on each side imports its local `types.ts`. |
| `utils.ts` | Plugin uses `crypto.getRandomValues` for `isLimited`, adds `isVersionDeleted`, and calls `c.executionCtx.waitUntil` directly in `backgroundTask`. | needs Martin decision | `LIMITED_APPS` throttling and background tasks differ on plugin vs API worker. |
| `version.ts` | `utils/version.ts` exports `22.33.1` while `plugin_runtime/utils/version.ts` exports `12.201.4` at main. | needs Martin decision | `scripts/update-version.js` writes both paths from `package.json`, but release fingerprints intentionally diverge (`scripts/release-test-fingerprint.ts:22`). |

### PR 8 merge safety summary

| Bucket | Count | Files |
| --- | ---: | --- |
| Safe to merge in PR 8 without behavior choice | 4 | `deviceDataCollection.ts`, `plugin_compatibility.ts`, `pg_errors.ts`, `supabase.types.ts` (via PR 2 typegen) |
| needs Martin decision before single-file merge | 25 | All other rows marked above |
| Collapsed in PR 7 first | 12 | Byte-identical list in previous section |

### needs Martin decision (one line each)

1. `api_version.ts`: Merging changes which Capgo API version header non-plugin routes advertise versus plugin `ok`.
2. `appStatus.ts`: Merging changes whether cache is skipped when Cache API is not yet ready and whether purge tags attach on set.
3. `bento.ts`: Merging drops or keeps org marketing email flows that exist only in main.
4. `cache.ts`: Merging changes purge-by-tag behavior and tagged writes used by `/updates` edge cache.
5. `channelSelfStore.ts`: Merging changes whether legacy channel_self writes still sync through primary `pg_rls`.
6. `cloudflare.ts`: Merging changes analytics SQL, legacy download fail math, and worker binding surface area.
7. `discord.ts`: Merging changes whether Discord 500 alerts redact URLs.
8. `hono.ts`: Merging changes console CORS, DB triggers, and auth middleware available on API routes.
9. `invalids_ip.ts`: Merging changes provider infrastructure IP blocking on plugin endpoints.
10. `legacyDownloadFail.ts`: Merging changes stats adjustment for legacy download failures on dashboards.
11. `logging.ts`: Merging changes access log redaction used by console routes.
12. `manifest_size.ts`: Merging changes manifest size backfill throughput and limits.
13. `notifications.ts`: Merging changes delivery marker writes for retention crons.
14. `on_error.ts`: Merging changes global error JSON shape and PostHog capture on API vs plugin.
15. `org_email_notifications.ts`: Merging changes whether org emails still enqueue through primary DB paths.
16. `pg.ts`: Merging changes pool lifecycle, lazy connect, and replica lag handling on hot plugin paths and console SQL.
17. `plugin_stats.ts`: Merging changes how device stats posts hit Cloudflare analytics from `/stats`.
18. `postgres_schema.ts`: Merging changes Drizzle schema used by both `pg.ts` copies.
19. `posthog.ts`: Merging changes queue based exception capture on API worker.
20. `rate_limit.ts`: Merging changes API key quota math and response headers on console traffic.
21. `s3.ts`: Merging changes multipart upload and signing helpers on bundle file routes.
22. `schema_validation.ts`: Merging removes Zod coercions used by private and console parsers.
23. `types.ts`: Merging removes analytics types used by main `cloudflare.ts` insights queries.
24. `utils.ts`: Merging changes `LIMITED_APPS` randomness and `backgroundTask` waitUntil guard semantics.
25. `version.ts`: Merging collapses two intentional deploy version strings used in separate release fingerprints.

## Proposed PR plan (order)

Safest, highest leverage first. No changes under `capacitor-*` plugin packages (separate owners). No `.github/workflows` edits.

| Order | PR scope | Log items | Risk | Tests |
| --- | --- | --- | --- | --- |
| 1 | `shared/` expansion: move console-facing pure modules from `_backend/utils` | H-43 to H-45, H-07, Fix 3, Fix 10 (partial) | Low | `bun test:unit`, `console-no-supabase`, allowlist unit |
| 2 | Typegen copies all consumers (incl. `plugin_runtime` + CLI) | H-26, H-39, Fix 2 | Low | `bun types`, `bun typecheck` |
| 3 | Console contract extraction (`console_contract`, allowlist re-exports) | H-40, H-46, Fix 4 | Medium | `console-query-allowlist.unit`, `bun test:unit` |
| 4 | Plugin version policy module (no threshold changes) | H-48, X-01 to X-02, Fix 7 (partial) | Medium | `plugin-edge-cache-gate`, `updates` tests |
| 5 | Edge snippet contract tests + ASN single export | H-33 to H-36, Fix 5 | Medium | `cloudflare-snippet.unit`, `snippet-edge-answer.unit` |
| 6 | Worker request context + write guard alignment | H-32, Fix 6 | Medium | `plugin-supabase-write-guard`, Cloudflare plugin tests |
| 7 | Collapse 12 identical mirrors (import path redirect) | S-09, H-30, H-31 | Medium | `bun test:cloudflare:updates`, backend integration |
| 8 | Merge diverged plugin utils (29 files) behind one tree; only the 4 safe rows plus Martin-approved rows | H-01 to H-29, Fix 1, Fix 12, PR 8 table | High | Must prove `/updates`, `/stats`, and `channel_self` unchanged: `bun test:cloudflare:updates`, `bun test:cloudflare:all`, plugin unit or integration tests green. PR body lists test command exit codes and pass counts. |
| 9 | Updates / stats / channel_self vertical file moves | Fix 7, Fix 8 | High | Same proof bar as PR 8 for `/updates`, `/stats`, and `channel_self` with Cloudflare Workers and plugin test suites green; pass counts in PR body. |
| 10 | Stripe billing facade | H-49, Fix 9 | Medium | Stripe tests, Playwright billing specs |
| 11 | CLI registrar split (index vs sdk/mcp) | Fix 11 | Medium | `bun run cli:check`, `cli-compat` in monorepo |
| 12 | Comment sweep: `plugin_runtime` | Fix 13 | Low | Lint only |
| 13 | Comment sweep: `_backend/utils` + `private/` | Fix 13 | Low | Lint only |
| 14 | Comment sweep: `src/services` + `src/stores` | Fix 13 | Low | Lint + `bun test:front` smoke |

## Out of scope

- All `@capgo/capacitor-*` packages in root `package.json` (mobile plugin family, other owners).
- Merging Cloudflare vs Supabase integration test harnesses (document only, Fix 14).
- Test file edits on this phase.

## Counts (this log)

| Category | Count |
| --- | --- |
| Hidden links | 50 |
| Needless links | 12 |
| Surplus | 10 |
| Special cases | 18 |
| Restating comments (estimate) | 701 |
| Proposed fixes | 14 |
| Planned PRs | 14 |

Generated with static analysis on branch `untangle/decision-log`. Re-run scripts after large merges.
