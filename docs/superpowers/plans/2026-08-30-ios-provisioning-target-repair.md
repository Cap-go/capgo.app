# iOS Provisioning Target Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `build credentials ios-provisioning` and fatal prescans that safely repair missing per-target iOS provisioning map entries, including confirmed wildcard reuse and dedicated App Store profile generation.

**Architecture:** Extract the existing local/global credential-store decision into a shared resolver, then add a pure provisioning-map analyzer used by both the command and prescan. Keep the command orchestration injectable so tests can cover wildcard reuse, Apple API validation, duplicate replacement, and resumable writes without network access. The existing onboarding Apple API and certificate/profile parsers remain the source of truth for Apple operations and profile metadata.

**Tech Stack:** TypeScript, Commander, Capacitor config, `@clack/prompts`, Bun, Node test scripts, Vitest, existing Capgo credential storage and Apple API helpers.

---

## File map

New production files:

- `cli/src/build/credentials-store-selection.ts` — shared local/global store selection used by export and provisioning setup.
- `cli/src/build/ios-provisioning-map.ts` — parsing, canonicalization, exact coverage, wildcard matching, and conflict analysis.
- `cli/src/build/ios-provisioning-command.ts` — project discovery, prompts, wildcard repair, Apple credential validation, generation, replacement, and persistence.

Modified production files:

- `cli/src/build/credentials-export-command.ts` — delegate store selection without changing export behavior.
- `cli/src/build/prescan/checks/ios-profiles.ts` — use exact coverage and add wildcard-specific fatal check.
- `cli/src/build/prescan/registry.ts` — register the new wildcard check.
- `cli/src/index.ts` — register `build credentials ios-provisioning` and public help text.

Test files:

- `cli/test/test-credentials-export.mjs` — regression tests for extracted store selection.
- `cli/test/test-ios-provisioning-map.mjs` — pure parser and coverage matrix.
- `cli/test/prescan/checks-ios-profiles.test.ts` — exact-target and wildcard prescan behavior.
- `cli/test/test-ios-provisioning-command.mjs` — command flow with injected project, storage, prompt, and Apple dependencies.
- `cli/package.json` — include new standalone tests in the CLI test suite if the existing glob/script does not already discover them.

## Task 1: Share credential-store selection

**Files:**

- Create: `cli/src/build/credentials-store-selection.ts`
- Modify: `cli/src/build/credentials-export-command.ts`
- Test: `cli/test/test-credentials-export.mjs`

- [ ] Add failing export tests proving that automatic mode selects the sole configured store, rejects split local/global credentials, and an explicit `--local` or `--global` never falls back to the other store.

- [ ] Run the focused test and confirm the new cases fail for the intended reason:

```bash
bun run --cwd cli test:credentials-export
```

- [ ] Add a shared resolver with this public contract:

```ts
import type { SavedCredentials } from './credentials'

export type CredentialsStoreName = 'local' | 'global'

export interface CredentialsStoreOptions {
  appId?: string
  local?: boolean
  global?: boolean
}

export type CredentialsStores = Record<CredentialsStoreName, SavedCredentials | null>

export interface ResolvedCredentialsStore {
  source: CredentialsStoreName
  saved: SavedCredentials
}

export function hasConfiguredCredentials(saved: SavedCredentials | null): boolean

export function resolveCredentialsStore(
  options: CredentialsStoreOptions,
  stores: CredentialsStores,
): ResolvedCredentialsStore
```

The resolver must preserve the current export errors and semantics: reject both selectors, reject an explicitly selected empty store, auto-select one configured store, and require a selector when both are configured.

- [ ] Refactor `resolveCredentialsExport` to call `resolveCredentialsStore`, retaining the existing platform and variable validation after source resolution.

- [ ] Re-run the focused test and ensure all existing and new cases pass.

- [ ] Commit the isolated refactor:

```bash
git add cli/src/build/credentials-store-selection.ts cli/src/build/credentials-export-command.ts cli/test/test-credentials-export.mjs
git commit -m "refactor(cli): share credential store selection"
```

## Task 2: Build the pure provisioning-map analyzer

**Files:**

- Create: `cli/src/build/ios-provisioning-map.ts`
- Create: `cli/test/test-ios-provisioning-map.mjs`

- [ ] Write failing tests for all analyzer invariants:

  - absent, empty, malformed, and invalid map values are distinguishable errors;
  - legacy string values and `{ profile, name }` values canonicalize to `{ profile, name }`;
  - target coverage is exact-key only, even if another profile payload happens to match;
  - duplicate target bundle identifiers are grouped while retaining target names;
  - unresolved build-setting bundle IDs are returned separately and are never generated;
  - `*` and prefix wildcards cover only eligible missing bundle IDs;
  - identical wildcard profile bytes under multiple keys count as one profile;
  - different matching wildcard profile bytes create an unsupported conflict;
  - a wildcard entry does not hide a target that already has an exact key.

