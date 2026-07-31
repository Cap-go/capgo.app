# Implementation Plan — Android Onboarding App Existence Verification

**Date:** 2026-06-06
**Spec:** [`../specs/2026-06-04-android-onboarding-app-listing-design.md`](../specs/2026-06-04-android-onboarding-app-listing-design.md)
**Branch:** `wolny/android-onboarding-app-listing` (off `origin/main`)
**Style:** micro-commits per task; each task ends green (typecheck + lint + tests).

## Conventions

- Worktree root `$W = …/.claude/worktrees/android-app-verify`. Run from `$W/cli`.
- **Typecheck:** `$W/cli/node_modules/.bin/tsgo --project $W/cli/tsconfig.tsgo.json --noEmit`
- **Lint:** `$W/cli/node_modules/.bin/oxlint --config $W/.oxlintrc.json`
- **Tests:** `bun $W/cli/test/test-<name>.mjs`
- **Build:** `cd $W/cli && bun run build`
- After any `bun install`: `git checkout -- bun.lock` before committing.
- All new files: pure logic separated from I/O so the pure parts are unit-tested; spawns/fetches mocked.

## Dependencies (non-code, parallel track)

- **D1. Preprod scope.** Add `https://www.googleapis.com/auth/playdeveloperreporting` to preprod's `/private/config/builder` `scopes[]`. Test the CLI against it via `CAPGO_BUILDER_CONFIG_URL=<preprod>`. (Scope stays optional → prod degrades gracefully until added there.)
- **D2. apps:search Draft probe.** Against a real account: create a Draft app (Console "Create app", zero releases) → call `apps:search` → record whether it appears. Feeds the Path B "confirm vs trust-and-proceed" decision. Non-blocking.

---

## Phase 1 — Reporting API helper

**T1.1** `cli/src/build/onboarding/android/reporting-api.ts`
- `parseAppsSearchResponse(json): { packageName, displayName }[]` — pure, tolerant (mirror iOS `parseAppsResponse`).
- `listPlayApps(accessToken, opts?): Promise<{ packageName, displayName }[]>` — `GET https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=1000`, follow `nextPageToken` (cap ~10 pages), `Authorization: Bearer <token>`. Inject `fetchImpl` for testability.
- `cli/test/test-android-reporting-api.mjs` — parser: well-formed, empty, missing `packageName`/`displayName`, multi-page accumulation, garbage.
- `package.json`: add `test:android-reporting-api` + aggregate chain entry.
- **Commit:** `feat(cli): add Play Developer Reporting apps:search helper (listPlayApps)`

## Phase 2 — OAuth scope wiring (optional)

**T2.1** `cli/src/build/onboarding/android/ui/app.tsx`
- Add `playdeveloperreporting` to `OAUTH_SCOPES_FOR_ONBOARDING` (L179).
- Ensure it is **not** in the required-scope set checked by `findMissingScopes`/`MissingScopesError` — a user who doesn't grant it must NOT fail sign-in (graceful degrade later). Add/extend a "required vs optional scopes" split if needed in `oauth-google.ts`.
- **Commit:** `feat(cli): request playdeveloperreporting scope (optional) for app listing`

## Phase 3 — Reconcile decision (pure)

**T3.1** `cli/src/build/onboarding/android/app-verification-android.ts` (thin wrapper around the shared iOS `classifyAppVerification`)
- `reconcileAndroidApp({ gradleIds, apps }): { kind: 'exact-match', packageName } | { kind: 'wrong-build-id' } | { kind: 'no-app' } | { kind: 'multi-gradle' }`.
  - one gradle id ∈ apps → `exact-match`.
  - apps non-empty, no gradle id ∈ apps → `wrong-build-id`.
  - apps empty → `no-app`.
  - >1 gradle id (and not a clean single match) → `multi-gradle` (force picker).
- `cli/test/test-android-app-verification.mjs` — all four branches + empty inputs.
- `package.json`: test script + aggregate.
- **Commit:** `feat(cli): add Android app-existence reconcile decision (+ tests)`

## Phase 4 — `android-package-select` integration (generate path) + graceful degrade

