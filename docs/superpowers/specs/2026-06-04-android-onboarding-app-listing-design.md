# Android Onboarding — App Existence Verification (Play Developer Reporting API)

**Date:** 2026-06-04
**Status:** Design — ready to implement (one empirical check outstanding, see §11)
**Scope:** Capgo CLI — `build init` (Android), **OAuth / "generate" service-account path only**
**Branch:** `wolny/android-onboarding-app-listing` (off `origin/main`)
**Sibling:** mirrors the iOS verify-app gate (PR #2397, `app-verification.ts` / `verify-app` step)

---

## 1. Summary (TL;DR)

After Google sign-in, list the developer's real Play Store apps via the **Play Developer Reporting API** (`apps:search`) and reconcile them against the project's Gradle `applicationId`:

- **Match** → silently confirm the package, no question (like iOS exact-match).
- **App exists, build id is wrong** → **Path A**: show a picker of the real Play apps. **Nothing is rewritten automatically.** If the user *explicitly* picks an app and then *explicitly* opts into "Rename my project for me", we run a **Trapeze** rename (+ `cap sync`, re-check) — otherwise they pick/retype/decline. The rename is a user-invoked convenience behind confirmation, never silent.
- **No app exists** → **Path B**: open Play Console so the user clicks **"Create app"** (the *single* irreducible manual step on Android), then proceed — the first build uploads as a draft and succeeds.

OAuth-only: the listing uses the **user's** OAuth token + the `playdeveloperreporting` scope. We never enable the Reporting API on the user's service account, so the **import (custom-SA) path** keeps today's Gradle-only flow with a "verification skipped" warning. Any verification failure degrades gracefully to the plain Gradle picker — onboarding is never blocked.

---

## 2. Problem

`android-package-select` picks the Play package purely from local Gradle (`findAndroidApplicationIds`). Nothing checks the package actually exists in the user's Play Console, so a wrong/stale/typo'd `applicationId` flows through, the SA gets invited/granted for a package Play doesn't have, and the failure only surfaces at build/publish time. This is the Android analog of the iOS verify-app gap.

## 3. Goal / invariant

> **A Play Store app record exists whose `packageName` == the project's build `applicationId`.**

That's the whole invariant. If it holds, Capgo Builder's first build uploads as a draft and succeeds (§Appendix). If it doesn't, the build 404s. Everything below is just *detecting* which case we're in and guiding the user to satisfy it.

---

## 4. Background facts (researched; confidence-flagged)

| Fact | Confidence | Source |
|---|---|---|
| `apps:search` (`GET …/v1beta1/apps:search`) lists apps "accessible by the user" → `{packageName, displayName}`, paginated | HIGH | [reporting API ref](https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/apps/search) |
| It's a **separate** API from `androidpublisher`; single scope `…/auth/playdeveloperreporting`; works with SA *or* user OAuth | HIGH | reporting API getting-started |
| `playdeveloperreporting` + `androidpublisher` are **non-sensitive** scopes (no Trust & Safety review) | HIGH | the project's Cloud Console Data Access page (only `cloud-platform` is sensitive there) |
| Creating a **public** Play app record is **UI-only** — no `apps.create`, no fastlane/Terraform/automation, Console login is bot-blocked | HIGH | androidpublisher ref; fastlane; gradle-play-publisher README; 2024–2026 release notes |
| The **first** AAB upload to a never-released app **works via API as a `draft`** once the app record exists | MEDIUM | [fastlane #18293](https://github.com/fastlane/fastlane/discussions/18293) ("Only releases with status draft may be created on draft app") |
| `edits.insert` 404s until the **app record exists** — so the hard gate is *app creation*, not the first upload | HIGH | gradle-play-publisher #75/#836; Codemagic docs |
| Capgo Builder already uploads with `release_status: ENV['PLAY_STORE_RELEASE_STATUS'] \|\| 'draft'` to the `internal` track | HIGH | `capgo_builder_new/src/fastlaneTemplateAndroid.ts:442` |
| Whether `apps:search` lists a **zero-release Draft** app (created, never uploaded) | **UNVERIFIED** | needs one empirical probe (§11) |
| The Custom App Publishing API can create+upload, but only **permanently-private managed Google Play** apps — irrelevant for public apps | HIGH | custom-app-api/publish |

Net: the only thing a human must do for a brand-new app is click **"Create app"** once. Listing existing apps is solved by `apps:search`; the first upload is handled by the builder's existing draft default.

---

## 5. Design

### 5.1 New API helper

`cli/src/build/onboarding/android/reporting-api.ts`:
- `parseAppsSearchResponse(json): { packageName, displayName }[]` — pure, tolerant (mirrors iOS `parseAppsResponse`).
- `listPlayApps(accessToken): Promise<{ packageName, displayName }[]>` — `GET …/v1beta1/apps:search?pageSize=1000`, follow `nextPageToken` to a sane cap, `Authorization: Bearer <user OAuth token>`. Thin fetch; pure parser is unit-tested.

### 5.2 Reuse the iOS classifier

Reuse `app-verification.ts` (`classifyAppVerification`) from `main`: feed `releaseBundleId: gradleId`, `apps`, `registeredBundleIds: []` → `exact-match | wrong-build-id | no-app-*`. Keep the decision logic shared.

### 5.3 Verification on `android-package-select` (generate path only)

When entering `android-package-select` AND `serviceAccountMethod === 'generate'`:
1. Detect Gradle ids (`findAndroidApplicationIds`) **and** `listPlayApps(await ensureAccessToken())`.
2. Reconcile ("expand the Gradle list") and route:
   - **Exactly one Gradle id, and it's in `apps` → auto-confirm, skip the picker.** `addLog('✓ Building "<name>" (<pkg>) — matches your Play Store app.')` → continue to `gcp-setup-running`.
   - **Account has apps, build id matches none → Path A picker** (real Play apps annotated `✓ in Play Console`, the Gradle ids, "type a different name", and a "Create a new app → Path B" entry). Choosing a real app whose `packageName` ≠ the build id **then offers** the Trapeze rename as one option (alongside "I'll fix build.gradle myself — re-check" and "Back"). The rename is **never run without that explicit second choice.**
   - **No apps at all → Path B.**
3. The chosen/renamed package flows into `androidPackageChosen` / SA grant exactly as today.

### 5.4 Path A — user-invoked rename via Trapeze (explicit opt-in, never automatic)

Hand-editing an Android `applicationId` correctly spans `build.gradle`, `namespace`, manifest/package, then needs `cap sync` — "retype it" is a non-starter. So we *offer* (never force) **"Rename my Android project to `<pkg>` for me"** as one menu option, powered by Trapeze. The orchestrated sequence below runs **only after the user explicitly selects that option** — there is no code path that rewrites the project without that choice. The script:

```ts
const project = new MobileProject('.', { android: { path: 'android' } })
await project.load()
await project.android?.setPackageName(appId)
const gradle = await project.android?.getGradleFile('app/build.gradle')
await gradle?.setApplicationId(appId)
await gradle?.setNamespace(appId)
await project.commit()
```

**Trapeze is NOT bundled** — installed on demand into a temp dir only when the user opts in (CLI stays lean). Orchestrated sequence:

1. **Prepare** — `mkdtemp`; write `package.json` (`type: module`) + `rename.mjs` (script above, `<appId>` from `argv`); `npm install @trapezedev/project@<pinned>` in the temp dir (spinner "Preparing the project renamer…"). Node resolves the import from `<tmp>/node_modules`; run with **cwd = the user's project** so `MobileProject('.')` targets it.
2. **Close Android Studio (gate).** Editing native files while Studio holds them open risks a half-written project / Studio clobbering the change.
   - macOS: `pgrep -f "Android Studio"`; if running → "Please quit Android Studio — continues automatically once closed", re-check ~1s until gone.
   - Other OSes: one-time "Close Android Studio if open" confirm, then proceed.
3. **Run** `node <tmp>/rename.mjs <pkg>` (cwd = project); capture output.
4. **Verify** — re-read `findAndroidApplicationIds` and confirm it now contains `<pkg>`; if not, surface output + manual fallback (never claim false success).
5. **`npx cap sync`** (cwd = project; spinner) to keep Capacitor consistent; non-zero exit surfaced but non-fatal.
6. **Re-reconcile** → matches → proceed.

Loader + feedback mirror iOS; cancel/back always available.

### 5.5 Path B — create the app (one click), then we take over

Offer **"Open Play Console to create this app"** → opens `https://play.google.com/console`; the user clicks **Create app**. Then re-check (`apps:search`, loader + attempt counting + ask-before-reopen, same mechanics as iOS) and proceed.

- The Create-app click is the **only** irreducible manual step (no API/automation exists — HIGH confidence).
- **No manual first upload needed:** the builder uploads the first AAB as a `draft` to `internal` by default (`fastlaneTemplateAndroid.ts:442`), which is exactly what a never-released app accepts.
- **Inform, don't hard-gate:** the click can't be automated, and `apps:search` freshness for a just-created app is unverified (§11), so allow proceed after informing — blocking could trap a user whose new app hasn't propagated.
- Per-build nuance (not an onboarding blocker): `draft` means the user clicks "rollout" in Play Console to push each build to testers; `PLAY_STORE_RELEASE_STATUS` overrides for auto-rollout.

### 5.6 Import (custom-SA) path — Gradle-only + warn

When `serviceAccountMethod === 'existing'`, keep today's Gradle-only picker, plus a one-line banner: *"App existence isn't verified on the imported-service-account path (it needs Google sign-in). Proceeding with the package from build.gradle — make sure it exists in Play Console."* No `apps:search`, no OAuth.

### 5.7 Graceful degradation (never block)

On the generate path, if the reporting scope wasn't granted, the API is disabled (403), the token can't refresh, or the call errors/times out → **warn + fall back to the plain Gradle picker**. A verification failure must never block onboarding (the optional scope, §6, is what makes this safe).

---

## 6. Scope / config changes

- Add `https://www.googleapis.com/auth/playdeveloperreporting` to `OAUTH_SCOPES_FOR_ONBOARDING` (`app.tsx:179`) **as optional** — excluded from the required-scope check so its absence degrades gracefully.
- Backend `/private/config/builder` must include it in `scopes[]` to actually be requested (coordinate; the CLI tolerates absence).
- Consent screen already lists it (non-sensitive) — no verification submission.

## 7. Telemetry

`channel: 'bundle'`, `tags.step: 'android-app-verify'` always set:
- `Android App Verify Shown` — generate path, step entered. tags: `app_count`, `gradle_id_count`.
- `Android App Verify Result` — `result` ∈ `exact-match` / `wrong-build-id` / `no-app` / `multi-gradle` / `scope-missing` / `fetch-failed` / `skipped-import`.
- `Android App Verify Picked` — tags: `matches_play_app`, `source` (gradle | play-app | manual).
- `Android App Verify Auto Fixed` — Trapeze rename verified. tags: `from`, `to`, `cap_sync_ok`, `studio_wait_ms`.
- `Android App Verify Create App Opened` — Path B. tags: `attempt`.

## 8. Error handling

- Reporting scope missing / 403 / network → warn + Gradle-only fallback (degraded, not blocked).
- No `ad_hoc` equivalent on Android — the only fork is generate vs import.
- Never throw out of the verification path into the wizard.

## 9. Testing

- **Pure:** `parseAppsSearchResponse` (well-formed / empty / missing fields / pagination); reuse/extend `app-verification` decision tests for Android inputs (single-match-skip, no-match, multi-Gradle, empty list).
- **Branch:** generate-vs-import gating; scope-missing/fetch-failed → fallback (pure decision fn).
- **Trapeze (pure parts):** temp-script/`package.json` generation; post-run verification (re-read Gradle ids → contains `<pkg>`); Android-Studio-detection predicate (mock `pgrep`). `npm install` / `node` / `cap sync` spawns are integration-only (mock the spawner).
- Wire `test:` script + aggregate entry, matching the onboarding test pattern.

## 10. Out of scope (v1)

- **Bundling Trapeze** — installed on demand only (the rename itself is in scope).
- **Enabling the Reporting API on / granting the scope to the user's service account** — OAuth-token only.
- **Verification on the import (custom-SA) path** — warn + skip.
- **Auto-creating the Play app** — the "Create app" click is UI-only (no API/bypass).
- **Hard-gating Path B** — inform + allow proceed.

## 11. Decisions & open questions

**Decided:**
- **Always full rename (always set `namespace`).** Path A always runs the proven 3-call script (`setPackageName` + `setApplicationId` + `setNamespace`). Skipping `namespace` is not an option — AGP 8 requires it, and a package move (`setPackageName`) with a stale `namespace` breaks `R`/`BuildConfig` imports and fails the build. No "namespace opt-in."
- **`npx cap sync` after the rename is REQUIRED** — keep it (not optional).
- **On-demand Trapeze install** — accepted (pin version + spinner + manual fallback on failure).
- **Android Studio detection** — accepted: macOS auto-detects (`pgrep`) + polls until closed; other OSes get a one-time confirm.
- **Backend coordination → test via preprod.** Add the `playdeveloperreporting` scope to preprod's `/private/config/builder` `scopes[]` and point the CLI at it via `CAPGO_BUILDER_CONFIG_URL` for end-to-end testing. The scope stays optional so prod (before the scope is added) degrades gracefully.

**Open:**
- **Does `apps:search` list a zero-release Draft app? (UNVERIFIED — one probe / preprod test.)** Decides whether the post-"Create app" re-check can *confirm* success or must *trust-and-proceed*. Does **not** block implementation (Path B informs-and-proceeds either way).
- **Multiple Gradle flavors** — when >1 `applicationId` matches a Play app, show the picker (no auto-skip). Confirm vs. iOS-style "pick the main one". (Minor; picker is the safe default.)

## 12. Appendix — why Path B "completes after one click"

The Android brand-new-app path used to look like a dead end ("you can't create the app or upload via API"). Research refined this into two separate gates:

1. **App-record creation** — genuinely UI-only. No public API, no fastlane/Terraform/Custom-App bypass (Custom App API only makes permanently-private enterprise apps). The user must click **Create app** in Play Console once.
2. **First upload** — *not* the blocker. Once the app record exists, the first AAB uploads via API as a `draft` (fastlane #18293), and Capgo Builder already defaults to `release_status: draft`. So the build does it automatically.

Therefore the entire "no app" flow reduces to a single human action — the Create-app click — and everything after is automated.
