# Builder Init Login Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a verified Capgo API key inside the full-screen Builder wizard before platform selection or saved-progress loading.

**Architecture:** Add a small auth service around the existing OTA browser-login and key-validation helpers. A new Builder Ink login component owns the card choice and masked field; `OnboardingShell` owns the validated key and passes it to every platform child. The command records the successful login and uses that same key for exit handling.

**Tech Stack:** TypeScript, React 19, Ink 7, Bun CLI tests, existing Capgo auth and analytics helpers.

---

## File map

| File | Responsibility |
| --- | --- |
| `cli/src/init/browser-login.ts` | Extract UI-free browser-session start/completion operations; keep `loginInitInBrowser` behavior and signature intact for OTA. |
| `cli/src/build/onboarding/login.ts` (new) | Resolve candidate key and create injectable validation/save/browser services using the selected Capgo host. |
| `cli/src/build/onboarding/ui/login-gate.tsx` (new) | Builder-only card chooser, browser URL, bounded masked input, retry/error states. |
| `cli/src/build/onboarding/ui/components.tsx` | Bound the visual width of masked `FilteredTextInput` without truncating its submitted value. |
| `cli/src/build/onboarding/ui/shell.tsx` | Order update prompt → auth gate → platform/resume, then pass the validated key to child flows. |
| `cli/src/build/onboarding/command.ts` | Supply auth services/candidate, keep the validated key for quit telemetry, emit the post-auth login event. |
| `cli/src/index.ts` | Defer direct `build init`/alias invocation analytics until the gate validates a key. `-a, --apikey` already exists. |
| `cli/test/init/browser-login.test.ts` | Preserve OTA browser behavior after extraction. |
| `cli/test/test-builder-login-gate.mjs` (new) | Exercise login UI, key flow, ordering, narrow layout, and telemetry without live Capgo calls. |
| `cli/test/test-authenticated-command-invocation.mjs`, `cli/test/test-shell-size-gate.mjs`, `cli/test/test-update-prompt.mjs`, `cli/package.json` | Update existing contracts and register the new CLI test. |

The spec is `docs/superpowers/specs/2026-09-21-builder-init-login-gate-design.md`.

## Task 1: Share browser-login mechanics without changing OTA

**Files:** `cli/src/init/browser-login.ts`, `cli/test/init/browser-login.test.ts`

- [ ] **Step 1: Add failing tests** for a started browser session returning a stable `session`/`url`, fallback when `openUrl` rejects, and completion that validates/saves before sending the existing per-org `User CLI login` notifications. Keep the current `loginInitInBrowser` tests.
- [ ] **Step 2: Run** `bun test cli/test/init/browser-login.test.ts` and confirm the new tests fail because the new exports do not exist.
- [ ] **Step 3: Extract** two UI-free operations from the current function. Preserve its injectable dependency names so the existing tests and OTA call sites still work. The intended API is:

  ```ts
  interface BrowserLoginSession {
    session: string
    url: string
    browserOpened: boolean
  }

  async function beginBrowserLogin(
    onUrl: (url: string) => void,
    overrides: Partial<BrowserLoginDependencies> = {},
  ): Promise<BrowserLoginSession>

  async function completeBrowserLogin(
    browserSession: BrowserLoginSession,
    key: string,
    options: BrowserLoginOptions,
    overrides: Partial<BrowserLoginDependencies> = {},
  ): Promise<void>
  ```

  `beginBrowserLogin` creates the same random session and `/login-cli?session=...` URL, calls `onUrl` before attempting `openUrl`, and returns `browserOpened: false` if opening fails. `completeBrowserLogin` calls the existing `validateAndSaveKey` path, then performs the current best-effort organization lookup and per-org notification. `loginInitInBrowser` composes these functions with its existing `promptForKey`, cancellation error, and `writeUrl` wording. Do not add Clack calls to the extracted operations.
- [ ] **Step 4: Run** `bun test cli/test/init/browser-login.test.ts`; expect the old and new cases to pass. Commit this focused refactor with `refactor(cli): share browser login session mechanics`.

## Task 2: Resolve and verify Builder's candidate key

**Files:** `cli/src/build/onboarding/login.ts` (new), `cli/test/test-builder-login-gate.mjs` (new)