**T4.1** Effect (`app.tsx` ~L1438) — when `step === 'android-package-select'`:
- Always detect gradle ids (today's behavior).
- If `serviceAccountMethod === 'generate'`: also `listPlayApps(await ensureAccessToken())` (guarded by a `verifyFetchStartedRef`); on success run `reconcileAndroidApp`; store result + apps in state.
- On scope-missing / 403 / network / token error → set a "degraded" flag + warn log; fall through to the plain gradle picker. **Never throw into the wizard.**
- If `serviceAccountMethod === 'existing'` → skip the fetch; set the "import — not verified" banner flag.

**T4.2** Render (`app.tsx` ~L2917):
- `exact-match` → auto-confirm (no picker): `addLog('✓ …')`, persist `androidPackageChosen`, advance. (The only no-prompt case; modifies nothing.)
- `wrong-build-id` / `multi-gradle` → **enriched picker**: Play apps (annotated `✓ in Play Console` + displayName) + gradle ids + "type a different name" + "Create a new app → Path B". Selecting a Play app whose pkg ≠ build id → routes to the Path A action menu (T5).
- `no-app` → Path B screen (T6).
- import path / degraded → today's gradle-only picker + the warning banner.
- Reuse the `gateActionSeq` remount-key pattern on any `<Select>` that stays mounted (avoid the @inkjs/ui re-fire bug).
- **Commit:** `feat(cli): verify Android app against Play apps on package-select (generate path)`

## Phase 5 — Path A: user-invoked Trapeze rename (explicit opt-in)

**T5.1** `cli/src/build/onboarding/android/android-rename.ts` (pure-ish, I/O injected)
- `buildRenameWorkspaceFiles(pkg): { packageJson, renameMjs }` — the temp `package.json` (`type: module`, pinned `@trapezedev/project`) + `rename.mjs` (setPackageName + setApplicationId + setNamespace + commit; `<appId>` from argv). **Always all three calls.**
- `isAndroidStudioRunning(platform, pgrepOutput)` — pure predicate (macOS only; non-mac → returns `unknown`).
- `verifyRenamed(gradleIds, target): boolean`.
- `cli/test/test-android-rename.mjs` — workspace-file generation, predicate (running/closed/unknown), verify.
- **Commit:** `feat(cli): add Android rename workspace builder + AS-detection predicate (+ tests)`

**T5.2** Orchestration in `app.tsx` (runs ONLY on explicit "Rename for me" selection):
1. `mkdtemp` → write files → `npm install` (spinner "Preparing the project renamer…"); on failure → manual-instructions fallback.
2. **Close-Android-Studio gate:** macOS `pgrep -f "Android Studio"` + poll ~1s until gone (Continue auto-fires); non-mac → one-time confirm.
3. Run `node <tmp>/rename.mjs <pkg>` (cwd = project); capture output.
4. `verifyRenamed`; on failure → surface output + manual fallback (never claim success).
5. `npx cap sync` (spinner; non-zero surfaced, non-fatal).
6. Re-run `reconcileAndroidApp` → exact-match → advance.
- Loader + cancel/back throughout. Telemetry `Android App Verify Auto Fixed`.
- **Commit:** `feat(cli): Path A — user-invoked Trapeze rename + cap sync + re-check`

## Phase 6 — Path B: create app (one click) + re-check

**T6.1** `app.tsx` Path B screen:
- "Open Play Console to create this app" → opens `https://play.google.com/console` (ask before re-opening on subsequent attempts — iOS mechanics).
- "Re-check" → re-`listPlayApps` + reconcile, with loader + attempt counting.
- **Inform + allow proceed** (never hard-block): explain the one manual step is "Create app", the first build uploads as a draft automatically.
- Telemetry `Android App Verify Create App Opened`.
- **Commit:** `feat(cli): Path B — open Play Console to create app + re-check (inform, not gate)`

## Phase 7 — Telemetry

**T7.1** Wire the events from spec §7 (`Shown` / `Result` / `Picked` / `Auto Fixed` / `Create App Opened`), `channel: 'bundle'`, `tags.step: 'android-app-verify'` always set; mirror the iOS `trackEvent` plumbing.
- **Commit:** `feat(cli): telemetry for Android app-verify step`

## Phase 8 — Verify & ship

**T8.1** Full green: typecheck + lint + every new test + `bun run build`.
**T8.2** Manual E2E against **preprod** (`CAPGO_BUILDER_CONFIG_URL=<preprod>`) using a Capacitor test app:
- match → auto-confirm; wrong-id → picker → rename → cap sync → proceeds; no-app → Path B → Create app → re-check.
- import path → warning banner, gradle-only.
- scope absent → degrades to gradle picker.
**T8.3** Run D2 probe; record whether Path B re-check can confirm vs trust-and-proceed; adjust Path B copy if needed.
**T8.4** Open **draft PR** (base `main`); summary + test plan; link spec + plan.
- **Commit(s):** any fixes from verification.

## Risk / rollback

- Feature is **purely additive** to the generate path and **degrades to today's behavior** on any failure (graceful fallback), so risk is contained.
- Trapeze rename mutates the user's project — gated behind explicit opt-in + AS-closed + post-verify; never silent.
- Prod stays inert until D1 adds the scope to prod config (CLI tolerates its absence).
