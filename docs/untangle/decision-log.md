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
| 8 | Merge diverged plugin utils (29 files) behind one tree | H-01 to H-29, Fix 1, Fix 12 | High | Cloudflare all + backend integration shards |
| 9 | Updates / stats / channel_self vertical file moves | Fix 7, Fix 8 | High | Plugin tests, `test:cloudflare:updates` |
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
