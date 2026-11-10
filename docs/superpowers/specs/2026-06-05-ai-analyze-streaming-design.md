# AI Build Analysis — Streaming Redesign

**Date:** 2026-06-05
**Status:** Draft for review
**Repos affected:** `Cap-go/capgo` (edge function + CLI), `Cap-go/capgo_builder` (worker)

## 1. Problem

The AI build-debug feature times out for roughly half of all failed CI builds.

Evidence (workflow logs from `Cap-go/capgo`, June 3–5 2026): of 21 failed
builder runs that reached the AI step, 10 ended with
`AI analysis failed: The operation was aborted due to timeout.` at almost
exactly 60s, and the successful runs measured 45–54s — the analysis duration
distribution straddles the timeout.

Root cause: two stacked, *equal* 60s wall-clock timeouts —
`cli/src/ai/analyze.ts:61` (CLI → API) and
`supabase/functions/_backend/public/build/ai_analyze.ts:195` (API → builder).
The CLI's clock starts earlier and also covers auth, DB checks, and uploading a
multi-MB log body, so the CLI always aborts first whenever the LLM needs ~60s.

Secondary defects in the current design:

- A timeout leaves `ai_analyzed = false`, so the one-analysis-per-job cost
  control is retry-bypassed (cost leak).
- Conversely, if the builder finishes just after the client gives up, the flag
  flips and the (paid-for) analysis is discarded; retries get `409`.

## 2. Decision summary

| Topic | Decision |
| --- | --- |
| Transport | SSE streaming end-to-end (Workers AI → builder → capgo API → CLI). Fixed wall-clock budgets are replaced by data-flow watchdogs. |
| New endpoint | `POST /build/ai_analyze_stream` on the capgo API gateway. |
| Old endpoint | `POST /build/ai_analyze` is **immediately deprecated**: it always returns `426 Upgrade Required` with a message telling the user to upgrade `@capgo/cli`. No proxying, no AI call. Handled in `capgo` (edge fn), not `capgo_builder`. |
| Persistence | **None.** The analysis text is never stored anywhere (liability decision). It exists only in transit. |
| Flag semantics | **Claim-then-refund**: atomically claim `ai_analyzed = true` *before* calling the builder; refund only on provably-pre-AI failures; everything ambiguous fails closed (slot stays consumed). Client disconnects never refund. |
| Handshake / ack protocol | Rejected — the open HTTP connection is the implicit "ready to receive"; an explicit ack adds states without changing outcomes. |
| Durable Objects | Not used. The builder handler stays a stateless Worker handler. |

## 3. Protocol

### 3.1 New endpoint: `POST /build/ai_analyze_stream`

Request (unchanged shape from the old endpoint):

```text
POST /build/ai_analyze_stream
capgkey: <apikey>
content-type: application/json
accept: text/event-stream

{ "jobId": "...", "appId": "...", "logs": "<captured build log>" }
```

Pre-stream failures are plain JSON with an HTTP status (the stream has not
started, so status codes still work):

| Status | Code | Meaning | Slot consumed? |
| --- | --- | --- | --- |
| 400 | `invalid_state` | Build is not in `failed` state / row mismatch | No (never claimed) |
| 401/403 | `unauthorized` | Bad key / no `app.build_native` permission | No |
| 409 | `already_analyzed` | Claim found `ai_analyzed = true` | Already was |
| 413 | `logs_too_big` | Body over 10 MB limit | No |
| 500 | `config_error` | `BUILDER_URL` / `BUILDER_API_KEY` missing | No |
| 502 | `builder_error` | Builder unreachable or pre-AI failure | **No — refunded** |

Success: `200` with `content-type: text/event-stream`. Events:

```text
event: chunk
data: {"text":"<token delta>"}

event: done
data: {"durationMs":48211}

event: error
data: {"code":"ai_error" | "idle_timeout"}
```

- `chunk` — text deltas, concatenated by the client in order.
- `done` — terminal; the analysis is the concatenation of all `chunk` texts.
- `error` — terminal; mid-stream failure. The slot **stays consumed**
  (fail closed). The CLI shows any partial text plus a notice.

### 3.2 Old endpoint: `POST /build/ai_analyze`

Always returns, regardless of body:

```text
426 Upgrade Required
{ "error": "AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest",
  "code": "upgrade_required" }
```

The human-readable text MUST be in the `error` field: the deployed CLI's
error branch resolves the printed message as `body.error || body.message`
(`cli/src/ai/analyze.ts`, unchanged since the feature's first release,
commit `803e4752c`), so a machine code in `error` would shadow the
instruction. With this shape, old CLIs print
`AI analysis failed (426): AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest.`
with no client change. `code` carries the machine-readable identifier for
new clients and tests. The handler keeps the apikey middleware (consistent
auth surface, and telemetry below) but performs no DB reads/writes and never
contacts the builder.