- [ ] **Step 1: Test** the exact precedence `--apikey` → `CAPGO_TOKEN` → `~/.capgo` → `./.capgo` through `findSavedKeySilent()`. A whitespace-only flag must fall through. Test a valid candidate, a rejected candidate, and a network failure with injected services. Assert that candidate validation does not write a key file.
- [ ] **Step 2: Run** `bun cli/test/test-builder-login-gate.mjs`; expect the new module import or assertions to fail.
- [ ] **Step 3: Add** `resolveBuilderCandidateKey(explicitKey?: string)` and `createBuilderLoginServices({ supaHost?, supaAnon? })` to `login.ts`. Use the existing quiet identity call for candidate verification and `validateAndSaveKey` for interactively pasted keys:

  ```ts
  export function resolveBuilderCandidateKey(explicitKey?: string): string | undefined {
    return explicitKey?.trim() || findSavedKeySilent()
  }

  export interface BuilderLoginServices {
    browserAvailable: boolean
    validateExisting: (key: string) => Promise<void>
    savePasted: (key: string) => Promise<void>
    beginBrowser: (onUrl: (url: string) => void) => Promise<BrowserLoginSession>
    completeBrowser: (session: BrowserLoginSession, key: string) => Promise<void>
  }
  ```

  `validateExisting` must call `createSupabaseClient(key, supaHost, supaAnon, true)` and `resolveUserIdFromApiKey(client, key, true)`. `savePasted` and `completeBrowser` use `{ local: false, supaHost, supaAnon }`. Neither candidate validation nor a failed interactive submission writes the key. Set `browserAvailable` only when neither custom-host flag is set; the UI then goes straight to paste on a custom host.
- [ ] **Step 4: Run** the new focused test and `bun run cli:typecheck`. Commit with `feat(cli): add builder login services`.

## Task 3: Build the full-screen login view

**Files:** `cli/src/build/onboarding/ui/login-gate.tsx` (new), `cli/src/build/onboarding/ui/components.tsx`, `cli/test/test-builder-login-gate.mjs`

- [ ] **Step 1: Add a controlled-Ink test** that renders the real component with fake `BuilderLoginServices`. Verify the two short cards, browser URL, masked bordered field, invalid-key retry without a second browser opening, browser-open failure fallback, Escape cancellation, and that no frame contains the test key. Feed a long fake key and assert the border still fits at 44 columns while the service receives the whole value.
- [ ] **Step 2: Run** `bun cli/test/test-builder-login-gate.mjs`; expect the UI cases to fail.
- [ ] **Step 3: Extend** `FilteredTextInput` with optional `maxMaskWidth` (default unchanged). When `mask` is true, render no more than that many bullets; submit the untruncated state. The Builder field passes `filter=""`, `mask`, and `maxMaskWidth={24}`. Trim only on submission and reject empty input. Do not use a UUID-only input filter.
- [ ] **Step 4: Implement** `BuilderLoginGate` as a body component under the existing `Header`. Use `CardChooser` with `pickPlatformLayout(cols, rows)` and exactly these options:

  ```ts
  [
    { value: 'browser', emoji: '🌎', name: 'Open browser', hint: 'Create key in Dashboard' },
    { value: 'paste', emoji: '📋', name: 'Paste API key', hint: 'Use an existing key' },
  ]
  ```

  Show `Paste the API key from the Capgo Dashboard` above the bordered field. On a hosted Capgo run, browser selection calls `beginBrowser` once and keeps its URL/session in component state. A failed submit stays on the same field; another submit calls `completeBrowser` with the same session. On custom hosts, go straight to the paste field. A failed existing-key check offers retry or another key. Display a short generic validation error inside Ink; never print raw API errors or the key. Keep a cancellation flag so an async result cannot advance after Escape.
- [ ] **Step 5: Run** the focused test at card and list dimensions, plus `bun run cli:typecheck`. Commit with `feat(cli): add fullscreen builder login view`.

## Task 4: Gate platform and resume on verified authentication

**Files:** `cli/src/build/onboarding/ui/shell.tsx`, `cli/src/build/onboarding/command.ts`, `cli/test/test-builder-login-gate.mjs`, `cli/test/test-shell-size-gate.mjs`, `cli/test/test-update-prompt.mjs`