- [ ] Add the analyzer types and functions:

```ts
import type { MobileprovisionDetail } from './mobileprovision-parser'
import type { PbxTarget } from './pbxproj-parser'

export interface ProvisioningMapEntry {
  profile: string
  name: string
}

export type ProvisioningMap = Record<string, ProvisioningMapEntry>

export interface ProvisioningTargetGroup {
  bundleId: string
  targetNames: string[]
}

export interface WildcardReuse {
  entry: ProvisioningMapEntry
  sourceKeys: string[]
  targets: ProvisioningTargetGroup[]
}

export interface ProvisioningCoverage {
  exact: ProvisioningTargetGroup[]
  missing: ProvisioningTargetGroup[]
  unresolved: PbxTarget[]
  wildcardReuse: WildcardReuse | null
  wildcardConflict: ProvisioningTargetGroup[]
  generation: ProvisioningTargetGroup[]
}

export function parseProvisioningMap(raw: string): ProvisioningMap

export function analyzeProvisioningCoverage(
  targets: PbxTarget[],
  map: ProvisioningMap,
): ProvisioningCoverage
```

Parsing must call `parseMobileprovisionDetailedFromBase64` for authoritative profile names and application identifiers. Wildcard matching must use the embedded application identifier stripped of its team prefix, never the map key. Treat only `*` and identifiers ending in `.*` as wildcards.

- [ ] Run the analyzer test directly until green:

```bash
bun cli/test/test-ios-provisioning-map.mjs
```

- [ ] Run CLI typecheck to catch public type mismatches:

```bash
bun run --cwd cli typecheck
```

- [ ] Commit the analyzer and tests:

```bash
git add cli/src/build/ios-provisioning-map.ts cli/test/test-ios-provisioning-map.mjs
git commit -m "feat(cli): analyze iOS provisioning target coverage"
```

## Task 3: Tighten iOS provisioning prescans

**Files:**

- Modify: `cli/src/build/prescan/checks/ios-profiles.ts`
- Modify: `cli/src/build/prescan/registry.ts`
- Modify: `cli/test/prescan/checks-ios-profiles.test.ts`

- [ ] Add failing prescan tests for:

  - a present empty, malformed, or invalid map producing a fatal generic save/update error;
  - two targets with only one exact entry producing a fatal recommendation for `npx @capgo/cli@latest build credentials ios-provisioning`;
  - a single missing target retaining the generic manual repair message;
  - one matching wildcard producing only `ios/wildcard-profile-targets`, listing the missing targets and recommending the command;
  - multiple different matching wildcard profiles producing the unsupported/manual-cleanup error;
  - identical wildcard bytes under multiple keys not producing a conflict;
  - exact-complete maps and nonmatching wildcard profiles producing no wildcard finding.

- [ ] Run the focused prescan test and confirm the assertions fail:

```bash
bun test cli/test/prescan/checks-ios-profiles.test.ts
```

- [ ] Replace the local loose map parser and wildcard-as-coverage logic with `parseProvisioningMap` and `analyzeProvisioningCoverage`.

- [ ] Keep `ios/targets-covered` as the existing check ID, but exclude targets owned by the wildcard-specific check. Its multi-target failure must include:

```text
npx @capgo/cli@latest build credentials ios-provisioning
```

- [ ] Export a new fatal check named `ios/wildcard-profile-targets`. It must report one reusable wildcard or the exact unsupported conflict message, without prompting or mutating state.

- [ ] Register the new check beside `targetsCovered` in `ALL_CHECKS`.

- [ ] Run the full prescan suite:

```bash
bun run --cwd cli test:prescan
```

- [ ] Commit the prescan behavior:

```bash
git add cli/src/build/prescan/checks/ios-profiles.ts cli/src/build/prescan/registry.ts cli/test/prescan/checks-ios-profiles.test.ts
git commit -m "feat(cli): detect missing iOS target profiles"
```

## Task 4: Implement project and credential validation for the command

**Files:**

- Create: `cli/src/build/ios-provisioning-command.ts`
- Create: `cli/test/test-ios-provisioning-command.mjs`

- [ ] Start command tests with an injectable boundary:

