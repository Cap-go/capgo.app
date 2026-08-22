# CLI App Add Direct Create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx @capgo/cli@latest app add` create new apps without an authorization-breaking existence preflight.

**Architecture:** Keep existing-app lookups unchanged and modify only the app-add orchestration. Local validation rejects the reserved starter ID, while `POST /app` remains the single authoritative create and collision check.

**Tech Stack:** TypeScript, Bun, Capgo CLI, Node assertion-based CLI tests

---

## Task 1: Lock the direct-create contract with a failing regression test

**Files:**
- Modify: `cli/test/test-app-created-source.mjs`

- [ ] **Step 1: Add source-contract assertions**

Add `readFileSync` and inspect `cli/src/app/add.ts`:

```js
import { readFileSync } from 'node:fs'

const appAddSource = readFileSync(new URL('../src/app/add.ts', import.meta.url), 'utf8')

assert.doesNotMatch(appAddSource, /\bcheckAppExists\b/)
assert.doesNotMatch(appAddSource, /\bensureAppDoesNotExist\b/)
assert.match(appAddSource, /method:\s*'POST'/)
assert.match(appAddSource, /appId === 'io\.ionic\.starter'/)
assert.match(appAddSource, /upsert:\s*false/)
assert.equal(isStorageObjectConflict({ statusCode: '409' }), true)
assert.equal(isStorageObjectConflict({ statusCode: '500' }), false)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run --cwd cli test:app-created-source
```

Expected: FAIL because `cli/src/app/add.ts` still imports `checkAppExists` and calls `ensureAppDoesNotExist`.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add cli/test/test-app-created-source.mjs
git commit -m "test(cli): cover direct app creation flow"
```

## Task 2: Remove only the broken app-add preflight

**Files:**
- Modify: `cli/src/app/add.ts`

- [ ] **Step 1: Preserve reserved-ID validation locally**

Add this check to `ensureOptions` after the missing-app-ID guard:

```ts
if (appId === 'io.ionic.starter') {
  if (!silent)
    log.error(`This appId ${appId} cannot be used it's reserved, please change it in your capacitor config.`)
  throw new CliUserError('Reserved appId, please change it in capacitor config')
}
```

- [ ] **Step 2: Delete the create-only existence preflight**

Change the app API import to:

```ts
import { defaultAppIconPath, getAppIconStoragePath, newIconPath } from '../api/app'
```

Delete the complete `ensureAppDoesNotExist` function and delete this call from `addAppInternal`:

```ts
await ensureAppDoesNotExist(options.apikey!, appId, silent, { supaHost: options.supaHost, supaAnon: options.supaAnon })
```

Do not modify `cli/src/api/app.ts` or the backend app GET route.

Keep the icon upload create-only so a duplicate app-add attempt cannot mutate an existing app before `POST /app` returns `409`:

```ts
upsert: false,
```

Treat a Storage `409` as an existing deterministic icon object and reuse its path. This covers retries where the icon upload succeeded but the earlier app-create request did not, while `upsert: false` still prevents a duplicate app-add from changing the object:

```ts
if (error && !isStorageObjectConflict(error)) {
  // Keep the default icon for unrelated upload failures.
}
else {
  iconUrl = iconPath
}
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
bun run --cwd cli test:app-created-source
```

Expected: PASS, including direct-create and reserved-ID assertions.

- [ ] **Step 4: Commit the implementation**

```bash
git add cli/src/app/add.ts
git commit -m "fix(cli): create apps without existence preflight"
```

## Task 3: Verify the final CLI change

**Files:**
- Verify: `cli/src/app/add.ts`
- Verify: `cli/test/test-app-created-source.mjs`

- [ ] **Step 1: Run CLI lint before final validation**

```bash
bun run cli:lint
```

Expected: PASS with no lint errors.

- [ ] **Step 2: Run CLI typecheck**

```bash
bun run cli:typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Build the CLI**

```bash
bun run cli:build
```

Expected: PASS and produce the CLI distribution.

- [ ] **Step 4: Run the complete CLI test suite**

```bash
bun run cli:test
```

Expected: PASS for every CLI test command.

- [ ] **Step 5: Check the final diff and commit any plan tracking updates**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the unrelated pre-existing `codedb.snapshot` modification remains unstaged.

## Task 4: Open and stabilize the pull request

**Files:**
- No additional source files expected

- [ ] **Step 1: Push the feature branch and create the PR**

Create a PR from `wolny/fix-cli-app-add-preflight` to the repository default branch. Explain the failing GET authorization sequence, the direct POST flow, and local verification. Do not stage or commit `codedb.snapshot`.

- [ ] **Step 2: Apply the PR-ready workflow**

Confirm the PR is open and ready for review, wait for all required checks, verify reviews and unresolved threads, and verify mergeability.

- [ ] **Step 3: Record stable-green observations**

Record observation A only after all local and remote gates are green. Wait at least 300 seconds without relevant PR state changes, fetch fresh remote state, and record observation B for unchanged head and base SHAs.
