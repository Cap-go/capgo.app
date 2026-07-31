# CLI client-side Supabase performance tracking

**Date:** 2026-05-29
**Branch:** `wolny/cli-supabase-perf-tracking` (to be created)
**Worktree:** `strange-shaw-3b11a2`
**Scope:** changes confined to the `cli` package of the `capgo` repo. No backend changes (the existing `/private/events` endpoint and v2 actor-scoped contract are reused as-is).

## Goal

Give us client-side observability into how fast (and how reliably) the CLI's Supabase calls are. Today we have **zero** visibility into Supabase latency from the user's machine: we can't tell whether a user's `bundle upload` is slow because of their network, a slow RPC, or a Postgres statement timeout. This feature emits a fire-and-forget `Supabase Call` performance event for **every** Supabase REST/RPC request the CLI makes, carrying duration, HTTP status, and a categorized failure reason — so we can answer "which users hit timeouts, on which operation, from which command."

Privacy posture matches the existing CLI telemetry: no query filter values, no row data, no tokens, no bodies — only the operation name (table/rpc + method), durations, status codes, and closed enums.

## Non-goals

- **No client-side timeouts.** We measure only. We never abort a Supabase call the CLI would otherwise complete (decision: pure observability, no behavior change, no new failure modes).
- **No response-body inspection.** The timed fetch never reads or clones response bodies (would risk consuming the stream supabase-js needs, and adds CPU/memory the "never slow the CLI" requirement forbids). Timeout/error signal comes from HTTP status + duration only.
- **No TUS upload tracking.** The bundle upload itself is `tus-js-client` over a different transport and is already partly covered by the existing `Builder Upload` / `App TUS` events. Out of scope here (this feature is the Supabase REST/RPC client only).
- **No worker thread.** Node is single-threaded; "off main thread" is achieved by fire-and-forget dispatch, not `worker_threads` (which would add startup + serialization overhead for no benefit at this event volume).
- **No SDK telemetry.** The `@capgo/cli` SDK bundle (`dist/src/sdk.js`) must not emit these events even though it transitively imports `createSupabaseClient`. Instrumentation is gated to the CLI/MCP entrypoints.
- **No new opt-out.** Reuses the existing `CAPGO_DISABLE_TELEMETRY` / `CAPGO_DISABLE_POSTHOG` guards in `trackEvent`.

## Background / dependency

This builds directly on the analytics foundation introduced in **PR #2358** (`wolny/cli-analytics-events`):

- `src/analytics/track.ts` — `trackEvent` (v2 actor-scoped, fire-and-forget, flush registry with abort-on-flush), `resolveTrackingContext` (per-key app/org cache), the command lifecycle, and the MCP wrapper.
- `src/analytics/error-category.ts` — `categorizeCliError()` and the closed `CliErrorCategory` enum.
- `src/analytics/org-resolver.ts` — `resolveOwnerOrgId()`.

Implement this on top of that branch (or after it merges). All of the "never slow the CLI" guarantees (fire-and-forget `void`, flush-on-exit, abort-on-flush) come for free by routing perf events through the existing `trackEvent`.

## The three "where" dimensions

A bare `GET apps` tells us almost nothing — the same table is queried from many call sites. Every `Supabase Call` event therefore carries three complementary "where" dimensions:

| Dimension | How it's captured | Reliability | Example |
|---|---|---|---|
| `operation` | automatic, parsed from the request URL path | always present | `rpc:get_user_id`, `GET apps`, `POST app_versions` |
| `command_path` | automatic, from the command lifecycle (the running command / MCP tool) | always present | `bundle upload`, `app list`, `mcp:capgo_list_apps` |
| `source` | **explicit label** via an `AsyncLocalStorage` scope (new) | present when the call site is annotated | `apps.checkExists`, `channel.setCurrentBundle` |

`operation` + `command_path` are free for all call sites and already disambiguate at command granularity (`GET apps` during `bundle upload` ≠ `GET apps` during `app list`). `source` adds the precise call site for the cases that need it — two different `apps` queries within the *same* command.

> Why `source` is explicit and not stack-derived: the published CLI is built with `minify: true` and `sourcemap: 'none'` (`build.mjs:307-308`). A runtime stack trace yields `index.js:1:284750` with mangled function names — useless. The call site must be captured **before** minification erases it, i.e. explicitly at the call site.

## Architecture

### 1. One generic injection point — a timed `fetch`

`createSupabaseClient()` (`src/utils.ts:642`) already passes a `global` block to supabase-js's `createClient`. supabase-js accepts a custom `global.fetch`. We inject a **timed fetch wrapper** there, so every `.rpc()` (26 call sites) and `.from()` (84 call sites) request — and any future one — is measured with a single change.

