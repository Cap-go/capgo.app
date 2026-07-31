# Capgo Builder onboarding + build PostHog tracking

**Date:** 2026-05-18
**Branch:** `feat/builder-tracking-posthog`
**Worktree:** `capgo-builder-tracking-wt`
**Scope:** changes confined to the `capgo` repo. The `capgo_builder` repo is **not** modified.

## Goal

Mirror the existing Capgo onboarding-progress PostHog tracking onto the **Capgo Builder** flow so we can see (a) where users drop off in the iOS / Android credential-setup wizard and (b) build-lifecycle outcomes. Privacy posture matches the existing CLI exception telemetry: no raw error strings, no file paths, no credentials — only categorized enums and stable identifiers.

## Non-goals

- No new tracking for runtime OTA updates (decision: out of scope).
- No tracking added inside the `capgo_builder` repo. `build_started` is derived server-side by the existing reconciliation cron, which already polls the builder.
- No new analytics dashboards; events feed the existing PostHog project.
- No removal or refactor of existing tracking. `sendEventToTracking` is reused as-is.

## Event families

### 1. Onboarding step events

One event per CLI wizard step transition. Sent from the CLI through the existing `/private/events` endpoint so the existing dual-writer (LogSnag + PostHog) and org grouping apply automatically.

**Event:** `Builder Onboarding Step`
**Channel:** `builder-onboarding`
**Icon:** `🧭`

**Payload:**
```ts
{
  event: 'Builder Onboarding Step',
  user_id: orgId,                          // org id used as user_id (existing convention, see on_app_create.ts:138)
  channel: 'builder-onboarding',
  icon: '🧭',
  notify: false,
  groups: { organization: orgId },
  tags: {
    step: 'api-key-instructions',          // value from OnboardingStep | AndroidOnboardingStep
    platform: 'ios' | 'android',
    app_id: 'com.example.app',
    duration_ms: '1234',                   // ms spent on previous step; optional
    error_category: 'apple_api_unauthorized', // ONLY when step === 'error'
  },
}
```

**Closed enum: `error_category`**

iOS:
- `apple_api_unauthorized` — 401 from App Store Connect
- `apple_api_rate_limited` — 429 from App Store Connect
- `cert_limit_reached` — Apple cert quota hit
- `profile_creation_failed` — non-401/429 failure during profile creation
- `p8_invalid` — supplied P8 file unreadable or malformed
- `unknown` — anything that does not match an enum value above

Android:
- `keystore_invalid` — supplied keystore unreadable or aliases missing
- `google_oauth_failed` — Google sign-in did not return a valid token
- `play_account_id_invalid` — pasted Play developer account ID rejected
- `unknown` — fallback

The CLI maps caught exceptions to one of these enum values **before** building the payload. Raw error messages never leave the CLI.

### 2. Builder upload events (project tarball → builder storage)

Three events fired from the CLI around the TUS upload between `Build Requested` and `Build Started`. Until this set was added, the gap between "build job row inserted" and "builder picks it up" was an observability blind spot — a failed CLI-to-builder upload would never surface in PostHog.

**Channel:** `build-lifecycle`

| Event | Source | When | Icon |
| --- | --- | --- | --- |
| `Builder Upload Started` | `cli/src/build/request.ts` (just before `tus.Upload.start()`) | TUS handshake about to begin | ⬆️ |
| `Builder Upload Succeeded` | Same site, `onSuccess` callback | TUS upload completes; control passes to `/build/start/{job_id}` | 📦 |
| `Builder Upload Failed` | Same site, `onError` callback | TUS upload fatally fails | 🚫 |

**Payload:**
```ts
{
  event: 'Builder Upload Started' | 'Builder Upload Succeeded' | 'Builder Upload Failed',
  channel: 'build-lifecycle',
  icon: /* see table */,
  notify: false,
  user_id: orgId,
  groups: { organization: orgId },
  tags: {
    app_id,
    platform: 'ios' | 'android',
    build_mode: string,
    job_id,                                       // builder job id from `Build Requested` (for correlation)
    upload_size_bytes,                            // exact zip size from `zipStats.size`
    upload_duration_seconds?,                     // succeeded/failed only — wall-clock from `tus.Upload.start()` to terminal callback
    failure_category?,                            // failed only
  },
}
```

**Closed enum: `failure_category` for upload failures**

- `network_error` — TUS error with no `originalResponse` (connection dropped, DNS, timeout)
- `unauthorized` — HTTP 401 or 403 from the upload endpoint
- `payload_too_large` — HTTP 413
- `storage_failure` — HTTP 5xx from R2/S3
- `unknown` — any other terminal status

Mapping happens in the CLI helper via structural typing on `error.originalResponse?.getStatus?.()` (no hard import of `tus.DetailedError`).

### 3. Build lifecycle events

