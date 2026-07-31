# Appflow -> Capgo migration in `capgo build init` - design

Status: design (brainstormed, pending review). Author flow validated against the live Appflow API
with throwaway probe scripts (see the local, uncommitted APPFLOW_MIGRATION_PRESPECS.md snapshot).

## 1. Summary

Add a third option to the `capgo build init` platform picker: **"Both, I'm migrating from Ionic
Appflow"** alongside `iOS` and `Android` (the internal platform value is `appflow`; the label says
"Both" because a migration can bring over iOS and Android credentials at once). The migration is ALSO
reachable for a single platform: picking `iOS` or `Android` first asks "Are you migrating from
Appflow?", and a YES runs the migration scoped to just that platform (for users who used Appflow on
one platform only). Entering the migration authenticates the user to Ionic/Appflow with
the same secure pathway the Ionic CLI uses, lets them pick an org and an app, then pulls that app's
signing + distribution credentials out of Appflow and imports them into Capgo build credentials.
After the credentials are in place (filling any gaps with the EXISTING onboarding generate/provide
flows), the migration REUSES the existing onboarding tail's building blocks (validate -> build ->
AI/email support on failure -> CI/CD) - reuse at the component/function level, NOT a single shared
flow or a 100% merge. The migration stays its own flow and has its own differences (e.g. a skip-build
option).

Design principle: **Appflow is a credential SOURCE, not a parallel onboarding.** Only auth + org/app
selection + credential fetch/map is new. Everything downstream (missing-credential generation,
validation, build, AI/email, CI/CD) reuses existing code unchanged.

## 2. Scope / non-goals

In scope: the migration front-end (auth, org, app, fetch, map), gap-filling via existing flows,
convergence onto the existing validate/build/CI tail, the platform-picker option, and three
validation hooks.

Non-goals: re-implementing any existing onboarding step; remote validation of iOS cert/provisioning
profile (not possible, do not attempt); migrating Appflow live-update/OTA history; non-`build init`
entry points (the MCP onboarding tool is out of scope for this spec).

## 3. The Appflow API surface (reference; confirmed live)

All requests: `https://api.ionicjs.com`, header `Authorization: Bearer ion_<token>`, plus dashboard
headers `Origin: https://dashboard.ionicframework.com` and the dashboard User-Agent.

Auth (port of Ionic CLI `webLogin`): OAuth 2.0 Authorization Code + PKCE (OpenID Connect).
- loopback callback `http://localhost:8123`; authorize `https://ionicframework.com/oauth/authorize`
  (`client_id=cli`, `audience=https://api.ionicjs.com`, `scope=openid profile email offline_access`,
  `code_challenge`+`S256`, `redirect_uri`, `nonce`); token exchange `POST /oauth/token`
  (form-urlencoded, `grant_type=authorization_code`+`code_verifier`).
- Returns: opaque `access_token` (`ion_...`, ~12h), `refresh_token` (offline_access), `id_token`
  (identity JWT), `token_type: Bearer`. The access token authorizes all API/GraphQL calls.

Enumerate (GraphQL `POST /graphql`):
- `BootstrapApp` -> `viewer.organizations.edges[].node { id name plan memberTotal slug apps{totalCount} }`.
- `OrganizationApps($slug,$first)` -> `organization.apps.edges[].node { id name slug nativeType ... }`.

Credentials, two categories per app (app id e.g. `27b1aa64`):
- SIGNING CERTS: list via GraphQL `GetDataForPackageCerts($appId)` ->
  `app.certificates.edges[].node { id name tag type credentials{ ios{...provisioningProfiles[]} android{...} } }`
  (each node carries EITHER `credentials.ios` OR `credentials.android`; `tag` is a UUID).
  Download via REST:
  - `GET /apps/{appId}/profiles/{tag}/credentials/ios` ->
    `{ cert_file:"data:application/x-pkcs12;base64,...", cert_password,
       provisioning_profiles:[{ application_identifier:"<TEAMID>.<bundleId>", name, uuid, filename,
       provisioning_profile_file:"data:application/x-apple-aspen-mobileprovision;base64,..." }] }`
  - `GET /apps/{appId}/profiles/{tag}/credentials/android` ->
    `{ keystore_file:"data:...;base64,...", keystore_password, key_alias, key_password }`
