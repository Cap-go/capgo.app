# Builder Init App Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choose and authorize the Capgo app for Builder inside `build init` before platform selection or resume.

**Architecture:** A UI-free service lists and verifies apps, a focused Ink gate renders the decision, and `OnboardingShell` owns the resolved app ID. `command.ts` supplies the native or Builder-configured suggestion and persists a verified override before platform progress loads.

**Tech Stack:** TypeScript, React, Ink 7, Bun CLI tests, Capgo HTTP API, Supabase permission RPC.

---

## File map

- `cli/src/build/onboarding/app-selection.ts`: suggestion, ranking, quiet app list, targeted read/build checks, Dashboard URL, config persistence.
- `cli/src/build/onboarding/ui/app-selection-gate.tsx`: full-screen loading, exact-match, no-match picker, full list, Dashboard recheck, and recovery.
- `cli/src/build/onboarding/ui/shell.tsx`: run the gate after login and pass its resolved ID to platform progress and child apps.
- `cli/src/build/onboarding/command.ts`: provide the suggestion and services; use the selected ID for support output and telemetry.
- `cli/src/build/onboarding/telemetry.ts`: best-effort app-selection event.
- `cli/test/test-builder-app-selection.mjs`: service and Ink state tests.
- `cli/test/test-builder-login-gate.mjs`: updated shell ordering assertions.
- `cli/test/test-onboarding-telemetry.mjs`: selection event and opt-out assertions.

### Task 1: App lookup and ranking

**Files:** Create `cli/src/build/onboarding/app-selection.ts`; test `cli/test/test-builder-app-selection.mjs`.

- [ ] **Step 1: Write failing tests** for the native/Builder override suggestion, exact match, zero/one/many visible apps, deterministic top-three order, paginated app fetch, and a failed page never being treated as empty.

```js
assert.equal(getAppSelectionSuggestion({ appId: 'com.example.native', plugins: { CapgoBuilder: { capgoBuilderAppId: 'com.example.cloud' } } }).appId, 'com.example.cloud')
assert.equal(getAppSelectionSuggestion({ appId: 'com.example.native', plugins: { CapacitorUpdater: { appId: 'com.example.ota' } } }).appId, 'com.example.native')
assert.deepEqual(rankVisibleApps(apps, 'com.example.weather').slice(0, 3).map(app => app.app_id), [
  'com.example.weather.dev', 'com.example.weather.beta', 'com.example.forecast',
])
```

- [ ] **Step 2: Run** `bun cli/test/test-builder-app-selection.mjs`; expect the missing exports to fail.
- [ ] **Step 3: Implement** the pure suggestion/ranking functions and a paginated `GET app?page=N` service using `invokeCapgoCliApi`, `supaHost`, and `supaAnon`. Return `[]` only for a successful empty page. Preserve errors for Ink to render. Do not call the Clack-based `listAppInternal`.
- [ ] **Step 4: Run** the new test and `bun run cli:build`; expect both to pass.
- [ ] **Step 5: Commit** the lookup service and its tests.

### Task 2: Quiet authorization and persistence

**Files:** Modify `cli/src/build/onboarding/app-selection.ts`; test `cli/test/test-builder-app-selection.mjs`.

- [ ] **Step 1: Add failing tests** for `GET app/:id` read denial, `app.build_native` denial, transient errors, pending app reuse, and persistence only when `getBuilderAppId()` would otherwise resolve a different ID.

```js
assert.equal(await verifyBuilderApp('com.example.weather', fakeServices), 'com.example.weather')
await assert.rejects(verifyBuilderApp('com.example.weather', deniedServices), /app.build_native/)
assert.equal(shouldSaveBuilderAppId('com.example.native', configWithUpdater), true)
```

- [ ] **Step 2: Run** the focused test; expect failed assertions.
- [ ] **Step 3: Implement** targeted read with `invokeCapgoCliApi`, a direct quiet `cli_check_permission` call scoped to `app_id`, and a config write through the existing Capacitor config writer. Classify read denial, build denial, missing app, and transport failure separately. Do not print through Clack while Ink is mounted. Preserve other config fields.
- [ ] **Step 4: Run** focused test, `bun run cli:build`, and `bun cli/test/test-builder-app-id-config.mjs`; expect passes.
- [ ] **Step 5: Commit** authorization and config persistence.