```ts
export interface IosProvisioningOptions {
  local?: boolean
  global?: boolean
}

export interface IosProvisioningProject {
  appId: string
  targets: PbxTarget[]
}

export interface IosProvisioningCommandDeps {
  loadProject: () => Promise<IosProvisioningProject>
  loadStores: (appId: string, options: IosProvisioningOptions) => Promise<CredentialsStores>
  persistMap: (
    appId: string,
    source: CredentialsStoreName,
    map: ProvisioningMap,
  ) => Promise<void>
  canPrompt: () => boolean
  confirm: (message: string) => Promise<boolean>
  logInfo: (message: string) => void
  generateJwt: typeof generateJwt
  verifyApiKey: typeof verifyApiKey
  findCertBySha1: typeof findCertBySha1
  ensureBundleId: typeof ensureBundleId
  createProfile: typeof createProfile
  deleteProfile: typeof deleteProfile
}

export async function runIosProvisioningCommand(
  options: IosProvisioningOptions,
  deps: IosProvisioningCommandDeps,
): Promise<void>
```

- [ ] Add failing tests for validation-only paths:

  - no Capacitor config, no configured iOS platform, no Xcode project, no signable targets, and unresolved target bundle IDs fail before credential reads or Apple calls;
  - the saved credential lookup always uses the Capacitor app ID;
  - source selection exactly follows the shared export resolver;
  - no iOS credentials, absent map, empty map, malformed map, or invalid map fail without bootstrapping;
  - an exact-complete map succeeds without prompts, `.p8`, or Apple API calls;
  - `ad_hoc` credentials fail as unsupported;
  - app-specific password fields are ignored when a complete `.p8` exists.

- [ ] Implement default project loading with `getConfig(true)`, `getAppId(undefined, config)`, `getPlatformDirFromCapacitorConfig(config, 'ios')`, `findXcodeProject`, `readPbxproj`, and `findSignableTargets`.

- [ ] Load only the explicitly requested store when a selector is supplied; otherwise load both and pass them through `resolveCredentialsStore`. Read errors must be fatal and there must be no cross-store fallback.

- [ ] Parse `CAPGO_IOS_PROVISIONING_MAP` strictly, reject `BUILD_MODE === 'ad_hoc'`, and return success immediately when exact coverage is complete.

- [ ] Run the focused command test until validation paths pass:

```bash
bun cli/test/test-ios-provisioning-command.mjs
```

## Task 5: Implement confirmed wildcard repair

**Files:**

- Modify: `cli/src/build/ios-provisioning-command.ts`
- Modify: `cli/test/test-ios-provisioning-command.mjs`

- [ ] Add failing tests for wildcard behavior:

  - one wildcard covering missing targets asks once with the target list;
  - noninteractive mode fails with an actionable rerun message;
  - acceptance writes exact target keys using the same profile bytes and canonical name in one persisted map update;
  - wildcard-only completion succeeds without `.p8` or Apple calls;
  - declining wildcard reuse leaves those targets in the dedicated-generation list;
  - multiple different matching wildcard profiles fail with `Sorry, multiple matching wildcard provisioning profiles are not supported` before any prompt or mutation.

- [ ] Implement a reusable confirmation guard that checks `canPrompt()` before invoking `confirm()`, treats cancellation as rejection, and throws an actionable error rather than silently defaulting.

- [ ] On acceptance, copy the wildcard entry into every covered target’s exact bundle-ID key and call `persistMap` once. Re-run coverage analysis after the write so only genuinely missing targets continue.

- [ ] Re-run the focused test until wildcard cases pass.

- [ ] Commit the validation and wildcard command slice:

```bash
git add cli/src/build/ios-provisioning-command.ts cli/test/test-ios-provisioning-command.mjs
git commit -m "feat(cli): repair iOS provisioning maps"
```

## Task 6: Implement App Store profile generation and replacement

**Files:**

- Modify: `cli/src/build/ios-provisioning-command.ts`
- Modify: `cli/test/test-ios-provisioning-command.mjs`