Fired entirely server-side. The `capgo_builder` repo is not modified — the reconciliation cron already polls the builder for status, so transition detection happens there.

**Channel:** `build-lifecycle`

| Event              | Source file                                      | When                                                                           | Icon |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------ | ---- |
| `Build Requested`  | `public/build/request.ts` (after insert)         | Build row successfully inserted into `build_requests`                          | 🛠️   |
| `Build Started`    | `triggers/cron_reconcile_build_status.ts`        | Status transitions from a non-running state into `running`                     | ⏳   |
| `Build Succeeded`  | `triggers/cron_reconcile_build_status.ts`        | Terminal status `success` reached for the first time (was non-terminal before) | ✅   |
| `Build Failed`     | `triggers/cron_reconcile_build_status.ts`        | Terminal status `failed` reached for the first time                            | ❌   |
| `Build Timed Out`  | `triggers/cron_reconcile_build_status.ts`        | `timeoutApplied === true` and was non-terminal before                          | ⏰   |

**Payload:**
```ts
{
  event: 'Build Requested' | 'Build Started' | 'Build Succeeded' | 'Build Failed' | 'Build Timed Out',
  user_id: orgId,
  channel: 'build-lifecycle',
  icon: /* see table */,
  notify: false,
  groups: { organization: orgId },
  tags: {
    app_id,
    platform: 'ios' | 'android',
    build_mode: 'development' | 'production',
    duration_seconds: '120',               // terminal events only
    failure_category: 'timeout' | 'builder_error' | 'validation_error' | 'unknown',  // Failed / Timed Out only
  },
}
```

**Closed enum: `failure_category`**

- `timeout` — `timeoutApplied` was set on this reconciliation pass
- `builder_error` — builder reported a terminal failure with a non-empty error
- `validation_error` — build_requests row marked failed before the builder accepted it (e.g., invalid `build_mode`, missing credentials)
- `unknown` — anything else

Mapping happens in `cron_reconcile_build_status.ts` next to the existing status-update logic.

## Architecture

```text
ONBOARDING:

  CLI wizard step reducer
    └─→ trackOnboardingStep(step, platform, appId, error?)        [cli/src/build/onboarding/telemetry.ts]
          └─→ POST /private/events                                [reuses existing endpoint]
                └─→ backend validates body, resolves orgId via resolveTrackingUserId
                      └─→ sendEventToTracking(...)                 [supabase/functions/_backend/utils/tracking.ts]
                            ├─→ logsnag(c).track(...)
                            └─→ trackPosthogEvent(c, {...})

BUILDS:

  public/build/request.ts
    └─ insert build_requests row succeeded
        └─→ sendEventToTracking('Build Requested')

  triggers/cron_reconcile_build_status.ts (cron)
    └─ for each stale build:
        ├─ fetch latest builder status
        ├─ compare to previous DB status
        └─ on transition:
            ├─ pending|queued → running    : sendEventToTracking('Build Started')
            ├─ * → success                 : sendEventToTracking('Build Succeeded')
            ├─ * → failed                  : sendEventToTracking('Build Failed')
            └─ timeoutApplied              : sendEventToTracking('Build Timed Out')
```

### Why the CLI does not call PostHog directly

The CLI already has `capgo/cli/src/posthog.ts`, but it is scoped to exception capture (`$exception` events with stack traces). Routing onboarding events through the backend gives us:

- Org grouping for free (`groups: { organization: orgId }`) without the CLI having to know the org id
- Dual-write to LogSnag (existing convention)
- Auth-gated event source (anyone with a CLI token is a real user)
- Consistency with `on_app_create.ts` and the other backend trackers

### Why reuse `/private/events` instead of a new endpoint

The existing `/private/events` Hono handler (lines 79–162 of `events.ts`) already implements every concern the spec needed for a new endpoint: shared JWT/API-key auth, org resolution via `resolveTrackingUserId` (verifies the caller can post for that org), app_id permission check from `tags.app_id`, sendEventToTracking with org grouping. Adding a second endpoint would duplicate ~80 lines of working code. The CLI helper just POSTs with `event: 'Builder Onboarding Step'` and the new event flows through the same code path.

### Why `build_started` does not need capgo_builder changes

The existing reconciliation cron already fetches builder job status for every stale build. We can detect the queued → running transition by comparing the new builder status against the persisted `build_requests.status` before this pass overwrites it. The transition fires the event; the existing update writes the new status.

## File changes

All paths relative to the `capgo` repo root.

### New files

- `cli/src/build/onboarding/telemetry.ts` — Exposes `trackOnboardingStep(input)`. Best-effort `fetch` to the existing `/private/events` endpoint with `AbortController` timeout (1500ms, matches `posthog.ts`). Never throws.
- `tests/build-lifecycle-tracking.unit.test.ts` — Cron-side tests: transitions emit the right events, idempotency when re-running on the same build, `failure_category` mapping.

### Modified files

