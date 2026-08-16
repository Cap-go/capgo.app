# Authenticated CLI Invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `login` and `init` emit exactly one correctly attributed `CLI Command Invoked` event after Capgo API-key validation and support the standard `-a, --apikey` flag.

**Architecture:** Commander defers invocation telemetry for the two authentication-establishing commands while preserving their timer and privacy-safe context. The command actions flush that deferred record with the validated key; pure input helpers normalize flag and legacy positional forms.

**Tech Stack:** TypeScript, Commander, Bun, Node assertion-based CLI tests.

---

## Task 1: Lock command-input behavior with failing tests

**Files:**
- Create: `cli/src/auth/command-input.ts`
- Create: `cli/test/test-authenticated-command-invocation.mjs`
- Modify: `cli/package.json`

- [ ] **Step 1: Add failing tests for input resolution**

Test the wished-for exports before creating them:

```js
import { resolveInitCommandInput, resolveLoginCommandApiKey } from '../src/auth/command-input.ts'

assert.equal(resolveLoginCommandApiKey('positional', 'flag'), 'flag')
assert.equal(resolveLoginCommandApiKey('positional', undefined), 'positional')
assert.deepEqual(resolveInitCommandInput('legacy-key', 'com.app', undefined), {
  apikey: 'legacy-key',
  appId: 'com.app',
  explicitApiKey: true,
})
assert.deepEqual(resolveInitCommandInput('com.app', undefined, 'flag-key'), {
  apikey: 'flag-key',
  appId: 'com.app',
  explicitApiKey: true,
})
```

- [ ] **Step 2: Register and run the focused test**

Add `test:authenticated-command-invocation` to `cli/package.json` and include it
in the complete `test` chain. Run:

```bash
bun run --cwd cli test:authenticated-command-invocation
```

Expected: FAIL because `cli/src/auth/command-input.ts` does not exist.

- [ ] **Step 3: Implement minimal pure resolvers**

Create helpers that trim empty values, give the flag precedence, preserve
`init KEY APP_ID`, and shift the first positional value to `appId` for
`init -a KEY APP_ID`:

```ts
function normalized(value?: string): string | undefined {
  return value?.trim() || undefined
}

export function resolveLoginCommandApiKey(positional?: string, option?: string): string | undefined {
  return normalized(option) ?? normalized(positional)
}

export function resolveInitCommandInput(positionalKey?: string, positionalAppId?: string, optionKey?: string) {
  const flagKey = normalized(optionKey)
  const legacyKey = normalized(positionalKey)
  return flagKey
    ? { apikey: flagKey, appId: normalized(positionalAppId) ?? legacyKey, explicitApiKey: true }
    : { apikey: legacyKey, appId: normalized(positionalAppId), explicitApiKey: Boolean(legacyKey) }
}
```

- [ ] **Step 4: Run the focused test**

Run `bun run --cwd cli test:authenticated-command-invocation`.
Expected: input-resolution assertions pass; deferred telemetry assertions added
in Task 2 still fail.

## Task 2: Add deferred, explicit-key invocation telemetry

**Files:**
- Modify: `cli/src/analytics/track.ts`
- Modify: `cli/test/test-analytics.mjs`
- Modify: `cli/test/test-authenticated-command-invocation.mjs`

- [ ] **Step 1: Add failing analytics tests**

Cover these behaviors using the existing fetch stub:

```js
deferCommandInvocation('login', { flags: ['apikey'], positional_arg_count: 0 })
await flushAnalytics()
assert.equal(findEvent(requests), undefined)

flushDeferredCommandInvocation('validated-key')
await flushAnalytics()
assert.equal(findEvent(requests).init.headers.capgkey, 'validated-key')
assert.equal(JSON.parse(findEvent(requests).init.body).tags.command_path, 'login')

flushDeferredCommandInvocation('validated-key')
await flushAnalytics()
assert.equal(requests.filter(request => request.url.endsWith('/private/events')).length, 1)
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
bun run --cwd cli test:analytics
bun run --cwd cli test:authenticated-command-invocation
```

Expected: FAIL because the deferred APIs are not exported.

