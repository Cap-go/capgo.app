# Builder CTA on Incompatible Upload — Design

Date: 2026-05-30
Status: Approved (pending spec review)
Scope: `@capgo/cli` only — no backend changes

## Summary

When `capgo bundle upload` detects an **incompatible** bundle (native dependencies
changed, so a native build is required), surface a contextual call-to-action for
**Capgo Builder**:

- **No build credentials** → offer to **set up the Builder** (`build onboarding`).
- **Has build credentials** → offer to **run a native build now** (`build request`).

The whole feature is client-side. Funnel measurement uses the existing PostHog
telemetry pipeline (`trackEvent` → `/private/events` → PostHog). It also backfills
the currently-missing upload-side compatibility tracking event.

## Motivation

- An incompatible bundle is exactly the moment Capgo Builder solves the user's
  problem: native changes need a new app-store binary, which is what the Builder
  produces and ships.
- The verdict already exists: `isBuildNeeded(finalCompatibility)` in
  `cli/src/build/needed.ts` is `finalCompatibility.some(entry => !isCompatible(entry))`
  — identical to the upload's compatibility result.
- The upload path currently emits **no** compatibility tracking event (only the
  standalone `bundle compatibility` command does), so the day-by-day PostHog graphs
  don't reflect real uploads. This feature closes that gap.

## Trigger

The CTA is evaluated only when **all** hold:

1. Command is `bundle upload`.
2. Compatibility ran and the verdict is **incompatible** (`isBuildNeeded(...) === true`).
   - If `--ignore-metadata-check` was passed, no compatibility check runs, so no CTA.

Compatible uploads are completely unchanged. The compatibility verdict itself remains
**non-fatal** (this feature does not block uploads).

## Behavior by environment

Interactivity is determined by the existing `canPromptInteractively()` helper
(already imported in `upload.ts`).

### Non-interactive / CI

Print a single `log.warn` line, **no prompt**, then continue the upload unchanged.
The action clause matches the local credential state (onboarding vs build), not both:

```text
# no credentials yet
This update includes native changes. An app store update may be required for these changes to take effect. Capgo Builder can help you build and publish the required native update. To set up Capgo Builder (npx @capgo/cli build onboarding) — learn more: https://capgo.app/native-build/ · docs: https://capgo.app/docs/cli/cloud-build/

# credentials found
… To run a native build (npx @capgo/cli build request --platform <ios|android>) — learn more: https://capgo.app/native-build/ · docs: https://capgo.app/docs/cli/cloud-build/
```

### Interactive (TTY)

Shown **once per invocation** as a single yes/no that states *why* up front. Branch
on local credentials. Declining (or cancelling) just continues the OTA upload —
there is no follow-up prompt.

Shown as **two messages**: first a context line, then a short yes/no prompt that
carries a clickable **"Learn what Capgo Builder is"** hyperlink (OSC 8) opening
<https://capgo.app/native-build/> in the browser without dismissing the prompt.

**No credentials → onboarding CTA**

```text
ℹ  This update includes native changes. An app store update may be required for these changes to take effect. Capgo Builder can help you build and publish the required native update.

◆  Would you like to configure Capgo Builder now? (Y/n)
│  Learn what Capgo Builder is  (→ https://capgo.app/native-build/)
```

- **Yes** → skip the OTA upload and return a `launch-onboarding` action; the CLI
  entry point launches `build onboarding`.
- **No / cancel** → continue the OTA upload.

**Has credentials → build CTA**

```text
ℹ  This update includes native changes. An app store update may be required for these changes to take effect. Capgo Builder can help you build and publish the required native update.

◆  Start a native build with Capgo Builder now? (Y/n)
│  Learn what Capgo Builder is  (→ https://capgo.app/native-build/)
```

- **Yes** → skip the OTA upload and return a `launch-build` action; the CLI entry
  point launches `build request`.
- **No / cancel** → continue the OTA upload.

## Credential detection (local)

"Has credentials" = `loadSavedCredentials(appId)` (from `cli/src/build/credentials.ts`)
returns a non-`null` entry for the current `appId`. Credentials live under
`~/.capgo-credentials/` — the same store `build request` reads. No new helper and
no server-side lookup (explicitly out of scope).

## No opt-out / snooze