- DISTRIBUTION CREDS (store upload): list via REST `GET /apps/{appId}/distribution-credentials`
  -> `data[]` of `{ id, type, name, ... }` where type is `"iTunes connect"` (iOS) or `"google play"`.
  Secret requires `?fields=`:
  - iOS:     `GET .../distribution-credentials/{id}?fields=app_specific_password`
             -> `{ user_name, team_id, apple_app_id, test_flight, app_specific_password }`
  - Android: `GET .../distribution-credentials/{id}?fields=json_key_file`
             -> `{ package_name, track, json_key_file:"data:...;base64,<service-account JSON>" }`

## 4. Appflow -> Capgo credential mapping (exact)

iOS signing cert (`/profiles/{tag}/credentials/ios`):
- `cert_file` (strip the `...base64,` data-URI prefix) -> `BUILD_CERTIFICATE_BASE64`
- `cert_password` -> `P12_PASSWORD`
- each provisioning profile -> `CAPGO_IOS_PROVISIONING_MAP` entry
  `{ <bundleId>: { profile: <base64 mobileprovision>, name } }`, where
  `bundleId = application_identifier` with the leading `<TEAMID>.` removed.

iOS distribution (`iTunes connect`):
- `user_name` -> `FASTLANE_USER`
- `app_specific_password` -> `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD`
- `apple_app_id` -> `APPLE_APP_ID`
- `team_id` -> `APP_STORE_CONNECT_TEAM_ID`
- (`test_flight` -> `CAPGO_IOS_DISTRIBUTION = app_store`)
  This is exactly the app-specific-password support already shipped (capgo#2556 + builder#141 + docs#832).

Android signing cert (`/profiles/{tag}/credentials/android`):
- `keystore_file` (strip data-URI) -> `ANDROID_KEYSTORE_FILE`
- `keystore_password` -> `KEYSTORE_STORE_PASSWORD`
- `key_password` -> `KEYSTORE_KEY_PASSWORD`
- `key_alias` -> `KEYSTORE_KEY_ALIAS`

Android distribution (`google play`):
- `json_key_file` (decode) -> `PLAY_CONFIG_JSON`
- `package_name` -> app id, `track` / `artifact_upload_type` -> Play upload config.

Imported credentials are saved into the SAME store the normal flows write (per-app, per-platform),
so the rest of onboarding cannot tell the difference between migrated and natively-set-up creds.

## 5. Step-by-step flow

The migration owns steps 1-6; steps 7+ converge onto existing code.

**Step 0 - platform select + migration entry (SCOPE).** The migration is reachable THREE ways, each
setting a migration SCOPE (`both` | `ios` | `android`):
- Picker option `Both, I'm migrating from Ionic Appflow` (value `appflow`) -> scope `both`.
- Picker option `iOS` -> then ask "Are you migrating from Ionic Appflow?" (yes/no). YES -> appflow
  migration scoped to `ios`; NO -> normal native iOS onboarding.
- Picker option `Android` -> same "migrating from Appflow?" gate -> YES -> scope `android`; NO ->
  native Android onboarding.
This covers users who used Appflow on only ONE platform. The migration only fetches/processes/asks
about platforms in SCOPE; the other platform is ignored entirely (not fetched, not offered for build).
Effective platforms = SCOPE intersected with what Appflow actually has (`migratable`). Whole-migration
behaviors (build-first choice, second-platform prompt) apply only when scope is `both` AND both
platforms ended up with creds.
- Reuse/extend: `ui/platform-picker.tsx` (`PlatformPicker`, options L85-88; `platformKeyAction`),
  `types.ts` `Platform` (add `'appflow'`), engine `decidePlatform()` (add the "migrating from Appflow?"
  gate for ios/android + a `decideAppflow()` branch carrying scope).

**Step 1 - explain + support.** Explain that auth is secure and uses the SAME mechanism as the Ionic
CLI (browser-based OAuth/PKCE; nothing but the user's session token is read; token stays local).
Tell the user up front: if they hit ANY problem during migration they can email `support@capgo.app`.
- Reuse: explanation/aside rendering pattern; `SUPPORT_EMAIL` from `src/support/contact-support.ts`.

**Step 2 - authenticate.** Loopback PKCE login (new module, ported from Ionic CLI; do NOT depend on
`@ionic/cli`). Reuse a saved, non-expired token if present; refresh via `refresh_token`.

**Step 3 - select org.** GraphQL `BootstrapApp`. If exactly one org, auto-select (no prompt).

**Step 4 - select app.** GraphQL `OrganizationApps(slug)`. If exactly one app, auto-select.

**Step 5 - signing material (per platform).** List signing certs (`GetDataForPackageCerts`), split by
`credentials.ios` / `credentials.android`.
- **Auto-select rule (REQUIRED): if a platform has exactly one signing cert/profile, use it without
  asking.** Only prompt when there are 2+.
- Download the chosen cert(s) and map to Capgo keys (section 4).
- Missing signing material (per platform):
  - If a platform has NO signing material in Appflow, that platform CANNOT be migrated (there is
    nothing to import). State it plainly, e.g. "iOS cannot be migrated - no signing configuration
    exists for this app in Appflow", then show a recovery SUBMENU with these options:
    1. **"I believe credentials exist - email support"** -> reuse the EXISTING email-support feature
       (inform the user before uploading, exactly like today), uploading the support bundle. The
       bundle MUST include the internal logs, and the internal logs MUST contain the trace of the
       Appflow<->Capgo API calls (requests + responses for the cert/distribution-credential lookups,
       secrets redacted) so support can see why no signing config was found.
    2. **"I understand, do not migrate <platform>"** -> acknowledge and skip that platform (continue
       with the other platform if it is migratable).
    3. **"Abandon Appflow migration and start <ios|android> onboarding instead"** -> exit the
       migration and enter the normal native onboarding; inform the user they can come back to the
       Appflow migration later (progress/entry is preserved so re-entry is possible).
    4. **"Go back"** -> return to the previous step of this submenu / the prior choice.
  - Do NOT offer to generate or provide signing creds inside the migration. Generating from scratch
    is not a migration: it produces brand-new creds (and a freshly generated keystore would not even
    match the app's existing one), so wiring the native generate/provide flows in here would be
    pointless extra code. Generating fresh signing creds is what NORMAL ios/android onboarding is for.
  - If NEITHER platform has signing material, the migration has nothing to import: surface the same
    submenu framed for the whole migration (email support / abandon -> native onboarding, with
    "you can come back later" / go back). On a restart into native onboarding the platform picker NO
    LONGER shows the Appflow option (we already know there is nothing to migrate).

**Step 6 - store destination (distribution creds, per platform; OPTIONAL).** Missing distribution
creds do NOT block the migration.
- iOS: if Appflow has an `iTunes connect` cred, import the app-specific password (+ apple_app_id +
  team). If NOT, ask whether to set up an upload destination by generating/providing a `.p8` API key
  using the EXISTING p8 generate/provide behavior (`asc-key/helper.ts` + `ios/flow.ts` p8 steps).
- Android: if Appflow has a `google play` cred, import the service-account JSON. If NOT, ask whether
  to GENERATE/PROVIDE a service account using the EXISTING service-account flow
  (`android/` service-account generation + provide). 100% reuse; follow the existing prompts exactly.

**Step 7 - validation.** Validation is ADVISORY ONLY and MUST NEVER BLOCK. Every check REPORTS its
result to the user either way - a clear confirmation on success and a non-fatal warning on failure
(never silent, never a gate). The user can always continue the migration (and proceed to build)
regardless of any failed or inconclusive validation. Offer retry/skip where it helps, but there is no
hard gate. (Validations can also be skipped entirely, e.g. offline or rate limited - and that, too,
is surfaced, not silent.)
- Android service account: validate it can authenticate AND upload to the package -> REUSE
  `android/service-account-validation.ts validateServiceAccountJson()` / `probeAppAccess()` (Google
  Play Android Publisher API). (Confirmed: edits-based permission probe is the documented mechanism.)
  A failure -> warning only, never blocks.
- Android keystore: NOT remotely verifiable (Google exposes no readable "expected upload SHA"; the
  only remote check is an uncommitted AAB upload, out of scope). Verify LOCALLY only via
  `android/keystore.ts tryUnlockPrivateKey()` + `listKeystoreAliases()` (password + alias correct).
  A failure -> warning only, never blocks.
- iOS app-specific password: validate via a small new helper that POSTs `authenticateForSession` to
  `https://contentdelivery.itunes.apple.com/.../MZITunesSoftwareService` (User-Agent `iTMSTransporter`),
  `result.Success === true`. Caveats: validates the password (not app-level permission); subject to
  Apple rate limits. A non-success -> warning only, never blocks.
- iOS cert + provisioning profile: NOT verified remotely (do not attempt). Optional light local check
  only: confirm the `.p12` opens with `P12_PASSWORD` (no remote calls). A failure -> warning only.

**Step 8 - iOS only: offer app-specific-password -> .p8 upgrade.** If an app-specific password was
imported, ask whether to convert to an App Store Connect API key (`.p8`) and explain why (API keys
are the recommended, more capable, more secure upload auth; the app-specific password is a migration
fallback - this mirrors the "not recommended" messaging already shipped). If yes, reuse the existing
p8 select/generate method (step 6 fallback path). Skippable.

**Build + finish.** This is NOT a 100% merge into the normal onboarding code path. The migration is
its own flow that REUSES the tail's building blocks (the same components/functions), with
migration-specific differences (a skip-build option, the build-first-platform choice, the
second-platform prompt). What is genuinely shared is the credential model (same per-app/per-platform
Capgo credential store) and the same UI components, not a single common flow.
- Two independent "builds" are involved: the JS/web build (a project script that produces the web
  assets) and the NATIVE build (the Capgo cloud build of the iOS/Android app). They have separate
  opt-outs:
  - Native build: offer to BUILD now or SKIP entirely. The user MUST be able to skip building and
    finish the migration with credentials imported (build later via `build request`); skipping jumps
    straight to the CI/CD step.
  - JS/web build: when building natively, ask which script builds the app (reuse `pick-build-script`
    / package-manager detection) OR let the user SKIP the JS build and run the native build directly
    against the existing web assets (no JS rebuild).
- Run the native build and show the scrollable build-log view (reuse `runTailEffect 'requesting-build'`,
  `build-log.ts sanitizeBuildLogLines`, `FullscreenBuildOutput`).
- Ask which platform to build FIRST, but only when the migration produced credentials for BOTH
  platforms; otherwise build the single migrated platform.
- On build failure: offer AI diagnosis OR email support (reuse the `ai-analysis-*` and `support-*`
  steps + `handleSupport()`; `support@capgo.app`). Build failure is not fatal to the migration.
- After the first platform's build SUCCEEDS, if both platforms have creds, ask whether to build the
  second. If only one platform exists, follow the existing single-platform pattern
  (ask_build -> build -> ai/email on failure).
- End: ask about CI/CD setup (reuse `workflow-generator.ts` + the tail CI/CD steps:
  `ask-github-actions-setup`, `preview-workflow-file`, `view-workflow-diff`, `confirm-secrets-push`).

## 6. Architecture / where code lives

New (small, isolated):
- `cli/src/build/onboarding/appflow/auth.ts` - loopback PKCE login + token cache/refresh (ported,
  no `@ionic/cli` dependency).
- `cli/src/build/onboarding/appflow/api.ts` - the GraphQL + REST client (dashboard headers) with the
  operations from section 3 and the credential-download + mapping helpers from section 4. It RECORDS
  every Appflow request + response (method, URL, status, and response shape, with all secret values
  redacted) into the onboarding INTERNAL LOG, so the existing support bundle automatically carries
  the Appflow<->Capgo API trace (used by the Step-5 "I believe credentials exist - email support"
  path). Redaction is mandatory: tokens, app-specific passwords, cert/keystore bytes, and
  service-account JSON are never written to the log.
- `cli/src/build/onboarding/appflow/flow.ts` - `appflowViewForStep` / `applyAppflowInput` /
  `runAppflowEffect` implementing `PlatformFlow` (mirrors `ios/flow.ts` / `android/flow.ts`),
  covering steps 1-6 (explain, auth, org, app, signing fetch+map, distribution fetch+map) and the
  gap-fill hand-offs.
- `cli/src/build/onboarding/appflow/types.ts` - `AppflowOnboardingStep` union + progress shape.
- `cli/src/build/onboarding/ios/validate-app-password.ts` - the `authenticateForSession` helper
  (step 7 iOS). Small, also usable by the standalone `build request` path later.

Changed (minimal):
- `ui/platform-picker.tsx` + `types.ts` `Platform`: add the `appflow` option/value.
- `mcp/engine.ts` `drive()` / `decidePlatform()`: add `decideAppflow()` and route to it; on the
  "no signing material -> restart" case, suppress the appflow option.
- `flow/contract.ts` consumers / the flow registry: register `appflowFlow`.

Reused unchanged (per the codebase map):
- iOS p8 (for step 6 upload-destination gap-fill + step 8 conversion only; NOT for signing, which is
  migrated in step 5): `asc-key/helper.ts`, `ios/flow.ts` (p8 steps), `ios/progress.ts`.
- Android: `android/keystore.ts` reused for step-7 LOCAL keystore validation only
  (`tryUnlockPrivateKey`/`listKeystoreAliases`), NOT keystore generation; service-account validation
  + generation gap-fill via `android/service-account-validation.ts`, `android/oauth-google.ts`,
  `android/gcp-api.ts`.
- Tail: `tail/flow.ts` (build-script pick, build run, AI analysis, support, CI/CD),
  `build-log.ts`, `workflow-generator.ts`, `workflow-writer.ts`, `ui/app.tsx handleSupport()`.
- Progress/resume: `progress.ts` (`loadProgress`/`saveProgress`/`getResumeStep`) with an
  `appflow`-specific resume (`getAppflowResumeStep`).

Reuse contract (not a merge): after step 8 the appflow flow has written the same per-platform Capgo
credentials a native flow would, into the same credential store. The build/AI/support/CI-CD steps
then INVOKE the same tail components (functions/UI), driven by the appflow flow itself - it does not
hand control to the normal onboarding flow. Platform(s) to build = whatever was migrated (ios,
android, or both), and the user may skip building entirely.

## 7. Edge cases / rules

- Single-option auto-select: org, app, and (REQUIRED) signing cert/profile are auto-selected when
  exactly one exists; prompt only for 2+.
- No signing material anywhere -> inform + restart into native onboarding with Appflow hidden.
- One platform migratable, the other not -> migrate the available one; do not block on the other.
- Distribution creds optional (step 6); their absence is fine, with generate/provide offered.
- Build-first choice only asked when both platforms migrated; second-platform build offered only
  after the first succeeds and both exist.
- Token expiry mid-flow -> silent refresh via `refresh_token`; if refresh fails, re-auth (step 2).
- Secrets: imported material is written only to the local Capgo credential store (per existing
  security model: sent to the builder per-build, never persisted server-side). Never logged.

## 8. Testing

**Hard requirement: full e2e coverage in the private Cap-go/cli-mcp-tests harness via PR(s) there.**
This is NOT optional. The migration ships with NEW e2e journeys + tests added to
`Cap-go/cli-mcp-tests` (https://github.com/Cap-go/cli-mcp-tests/pulls), driven against RECORDED
Appflow API fixtures (no live Ionic calls in CI). We need MANY journeys, covering at least:

- Happy paths: iOS-only migration; Android-only migration; both-platforms migration; build now vs
  SKIP build; single-platform vs both-platform build-first choice; second-platform build after the
  first succeeds.
- Auto-select: exactly-one org / app / signing cert auto-selected with NO prompt; 2+ prompts.
- Missing signing material submenu: per-platform "cannot migrate" with all four options exercised
  (email support -> bundle includes the redacted Appflow API trace; skip-this-platform;
  abandon -> native onboarding with "come back later"; go back); the neither-platform variant.
- Step 6 gap-fill: missing iOS distribution -> p8 generate/provide; missing Android distribution ->
  service-account generate/provide; both-present import.
- Step 7 validation: pass (surfaced, not silent), fail (warning, NON-blocking, continue to build),
  skipped/offline (surfaced); for each of SA, keystore-local, app-specific-password, p12-local.
- Step 8: app-specific-password -> p8 conversion accepted and declined.
- Build failure -> AI vs email-support branches; build success -> CI/CD step.
- Auth: token reuse vs fresh login; mid-flow token refresh.
- Restart: "no signing material -> start over" hides the Appflow option on the re-shown picker.

Plus unit/contract tests in the CLI repo:
- Unit: credential mapping (data-URI stripping; `application_identifier` -> bundleId; provisioning
  map shape), auto-select-singleton rule, "no signing material" gating, token refresh, API-trace
  redaction (no secrets in the internal log).
- Validation hooks: service-account validation (reuse existing tests), keystore local unlock,
  app-specific-password `authenticateForSession` (mock the endpoint).
- Flow/contract: appflow step graph (resume, restart-hides-appflow, both-vs-one-platform, skip-build).
- Spike parity: the throwaway probe scripts (login/org/app/creds) already exercised the live API and
  validated decoded artifacts (.p12, keystore, service-account JSON) byte-for-byte; the production
  code must reproduce the same mapping (use those captures as fixtures).

## 9. Open questions

- Legal/stability of using `client_id=cli` against Ionic's OAuth server for the migration window
  (works today; flagged for product/legal awareness).
- Whether to also wire the migrated app-specific-password / p8 into the standalone `build request`
  path (already supported there) vs only through onboarding (this spec covers onboarding).