- [ ] **Step 3: Implement deferred state and explicit-key flush**

In `track.ts`, add one process-local pending record:

```ts
interface DeferredCommandInvocation {
  commandPath: string
  ctx: CommandContext
}

let deferredCommandInvocation: DeferredCommandInvocation | undefined

export function deferCommandInvocation(commandPath: string, ctx: CommandContext): void {
  commandStartedAt = Date.now()
  currentCommandPath = commandPath
  deferredCommandInvocation = { commandPath, ctx }
}

export function flushDeferredCommandInvocation(apikey: string): void {
  const invocation = deferredCommandInvocation
  if (!invocation)
    return
  deferredCommandInvocation = undefined
  emitCommandInvoked(invocation.commandPath, invocation.ctx, apikey)
}
```

Refactor the existing event payload into `emitCommandInvoked`, accepting an
optional explicit key. Keep `trackCommandInvoked` behavior unchanged for all
other commands.

- [ ] **Step 4: Run both focused tests**

Expected: both commands exit 0 with no duplicate request.

## Task 3: Wire validated command actions and `-a`

**Files:**
- Modify: `cli/src/index.ts`
- Modify: `cli/src/login.ts`
- Modify: `cli/src/init/command.ts`
- Modify: `cli/test/test-authenticated-command-invocation.mjs`

- [ ] **Step 1: Add failing command-contract tests**

Assert that command help/source registers `-a, --apikey`, pre-action defers
`login` and `init`, login flush occurs after `validateAndSaveKey`, and init
flush occurs after `resolveUserIdFromApiKey`.

- [ ] **Step 2: Run and verify the contract test fails**

Run `bun run --cwd cli test:authenticated-command-invocation`.
Expected: FAIL because the option and wiring are absent.

- [ ] **Step 3: Defer login/init from pre-action**

In `index.ts`, derive the context once and branch:

```ts
const commandContext = extractCommandContext(actionCommand)
if (currentCommandPath === 'login' || currentCommandPath === 'init')
  deferCommandInvocation(currentCommandPath, commandContext)
else
  trackCommandInvoked(currentCommandPath, commandContext)
```

Add `.option('-a, --apikey <apikey>', optionDescriptions.apikey)` to both
commands.

- [ ] **Step 4: Emit login invocation after validation**

Make `loginInternal` return the validated key. Resolve `options.apikey` before
the positional value in the top-level action, await `loginInternal`, then call
`flushDeferredCommandInvocation(validatedApiKey)`.

- [ ] **Step 5: Emit init invocation after validation**

Resolve init inputs before assigning `options.apikey` and `appId`. Preserve
whether a key was explicitly supplied for the existing forced-login branch.
Call `flushDeferredCommandInvocation(options.apikey)` immediately after
`resolveUserIdFromApiKey` succeeds.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun run --cwd cli test:authenticated-command-invocation
bun run --cwd cli test:analytics
bun run --cwd cli test:auth-session
bun run --cwd cli test:init-telemetry
```

Expected: all commands exit 0.

## Task 4: Verify, review, and publish

**Files:**
- Review every changed file against `docs/superpowers/specs/2026-08-16-authenticated-cli-invocation-design.md`.

- [ ] **Step 1: Run formatting and focused static gates**

```bash
bun run cli:lint
bun run cli:typecheck
git diff --check
```

- [ ] **Step 2: Run the full CLI completion gate**

```bash
bun run cli:check
```

Expected: lint, typecheck, build, and the complete CLI suite pass.

- [ ] **Step 3: Audit requirements and diff**

Confirm exact-once behavior, explicit validated-key attribution, invalid-key
suppression by call ordering, both `-a` forms, positional compatibility, no
API-key values in analytics tags, and no unrelated changes.

- [ ] **Step 4: Commit and push**

```bash
git add cli docs/superpowers
git commit -m "fix(cli): authenticate login and init invocation telemetry"
git push -u origin wolny/fix-cli-authenticated-invocation
```

- [ ] **Step 5: Open the PR and run `pr-ready`**

Create a PR against `main`, inspect every check/review/thread/mergeability gate,
and obtain two unchanged green observations at least five minutes apart.