There is **no opt-out, snooze, or "don't ask again" state**. A declined prompt simply
continues the upload, and the CTA may appear again on the next incompatible upload.
Non-interactive / CI runs get a single `log.warn` ad line (never a prompt), so there is
nothing to suppress there either.

## Accept → skip upload

Because accepting means the user is switching to a native build, the in-progress OTA
upload is abandoned before any zip/upload work:

- `verifyCompatibility` runs early in `upload.ts`, before the bundle is zipped.
- The CTA is evaluated right after the incompatibility is known.
- On `launch-onboarding` / `launch-build`, `uploadBundleInternal` returns early with a
  `builderAction` in its result (no zip, no upload); the CLI entry point then launches
  the Ink-based build command.

## Tracking (PostHog via existing `trackEvent`)

All events go through `cli/src/analytics/track.ts` → `sendEvent` → `/private/events`
→ PostHog. They carry the standard global props (cli_version,
node_version, os, is_ci, app_id, org group) automatically.

| Event | Tags |
| --- | --- |
| `Bundle Upload Compatibility Checked` | `result` (compatible/incompatible), `incompatible_count`, `reasons` |
| `Builder CTA Shown` | `surface` (ci/interactive), `mode` (onboarding/build), `incompatible_count` |
| `Builder CTA Accepted` | `mode` |
| `Builder CTA Declined` | `mode` |

This yields a funnel: incompatible upload → CTA shown → accepted → onboarding/build,
joinable with the existing **Capgo Builder Tracking** dashboard. The
`Bundle Upload Compatibility Checked` event also feeds the day-by-day
compatible-vs-incompatible graphs (previously only fed by the standalone command).

## Code shape (all client-side)

- `cli/src/bundle/builder-cta.ts`
  - `maybePromptBuilderCta(params): Promise<BuilderCtaAction>` where
    `BuilderCtaAction = 'continue' | 'launch-onboarding' | 'launch-build'` (string union).
  - Owns: environment detection, credential branch, prompt copy, the single confirm,
    and emitting the `Builder CTA *` events. `interactive` and `confirm` are injected
    by the caller for testability; the pure `decideBuilderCtaSurface` does the gating.
    The whole body is wrapped so it never throws (degrades to `continue`).
- Credential detection: reuse `loadSavedCredentials(appId)` from
  `cli/src/build/credentials.ts` (returns credentials | `null`); no new helper.
- `cli/src/bundle/upload.ts`
  - After `verifyCompatibility`, if incompatible **and not silent**: call
    `maybePromptBuilderCta`. On a launch action, skip the OTA upload and return a
    `builderAction` in the result. The Ink-based launch runs in the CLI entry point
    (`index.ts` → `cli/src/bundle/upload-command.ts`) so this SDK-shared module stays
    free of `ink`. CI path prints the ad and continues.
- Reuse `isBuildNeeded`, `getCompatibilityDetails` from
  `cli/src/build/needed.ts` and `isCompatible` from `cli/src/utils.ts`.

## Testing

- Unit tests (target ≥80% on new modules):
  - `decideBuilderCtaSurface` matrix: {interactive, CI} × {creds, no-creds} ×
    {compatible, env-disabled} → expected surface.
  - `maybePromptBuilderCta`: accept → launch action; decline/cancel → continue (single
    prompt, asserted); CI → ad + continue. Confirm injected; credentials + tracking mocked.
- Ensure no regression for compatible uploads and `--ignore-metadata-check`
  (no CTA, no new event other than the compat-checked event when applicable).

## Out of scope (YAGNI)

- No backend changes: no interest/waitlist endpoint, no server-side credential or
  build-usage lookup.
- CTA only in `bundle upload` (not `bundle compatibility` or `build needed`).
- No change to compatibility being non-fatal.
- No snooze / persistent prompt state.

## Decisions (resolved)

- Accept → skip upload; the CLI entry point launches the relevant build flow.
- Two messages in interactive mode: a context line, then a short yes/no prompt
  carrying a clickable "Learn what Capgo Builder is" link; declining (or cancelling)
  just continues the upload — no second prompt, no snooze.
- Warning copy: low-fear (native changes ship via an app-store build, not OTA).
- Architecture: CLI-only, PostHog for tracking, local credential check.
- `build request` is launched without `--path` (it resolves the project root and
  prompts for platform); the launch lives in the CLI entry point, not `upload.ts`.