The wrapper:
1. captures `start` and the current `source` label (from the ALS store),
2. `await`s the real `globalThis.fetch` (the request that runs anyway → ~0 added latency),
3. on success records `{ status, ok, durationMs, source }`; on throw records `{ status: 0, ok: false, durationMs, source, error }`,
4. **returns the real `Response` / rethrows the real error** — supabase-js behavior is never altered,
5. fires the perf event fire-and-forget via the recorder (see §5).

It calls `globalThis.fetch` dynamically (not a captured reference) so tests that stub `globalThis.fetch` are observed, and so there is no fetch-level recursion.

### 2. Instrumentation gate — CLI/MCP only, SDK excluded

`sdk.ts` transitively imports `createSupabaseClient` (via `addAppInternal`, `uploadBundleInternal`, …). To keep the end-user SDK on the plain fetch (zero overhead, no events), instrumentation is **off by default** and enabled explicitly only at the CLI/MCP entrypoints:

- `supabase-perf.ts` owns a module-level `enabled = false` flag, with `enableSupabaseInstrumentation()` and `isSupabaseInstrumentationEnabled()`.
- `src/index.ts` (CLI entrypoint) and `src/mcp/server.ts` (MCP entrypoint) call `enableSupabaseInstrumentation()` at startup. `sdk.ts` never does.
- `createSupabaseClient(apikey, supaHost?, supaKey?, silent = false, instrument = true)` injects the timed fetch only when `isSupabaseInstrumentationEnabled() && instrument`.

The existing no-key guard in `trackEvent` (`findSavedKeySilent()` → no key → no event) is a second backstop: even if instrumentation were enabled in an SDK host, an end user has no saved `~/.capgo` key, so nothing is sent.

### 3. Source labels via `AsyncLocalStorage`

A tiny helper wraps logical call sites:

```ts
await withSupabaseSource('apps.checkExists', () =>
  supabase.from('apps').select('app_id').eq('app_id', appId).maybeSingle())
```

`AsyncLocalStorage` propagates the label across `await`s and is async-safe under `Promise.all` (a module-level variable would race between concurrent in-flight requests). The timed fetch reads `getSupabaseSource()` synchronously at record time — still inside the ALS run, so the store is intact. Unlabeled calls degrade gracefully: the event simply omits `source` and relies on `operation` + `command_path`.

Naming convention: dotted `domain.action`, low-cardinality, prefix-groupable in PostHog (`apps.*`, `channel.*`, `bundle.*`).

### 4. Recursion prevention

A timed Supabase call fires `trackEvent`, which resolves org context via `resolveTrackingContext` → `resolveOwnerOrgId` → a Supabase query. If that query were instrumented, it would emit its own perf event → loop. Two layers prevent this:

- **Primary:** `resolveOwnerOrgId` creates its client with `instrument: false` (`createSupabaseClient(apikey, undefined, undefined, true, false)`), so telemetry's own org lookup is never measured and cannot re-enter the perf path.
- **Backstop:** `resolveTrackingContext` already caches the in-flight promise per API key (synchronously, before the await), so even an instrumented lookup would resolve to the cached promise rather than spawn a new query.

### 5. Module / dependency graph (no import cycle)

To avoid a `utils → track → utils` cycle, `supabase-perf.ts` is a **leaf** module that depends only on `node:async_hooks` and `error-category.ts`. The event builder is injected, not imported:

```text
supabase-perf.ts   (leaf: AsyncLocalStorage, timing, operation parsing, enable flag, recorder hook)
   ↑ imports                    ↑ imports (createTimedFetch, isSupabaseInstrumentationEnabled)
track.ts ───────────────────► utils.ts (createSupabaseClient)
   │  └─ on load: setSupabaseCallRecorder(recordSupabaseCall)   (harmless in SDK; gated by `enabled`)
   └─ defines recordSupabaseCall → builds tags → trackEvent({channel:'cli-perf', ...})
index.ts / mcp/server.ts ─ on startup: enableSupabaseInstrumentation()
```

- `supabase-perf.ts` exposes `setSupabaseCallRecorder(fn)`; `createTimedFetch()` calls the registered recorder (no-op if unset).
- `track.ts` registers `recordSupabaseCall` as the recorder on load (side-effect-free beyond setting a reference; instrumentation stays gated by the `enabled` flag, which `sdk.ts` never flips).
- `utils.ts` imports only `createTimedFetch` + `isSupabaseInstrumentationEnabled` from `supabase-perf.ts` — never `track.ts`. No cycle.

## Event shape

**Event:** `Supabase Call`
**Channel:** `cli-perf` (new; keeps higher-volume perf events filterable apart from `cli-usage`)
**Icon:** `⏱️`
**Dispatch:** `void trackEvent(...)` — fire-and-forget, flushed at exit, abortable. Inherits v2 actor-scoping (`tracking_version: 2`, backend-derived `user_id`, best-effort `org_id`) and the global props (`cli_version`, `os_platform`, `os_arch`, `is_ci`, `is_tty`, `invocation_source`) from `trackEvent`.