### 3.3 Builder endpoint: `POST {BUILDER_URL}/jobs/{jobId}/ai-analyze`

Internal, `x-api-key`-authenticated, called only by the capgo edge function.

- Success: `200` + `text/event-stream`, same `chunk`/`done`/`error` event
  protocol as §3.1 (the edge function pipes it through).
- Pre-stream errors: JSON with an explicit cost marker:

```text
{ "error": "invalid_json" | "logs_too_big" | "ai_error", "aiStarted": true | false }
```

`aiStarted: false` — the request was rejected before `env.AI.run` was invoked
(auth, body validation, `trimLogs` overflow). `aiStarted: true` — `env.AI.run`
was invoked and threw; billing state is unknown, so it counts as started.
The edge function refunds **only** on `aiStarted: false` (or a connection-level
failure where the request never reached the builder).

The builder becomes **streaming-only** once rollout completes (§8); during
rollout it gates on `Accept: text/event-stream` and keeps the current buffered
JSON path for the not-yet-updated edge function.

## 4. Flag lifecycle (claim-then-refund)

```text
1. checkPermission(app.build_native)            — user context
2. SELECT build_requests WHERE builder_job_id   — user context; verify
   AND app_id; require status = 'failed'          ownership + state
3. CLAIM (service-role, atomic):
   UPDATE build_requests SET ai_analyzed = true
   WHERE builder_job_id = $1 AND app_id = $2 AND ai_analyzed = false
   RETURNING builder_job_id
   → 0 rows: 409 already_analyzed
4. fetch builder (streaming)
5a. Connection failure (DNS/TLS/refused — request never reached builder):
    REFUND (service-role): SET ai_analyzed = false WHERE builder_job_id = $1
    → respond 502 builder_error (retryable)
5b. Builder non-200 with aiStarted = false:
    REFUND → respond 502 builder_error (retryable)
5c. Builder non-200 with aiStarted = true, malformed error body,
    first-chunk watchdog fired, idle watchdog fired, mid-stream error,
    or client disconnect at any point:
    NO REFUND (fail closed — AI cost may have been incurred)
6. Stream completes → emit telemetry in executionCtx.waitUntil()
```

Why claim-before-call: Workers AI charges input tokens at prompt ingestion, so
cost commits at *submission*, not at delivery. Flipping the flag on first
delivered chunk would let an abuser POST-and-disconnect repeatedly — each
attempt starts a paid AI run but never flips the flag. Claiming first closes
that hole: spam-and-disconnect consumes the job's single slot on the first
attempt and every subsequent request is a cheap 409 that never reaches the
builder.

Why the refund is safe: every refunded cycle is provably zero-AI-cost
(`aiStarted: false` over the trusted server-to-server channel, or the request
never connected). Total AI runs per job therefore stay ≤ 1 under any
interleaving of retries, spam, races, or disconnects.

Failure handling of the refund write itself: log loudly, do not retry the
analysis — failing closed costs the user a retryable slot in a rare case but
can never cost Capgo an extra AI run.

Concurrency: the conditional UPDATE serializes on the Postgres row lock —
N parallel requests yield exactly 1 claim and N−1 409s. (The current code's
SELECT-check-then-flip has a much wider race; this change removes it.)

## 5. Timeouts and watchdogs

Fixed wall-clock budgets are replaced by liveness checks. All values are
constants, staggered so the inner layer always fires before the outer.

| Layer | First-byte watchdog | Idle (between chunks) | Total safety cap |
| --- | --- | --- | --- |
| Edge fn → builder | 90 s | 30 s | none (CF Workers has no wall-clock limit while streaming) |
| CLI → edge fn | 120 s | 45 s | 10 min |

- The first-byte watchdog is generous because prompt ingestion of a large
  trimmed log produces no tokens for a while.
- Watchdogs are implemented as a timer reset inside a `TransformStream` on the
  pipe; firing aborts the upstream fetch via `AbortController` and (edge fn)
  emits `event: error` `{"code":"idle_timeout"}` downstream.
- Watchdog expiry never refunds (the AI run was in progress).

## 6. Component changes

### 6.1 `capgo_builder` (`src/ai-analyze.ts`)

- `env.AI.run(MODEL, { messages, stream: true })` → returns a `ReadableStream`
  of Workers AI SSE. Normalize it into the §3.1 event protocol via a
  `TransformStream` (model-specific delta shapes are absorbed here, so the
  edge fn and CLI never know which model is behind it).
- Pre-stream error responses gain the `aiStarted` marker (§3.3).
- Wire the incoming request's abort signal / stream cancellation through to
  the AI stream so upstream cancellation stops generation (output-token waste
  reduction; best-effort, not a security control).
- Contingency: if `@cf/deepseek-ai/deepseek-v4.1-flash-1017` rejects `stream: true`, the
  builder buffers internally and emits the full text as a single `chunk`
  followed by `done` — protocol and all downstream code unchanged.