- [ ] **Step 1: Add shell tests** proving update prompt remains first, then login, then platform picker; `--platform ios` and a single native folder cannot call `loadProgress` before login; the iOS, Android, and Appflow children receive the validated key; and cancelling login does not mount a child. Use fake services instead of Capgo network calls. Update the existing shell-size/update tests to pass a fake valid candidate and wait for the auth transition before asserting the picker.
- [ ] **Step 2: Run** the focused test, `bun cli/test/test-shell-size-gate.mjs`, and `bun cli/test/test-update-prompt.mjs`; confirm the new ordering assertions fail on the current shell.
- [ ] **Step 3: Give** `OnboardingShell` the resolved candidate and `BuilderLoginServices`. Keep `authenticatedKey` in state, initially unset. Render the login gate after the update prompt and picker-size guard, before the migration gate and platform picker. The pre-resolved-platform effect must have this condition:

  ```ts
  if (authenticatedKey && initialPlatform && (!updateInfo || updateAnswered))
    choose(initialPlatform)
  ```

  Use `authenticatedKey` instead of the original `apikey` prop for all three child apps. On success, notify the command with `(key, { method?, retryCount, durationMs })`; on Escape, set cancelled result and invoke the existing before-exit/Ink exit path. The same current Ink instance remains mounted throughout.
- [ ] **Step 4: In** `command.ts`, resolve the candidate after Capacitor config/project discovery, construct services with the same `supaHost`/`supaAnon`, and keep an `authenticatedApiKey` variable updated by the shell callback. Use that variable for the post-exit quit event. Do not call any auth helper that prints Clack errors while Ink is mounted. Keep explicit `-a` validation read-only; interactive keys are saved by the service.
- [ ] **Step 5: Run** all three focused tests and `bun run cli:typecheck`. Commit with `feat(cli): verify builder login before platform setup`.

## Task 5: Send post-auth Builder login telemetry

**Files:** `cli/src/build/onboarding/command.ts`, `cli/src/index.ts`, `cli/test/test-builder-login-gate.mjs`, `cli/test/test-authenticated-command-invocation.mjs`, `cli/package.json`

- [ ] **Step 1: Add tests** for one `Builder Onboarding Login` event after an interactive key validates, no login event for a valid pre-existing key, no event before validation or when login is cancelled, and no events with `--no-analytics`. Check `journey_id`, method, retry count, duration, no platform/org requirement, and absence of the key and browser URL from event JSON. Test that direct `build init` invocation is deferred until the validated key is known.
- [ ] **Step 2: Run** `bun cli/test/test-builder-login-gate.mjs` and `bun cli/test/test-authenticated-command-invocation.mjs`; confirm the new assertions fail.
- [ ] **Step 3: Extend** the existing pre-action deferral condition in `index.ts` to include `build init` and `build onboarding`. Once the shell reports a validated key, call `flushDeferredCommandInvocation(key)`. Emit a single best-effort generic event for a shown login screen:

  ```ts
  void trackEvent({
    apikey: key,
    channel: 'builder-onboarding',
    event: 'Builder Onboarding Login',
    tags: {
      journey_id: journeyId,
      method: metadata.method,
      retry_count: metadata.retryCount,
      duration_ms: metadata.durationMs,
    },
  })
  ```

  Only call this branch when `metadata.method` is `browser` or `paste`. `trackEvent` already respects telemetry opt-out and tracks in-flight requests for final flush. Never send the key or URL in tags. Keep the existing pre-auth launch-count gap and current replay behavior.
- [ ] **Step 4: Register** `test:builder-login-gate` in `cli/package.json` and include it in the CLI `test` script. Run the focused tests and `bun run cli:check`; expect green. Commit with `feat(cli): track builder login after authentication`.

## Task 6: Review the terminal flow and PR

- [ ] **Step 1: In a local Capacitor fixture**, run the PR build with `bun cli/dist/index.js build init` from a real TTY and inspect the browser and paste branches. Check 44-column list mode and a normal-width card mode, including paste, invalid key, Escape, and browser failure. Use fake/test keys in recorded notes; never commit a real key.
- [ ] **Step 2: Check** `git diff --check`, `git status --short`, the focused tests, and `bun run cli:check`. Leave the pre-existing `codedb.snapshot` modification untouched.
- [ ] **Step 3: Before any PR handoff**, invoke the repository's `pr-ready` skill and reach stable green. Keep the PR description focused on identity login and the accepted telemetry gap; place app access and `capgoBuilderAppId` in follow-up work.

## Acceptance criteria

- The login choice or key verification appears before any visible platform selection or progress/resume screen, including with `--platform`.
- A validated saved, environment, or explicit key skips the choice; an interactively entered valid key is saved through the shared auth core and passed to the selected Builder child.
- Browser login keeps OTA's session URL and dashboard-notification behavior. The Builder UI stays in one full-screen Ink instance.
- Failed identity checks and browser-open errors are shown inside Ink. No key text is rendered, logged, replayed, or sent as a telemetry property.
- A successful interactive login produces one Builder login event after validation. Signed-out exits before validation remain unobservable through authenticated telemetry.
- Existing OTA browser login and Builder onboarding checks pass.