- `supabase/functions/_backend/public/build/request.ts` — After the successful insert (between the existing `Build job created` cloudlog at line 307 and the `c.json` return at line 316), emit `Build Requested`. Payload sourced from the just-inserted row.
- `supabase/functions/_backend/triggers/cron_reconcile_build_status.ts` — Capture `build.status` (the previous status) into a local before the `.update(...)` call. After the update, compare previous vs. `effectiveStatus` and emit the matching transition event. Wrap each emission in `backgroundTask(c, ...)` so the cron is not delayed by tracking I/O.
- `cli/src/build/onboarding/ui/app.tsx` — iOS state lives here (`useState<OnboardingStep>` at line 91, ~20 `setStep(...)` call sites). Add **one** `useEffect(() => { ... }, [step])` near the top of the `OnboardingApp` component that fires `trackOnboardingStep({ step, platform: 'ios', app_id, duration_ms, error_category? })`. Use a `useRef<{ step, startedAt }>` to remember the previous step and compute `duration_ms = Date.now() - startedAt`. The effect updates the ref at the end so the next transition has a fresh baseline.
- `cli/src/build/onboarding/android/ui/app.tsx` — Same single-`useEffect` wiring with platform `'android'`.
- `cli/src/build/onboarding/types.ts` — Export the iOS `OnboardingErrorCategory` union for `telemetry.ts`.
- `cli/src/build/onboarding/android/types.ts` — Export the Android `OnboardingErrorCategory` union.

### Not modified

- `capgo_builder/` submodule — explicitly out of scope.
- `aliproxy/` — unrelated (Alibaba CDN proxy for the updater).
- `cloudflare_workers/` — no builder code lives here.
- `cli/src/posthog.ts` — kept as exception-only telemetry. Generic event tracking lives in the new `telemetry.ts` file to keep responsibilities separate.

## Privacy posture

- **Closed-enum error categories**: the CLI maps caught exceptions to a known string before sending. Raw error messages, paths, and credential material never leave the CLI process.
- **Reused sanitizer**: where any string field is unavoidable (e.g., during future extensions), `sanitizeTelemetryText` from `cli/src/posthog.ts` is the canonical pre-send filter.
- **No user_id fingerprinting**: `user_id` in the payload is the org id, matching `on_app_create.ts:138`. Individual users are not distinguished in PostHog.
- **No CLI opt-out env var in this PR**: this PR does not introduce a `CAPGO_DISABLE_TELEMETRY` or `CAPGO_DISABLE_POSTHOG` check in any new helper. The existing exception-capture helper (`cli/src/posthog.ts`, introduced in PR #2088) honors those vars, but the new helpers do not. Adding a unified opt-out at the `sendEvent` layer is deferred to a follow-up.
- **App id is sent**: the user explicitly chose to include `app_id` as a tag, matching existing `on_app_create.ts:141` behavior. Bundle IDs are not treated as PII in the existing tracking surface.

## Error handling

- **CLI helper**: `try { await fetch(...) } catch { /* swallow */ }`. AbortController with 1500ms timeout. Never blocks the wizard. Never logs to stdout (would pollute Ink UI).
- **Backend endpoint**: Returns 200 even when `sendEventToTracking` reports per-provider failures (already handled inside `sendEventToTracking`). Returns 400 only for schema validation errors.
- **Cron transitions**: emit inside `backgroundTask(c, ...)`. Per-build failures of tracking do not abort the reconciliation loop (already wrapped in `Promise.allSettled`).
- **Idempotency**: cron only processes stale (non-terminal) builds. Even so, the transition check uses the previous DB status explicitly — re-running the cron on the same build cannot double-fire.

## Testing strategy

- **Unit (CLI)**: mock `sendEvent`, assert payload shape, assert error-category mapping, assert error swallowing.
- **Unit (backend endpoint)**: mock `sendEventToTracking`, assert it is called with the expected `event`, `tags`, `groups`. Assert 401 without auth, 400 on bad payload.
- **Unit (cron)**: feed synthetic builder responses, assert correct transition events fire and only the expected ones. Re-run on the same build → no duplicate emission.
- **Existing test harness**: extends patterns in `tests/tracking.unit.test.ts`, `tests/posthog.unit.test.ts`, and `tests/on-error-posthog.unit.test.ts`.

## Open items / explicit decisions

- **No `Build Cancelled` event** for now. `public/build/cancel.ts` exists and could fire it, but cancellations were not in the user's scope. Easy to add later.
- **No per-org rate limit** on onboarding events at the reused `/private/events` endpoint. The wizard has fewer than 35 transitions per run; abuse risk is low. Revisit if we ever see > 1000 events/org/day.
- **Duration timing is wall-clock from CLI**. Users who walk away mid-wizard and return next day will produce one huge `duration_ms` value. We accept this — it is also signal (long pauses mean drop-off).