**Tags:**

```ts
{
  operation: 'rpc:get_user_id' | 'GET apps' | 'POST app_versions' | ...,  // see §Operation derivation
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD',
  status_code: 200,            // HTTP status; 0 when the fetch threw (network/abort)
  duration_ms: 142,            // Date.now() delta around the real fetch
  ok: true,                    // status in 200–299 and no thrown error
  slow: false,                 // duration_ms > SLOW_THRESHOLD_MS (5000)
  source: 'apps.checkExists',  // OMITTED when the call site is unlabeled
  command_path: 'bundle upload', // OMITTED when no command is active
  error_category: 'timeout',   // OMITTED when ok === true (closed enum, see below)
}
```

`error_category` is present **only on failures** (mirrors the builder spec's "only when step === 'error'"). PostHog rows for successful calls simply have no `error_category`.

## Operation derivation

`deriveSupabaseOperation(url: string, method: string): string` in `supabase-perf.ts`, pure + unit-tested:

1. `path = new URL(url).pathname` (query string discarded → no filter values, low cardinality).
2. Strip the `/rest/v1/` prefix.
3. If the remainder starts with `rpc/`, return `` `rpc:${fnName}` `` (e.g. `rpc:get_current_plan_max`). RPC names are self-describing, so RPC calls do not need a `source` label.
4. Otherwise return `` `${method} ${table}` `` where `table` is the first path segment (e.g. `GET apps`).
5. For any path that does not match `/rest/v1/` (defensive — e.g. a storage path), return `` `${method} ${firstSegment}` `` so the value stays bounded.

## Failure / outcome model (no body reads)

| Situation | `ok` | `status_code` | `error_category` |
|---|---|---|---|
| 2xx/3xx response | `true` | actual | omitted |
| Non-2xx HTTP response | `false` | actual | `categorizeHttpStatus(status)` |
| Thrown fetch error (network, DNS, abort) | `false` | `0` | `categorizeCliError(error)` |

We **cannot** distinguish a Postgres `57014` statement timeout from a generic 500 without reading the body (forbidden — see Non-goals). The strong timeout signal is therefore the **combination** `error_category in (timeout, server_error)` **and/or** `slow === true` and a high `duration_ms` — which is sufficient to answer "who hits timeouts."

New helper `categorizeHttpStatus(status: number): CliErrorCategory` in `error-category.ts`:

| status | category |
|---|---|
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 408, 504 | `timeout` |
| 413 | `payload_too_large` |
| 429 | `rate_limited` *(new enum member)* |
| 400, 422 | `validation_error` |
| ≥500 (other) | `server_error` |
| other 4xx | `unknown` |

This adds one member, `rate_limited`, to the `CliErrorCategory` union (also usable by `trackCommandFailed`; backward-compatible — just a new possible string value in PostHog).

## Source labeling: call sites to annotate

The `.rpc()` calls are already self-named via `operation`. We annotate the **high-value `.from()` query sites** so the dashboard ships useful from day one. Initial set (each wrapped in `withSupabaseSource(label, () => …)`):

| Label | Where | Why it matters |
|---|---|---|
| `apps.list` | `src/app/list.ts` | the `app list` path |
| `apps.checkExists` | `src/app/add.ts` (pre-create existence check) | runs inside `app add` **and** `bundle upload` pre-flight |
| `appVersions.list` | `src/api/versions.ts` | bundle/version listing latency |
| `channels.list` | `src/channel/list.ts` | channel listing |
| `channels.currentBundle` | `src/channel/currentBundle.ts` | `channel currentBundle` read path |
| `bundle.checkChecksum` | `src/bundle/upload.ts` pre-upload checks | the slow part users feel before an upload |
| `credentials.read` | the credentials read path used by `app/info` + build credentials | doctor/build credential reads |

Unlisted `.from()` sites stay unlabeled (still tracked via `operation` + `command_path`); labels can be added incrementally. `command_path` for MCP is set to `` `mcp:${toolName}` `` inside the existing MCP wrapper so MCP-originated Supabase calls are attributable.

## Performance guarantees (the hard requirement)

- **Measurement** = two `Date.now()` reads + one `getSupabaseSource()` ALS read around a fetch that already runs. No extra network, no body reads, no serialization on the hot path.
- **Dispatch** = `void trackEvent(...)` — never awaited on any command's critical path; flushed (≤2s) at process exit; aborted if the flush window elapses (offline/firewalled users never hang).
- **SDK / end users** = plain fetch, instrumentation never enabled → literally zero overhead.

## Privacy

Only `operation` (table/rpc name + HTTP method), `method`, `status_code`, `duration_ms`, `ok`, `slow`, the dotted `source` label, `command_path`, and the closed `error_category` enum leave the machine. Never: query filter values (e.g. the `app_id` being filtered on), request/response bodies, row data, headers, tokens, or raw error strings.

## Files touched

**Create:**
- `src/analytics/supabase-perf.ts` — leaf module: `AsyncLocalStorage` source store (`withSupabaseSource`, `getSupabaseSource`), `deriveSupabaseOperation`, `SLOW_THRESHOLD_MS`, the `enabled` flag (`enableSupabaseInstrumentation`, `isSupabaseInstrumentationEnabled`), the recorder hook (`setSupabaseCallRecorder`), and `createTimedFetch()`.
- `test/test-supabase-perf.mjs` — unit tests (see Testing).

**Modify:**
- `src/utils.ts` — `createSupabaseClient` gains `instrument = true`; injects `global.fetch = createTimedFetch()` when `isSupabaseInstrumentationEnabled() && instrument`.
- `src/analytics/track.ts` — define `recordSupabaseCall(info)` (builds tags, reads `currentCommandPath`, `void trackEvent({channel:'cli-perf', event:'Supabase Call', …})`); `setSupabaseCallRecorder(recordSupabaseCall)` on load; add a module-level `currentCommandPath` set by `trackCommandInvoked` (and exported setter used by the MCP wrapper); re-export `withSupabaseSource` for convenience.
- `src/analytics/error-category.ts` — add `categorizeHttpStatus`; add `rate_limited` to `CliErrorCategory`.
- `src/analytics/org-resolver.ts` — pass `instrument: false` to `createSupabaseClient`.
- `src/index.ts` — `enableSupabaseInstrumentation()` at startup.
- `src/mcp/server.ts` — `enableSupabaseInstrumentation()` at startup; set `currentCommandPath = \`mcp:${toolName}\`` in the tool wrapper.
- The ~7 query call sites in the labeling table — wrap with `withSupabaseSource`.
- `package.json` — register `test:supabase-perf` in the `test` script.

## Testing

`test/test-supabase-perf.mjs` (bun, `globalThis.fetch` stub pattern like `test-analytics.mjs`):

1. **`deriveSupabaseOperation`** (pure): `/rest/v1/rpc/get_user_id` → `rpc:get_user_id`; `/rest/v1/apps?select=*&app_id=eq.x` → `GET apps` (query stripped); `POST /rest/v1/app_versions` → `POST app_versions`; non-rest path → bounded `METHOD segment`.
2. **Timed fetch returns the real response unchanged** and records `ok:true`, a numeric `duration_ms`, the right `operation`/`method`/`status_code`.
3. **Timed fetch rethrows** a fetch error and records `ok:false`, `status_code:0`, `error_category` from `categorizeCliError`.
4. **Non-2xx** records `ok:false` + `error_category` from `categorizeHttpStatus` (e.g. 504 → `timeout`, 429 → `rate_limited`).
5. **`withSupabaseSource`** sets the `source` tag; async-safe under `Promise.all` (two concurrent labeled fetches keep distinct sources).
6. **Instrumentation gate:** with `enabled=false`, `createSupabaseClient` does not attach the timed fetch (a tracked sentinel fetch is never wrapped); with `enabled=true` it does.
7. **Recursion guard:** the `org-resolver` client is created with `instrument:false` (assert no `Supabase Call` event is emitted for the `owner_org` lookup).
8. **`slow` flag:** a stubbed fetch whose recorded duration exceeds `SLOW_THRESHOLD_MS` sets `slow:true`.
9. **`categorizeHttpStatus`** unit table (in `test-analytics-error-category.mjs` or the new file).

## Dashboard insights (PostHog, project 22029, dashboard 712327)

Add to the existing "Capgo CLI Tracking" dashboard once events flow:

- **Supabase p95 latency by operation** — `Supabase Call`, math `p95` of `duration_ms`, breakdown `operation`, line graph.
- **Supabase error rate by category** — `Supabase Call` where `ok = false`, breakdown `error_category`, bar.
- **Slow Supabase calls by command** — `Supabase Call` where `slow = true`, breakdown `command_path`, bar.
- **Supabase latency by source** — `Supabase Call`, math `p95` of `duration_ms`, breakdown `source`, bar (answers "which call site is slow").

(Insights stay empty until a CLI version carrying these events ships and is run by users.)

## Open questions / explicitly deferred (YAGNI)

- **Precise `57014` detection** would require a `res.clone().json()` body read — deferred; `slow` + `error_category` are sufficient for the headline question.
- **Per-command aggregate rollup** (one summary event/command) — deferred; per-request volume is fine for CLI traffic, and per-request is richer for timeout analysis.
- **`SLOW_THRESHOLD_MS`** is fixed at 5000ms; revisit once real p95s are visible.