### Task 3: Full-screen gate

**Files:** Create `cli/src/build/onboarding/ui/app-selection-gate.tsx`; test `cli/test/test-builder-app-selection.mjs`.

- [ ] **Step 1: Write failing Ink tests** for exact match skipping the screen; the approved one-app and many-app copy; no full-list action with one app; top-three rows and full-list search with multiple apps; zero apps; browser-open failure URL; explicit Dashboard recheck; permission and network recovery; and 44×11 rendering.

```js
assert.match(frame, /Which Capgo app should Builder use\?/)
assert.match(frame, /No app with this ID is available to your API key/)
assert.doesNotMatch(singleAppFrame, /Select a different app/)
assert.match(manyAppsFrame, /Select a different app/)
```

- [ ] **Step 2: Run** the focused test; expect the missing component to fail.
- [ ] **Step 3: Implement** the gate with `Header`, `TerminalTooSmallPrompt`, Ink keyboard controls, and the service from Tasks 1–2. Use the approved singular/plural labels. A candidate row requires Enter; an exact match only needs successful verification. Open `/app/new` in the hosted Dashboard and show “I've created it — check again” before a re-fetch. Offer another-key recovery without exposing the key. If there are more than three visible apps, keep the top three on the first screen; the full-list action appears whenever more than one is visible.
- [ ] **Step 4: Run** the focused test and `bun run cli:build`; expect passes.
- [ ] **Step 5: Commit** the Ink gate and tests.

### Task 4: Integrate before platform and resume

**Files:** Modify `cli/src/build/onboarding/ui/shell.tsx`, `cli/src/build/onboarding/command.ts`, and `cli/test/test-builder-login-gate.mjs`.

- [ ] **Step 1: Write failing shell tests** that hold app verification unresolved and assert neither the platform picker nor `--platform` progress load appears; then resolve it and assert the chosen ID reaches the platform child. Cover switching keys and cancelling a switch.
- [ ] **Step 2: Run** shell tests; expect the platform to appear too early.
- [ ] **Step 3: Make `OnboardingShell` own `selectedAppId`**. Place the app gate after login and ahead of the platform picker. Gate the pre-resolved-platform effect on `selectedAppId`, and pass that ID to `loadReady`, iOS, Android, and Appflow. Let command-level callbacks receive the verified ID so the post-exit breadcrumb, support log, org resolution, and telemetry use it. Keep native bundle/package defaults from top-level `config.appId`.
- [ ] **Step 4: Run** `bun cli/test/test-builder-login-gate.mjs`, focused selection tests, and `bun run cli:build`; expect passes.
- [ ] **Step 5: Commit** shell integration.

### Task 5: Telemetry and complete verification

**Files:** Modify `cli/src/build/onboarding/telemetry.ts`, `cli/src/build/onboarding/command.ts`, `cli/test/test-onboarding-telemetry.mjs`, and focused tests.

- [ ] **Step 1: Write failing tests** for gate-shown and resolved events with `journey_id`, visible count, choice source, and classified failure; assert no key, app name, search text, or Dashboard URL appears in tags. Assert analytics opt-out prevents the event and quit has `last_step=app-selection`.
- [ ] **Step 2: Run** telemetry tests; expect missing event assertions to fail.
- [ ] **Step 3: Add best-effort telemetry** on the existing `builder-onboarding` channel. Record app-selection as the latest step before any decision and use the authenticated key. Failure to send must not block the UI.
- [ ] **Step 4: Run** `bun run cli:check` from the repository root; fix any lint, typecheck, build, or test failure introduced by this PR. Run the full relevant CLI suite and manually inspect the wide and narrow alternate-screen paths.
- [ ] **Step 5: Review** the merge-base diff for only intended CLI and test changes; ensure `graphify-out/` is absent and `codedb.snapshot` remains untouched; commit remaining fixes.

### Task 6: PR readiness

- [ ] **Step 1:** Push the branch and open a non-draft PR with a concise summary, test evidence, and the selection/creation split.
- [ ] **Step 2:** Follow the `ignore-graphify-when-creating-a-pr` skill and verify the remote PR changed-file list has no `graphify-out/` artifacts.
- [ ] **Step 3:** Follow the `pr-ready` skill through required CI, review, mergeability, and two stable-green observations at least five minutes apart.