- [ ] Add failing tests for generation and mutation ordering:

  - missing targets require `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, base64 `APPLE_KEY_CONTENT`, and `BUILD_CERTIFICATE_BASE64`;
  - absent/incomplete `.p8` fails with an explicit statement that app-specific passwords are unsupported;
  - invalid base64/PEM/JWT or `verifyApiKey` access failure occurs before the generation confirmation;
  - passwordless P12 opening uses `P12_PASSWORD ?? ''`;
  - certificate lookup by SHA-1 and access verification occur before any bundle/profile mutation;
  - the user confirms once for the remaining target list, and declining exits nonzero without Apple mutations;
  - targets generate sequentially through fresh JWTs, `ensureBundleId`, and `createProfile`;
  - every successful generated profile is persisted immediately under its exact bundle-ID key;
  - a later failure leaves earlier persisted entries intact for a safe rerun;
  - `DuplicateProfileError` prompts with the target/profile list, deletes only the returned duplicate IDs, and retries creation once;
  - duplicate replacement decline, noninteractive mode, deletion failure, and retry failure all stop with precise errors;
  - generic Apple failures never trigger duplicate deletion;
  - logs and thrown errors never include raw private keys, certificates, profile bytes, or passwords.

- [ ] Add a credential-preparation helper that decodes the base64 private key, calls `generateJwt`, verifies API access, opens the P12 with `openP12`, and resolves the distribution certificate with `findCertBySha1` before the generation prompt.

- [ ] Mint a fresh JWT for every Apple request. Generate each target in order:

```ts
const bundleResource = await deps.ensureBundleId(freshToken(), target.bundleId)
const profile = await deps.createProfile(
  freshToken(),
  bundleResource.id,
  distributionCertificate.id,
  appId,
)
```

- [ ] Catch only `DuplicateProfileError` for replacement. After confirmation, delete the error’s returned Capgo-managed profiles, retry once, and do not recursively replace a second duplicate response.

- [ ] Canonicalize the returned profile as `{ profile: profile.profileContent, name: profile.name }`, persist immediately, and continue to the next target.

- [ ] Re-run the focused command test and CLI typecheck:

```bash
bun cli/test/test-ios-provisioning-command.mjs
bun run --cwd cli typecheck
```

- [ ] Commit generation support:

```bash
git add cli/src/build/ios-provisioning-command.ts cli/test/test-ios-provisioning-command.mjs
git commit -m "feat(cli): generate missing iOS target profiles"
```

## Task 7: Register the public command

**Files:**

- Modify: `cli/src/index.ts`
- Modify: `cli/package.json` if needed
- Modify: `cli/test/test-ios-provisioning-command.mjs`

- [ ] Add a failing source/help assertion that the subcommand is registered under `build credentials` as lowercase kebab-case `ios-provisioning`, exposes only `--local` and `--global`, and uses the public `npx @capgo/cli@latest` form in help/examples.

- [ ] Export a thin `iosProvisioningCommand` wrapper that supplies real dependencies, reports a concise error through the existing logger, and exits nonzero without leaking secrets.

- [ ] Register the command:

```ts
buildCredentials
  .command('ios-provisioning')
  .description('Set up provisioning profiles for every iOS target')
  .option('--local', 'Use credentials from the current project')
  .option('--global', 'Use credentials from the global store')
  .action(iosProvisioningCommand)
```

- [ ] Ensure the new standalone tests are included by `bun run cli:test`; update `cli/package.json` only if the current test command enumerates files explicitly.

- [ ] Build the CLI and inspect the command help:

```bash
bun run --cwd cli build
bun cli/dist/index.js build credentials ios-provisioning --help
```

- [ ] Commit registration:

```bash
git add cli/src/index.ts cli/package.json cli/test/test-ios-provisioning-command.mjs
git commit -m "feat(cli): add iOS provisioning setup command"
```

## Task 8: Quality gate, line budget, and PR preparation

**Files:**

- Review all changed files
- Do not stage `codedb.snapshot`

- [ ] Run formatting/lint first, as required by the repository:

```bash
bun run --cwd cli lint
```

- [ ] Run focused tests, typecheck, build, then the full CLI check:

```bash
bun run --cwd cli test:credentials-export
bun run --cwd cli test:prescan
bun cli/test/test-ios-provisioning-map.mjs
bun cli/test/test-ios-provisioning-command.mjs
bun run --cwd cli typecheck
bun run --cwd cli build
bun run cli:check
```

- [ ] Measure added production lines under `cli/src` and verify the net/new feature implementation is at most 1,100 lines, excluding tests and specification/plan files:

```bash
git diff --numstat HEAD~5 -- cli/src
wc -l cli/src/build/credentials-store-selection.ts cli/src/build/ios-provisioning-map.ts cli/src/build/ios-provisioning-command.ts
```

- [ ] Review the final diff for exact design coverage, secret-safe errors, unsupported `ad_hoc`, no app-specific password fallback, no `--yes`, exact-key persistence, and no unrelated files.

- [ ] Invoke the `pr-ready` skill and resolve every issue until it reports stable green.

- [ ] Push the `wolny/ios-provisioning-target-repair` branch and create a PR with a conventional, non-`[CODEX]` title. Include behavior, test evidence, and the production line-count result in the PR body.