- `extractAnalysis()` and the buffered path are deleted at rollout step 4.

### 6.2 `capgo` edge function (`supabase/functions/_backend/public/build/`)

- New route `ai_analyze_stream` implementing §4: permission → ownership/state
  SELECT → atomic claim → builder fetch with watchdogs → SSE passthrough →
  refund matrix → telemetry in `waitUntil`.
- Existing `ai_analyze.ts` proxy logic is replaced by the static 426 responder
  (§3.2). The 60s `AbortSignal.timeout` and flip-after-success code paths are
  deleted.
- Passthrough is `return new Response(transformedStream, …)` — no buffering,
  no tee, no storage of analysis text.

### 6.3 `capgo` CLI (`cli/src/ai/analyze.ts`, `cli/src/build/request.ts`)

- `postAnalyzeRequest` → `postAnalyzeStreamRequest`: targets
  `/build/ai_analyze_stream`, sends `accept: text/event-stream`, parses SSE
  (hand-rolled parser ~40 lines or `eventsource-parser`), accumulates chunks.
- TTY mode: write text progressively as chunks arrive (replaces the spinner
  wait); CI mode: buffer and print the final block exactly as today, so
  GitHub Actions log output format is unchanged.
- Timeout handling per §5 CLI row.
- Mid-stream `error` event: print partial text, then
  `AI analysis was interrupted; this job's analysis slot is used. The full log is saved at <path> for local AI.`
  (reuses the existing local-AI prompt-file fallback).
- Result kinds: `ok | already_analyzed | too_big | upgrade_required | error`
  (the new CLI should still decode a 426 gracefully in case of version skew).

## 7. Telemetry

Existing privacy rule is unchanged: **analysis text never appears in any
event, tag, or log.**

- `AI Build Analysis Requested` — unchanged (fired after the claim succeeds).
- `AI Build Analysis Result` — `result` enum extended:
  `success | already_analyzed | builder_error | invalid_state | unauthorized |
  config_error | mid_stream_error | refunded` plus existing `logs_bytes`,
  `duration_ms`.
- New: old-endpoint hits emit `result: upgrade_required` so the remaining
  old-CLI population is visible on the CLI Tracking dashboard before the
  buffered builder path is deleted.
- CLI events (`CLI AI Build Analysis Choice` / `Result`) keep their enums with
  `mid_stream_error` added.

## 8. Rollout

1. **builder** — add Accept-gated streaming + `aiStarted` markers (buffered
   JSON path retained). Zero behavior change for the current edge fn.
2. **capgo edge fn** — ship `ai_analyze_stream` + switch `ai_analyze` to the
   426 responder. From this moment all old CLIs get the upgrade message.
3. **CLI release** — streaming client. CI workflows using
   `bunx @capgo/cli@latest` pick it up automatically on the next run.
4. **builder cleanup** — delete the buffered path and `extractAnalysis()` once
   step 2 has been live and `upgrade_required` telemetry confirms the edge fn
   cutover (target: within a week).

Each step is independently deployable and reversible; the only user-visible
discontinuity is the intended one (old CLIs told to upgrade at step 2).

## 9. Testing

- **capgo edge fn** (`tests/build-ai-analyze.test.ts`, rewritten):
  - claim happens before any builder fetch (ordering assertion);
  - claim is the atomic conditional UPDATE via the **service-role** client
    (preserves the existing RLS regression tests);
  - refund matrix: refunds on connection failure and `aiStarted:false`; no
    refund on `aiStarted:true`, malformed bodies, watchdog expiry, disconnect;
  - concurrent duplicate requests → exactly one claim, one 409;
  - 426 + message on the old route, with `upgrade_required` telemetry;
  - SSE passthrough fidelity and `event: error` on idle-watchdog fire.
- **capgo_builder**: stream normalization per supported delta shape;
  `aiStarted` correctness on each pre-stream error; single-chunk fallback.
- **CLI**: SSE parsing (chunk/done/error, split-across-packets frames),
  first-byte/idle/total timeout behavior, TTY vs CI rendering, partial-text +
  interruption message branch.
- **Manual/E2E**: one real failed build through CI with `--ai-analytics`
  before step 4 deletes the fallback path.

## 10. Out of scope (explicitly)

- Persisting analysis text anywhere (rejected: liability).
- Handshake/ack protocols, WebSockets, Durable Objects (rejected: complexity
  without benefit — see §2).
- Fixing the *log capture truncation* issue (the captured log sometimes misses
  the actual Gradle/Fastlane error, which degrades analysis quality). Separate
  investigation; streaming changes neither cause nor fix it.
- Per-org rate limiting on the endpoint (ops nicety; the claim makes abuse
  non-economic — each job requires a paid failed build and yields ≤ 1 AI run).
