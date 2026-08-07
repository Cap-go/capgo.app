# Onboarding Package Manager Spawn Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onboarding detect unavailable package-manager executables, offer installed alternatives, and preserve the original spawn error when launch fails.

**Architecture:** Add a focused `init/command-execution.ts` module for executable probing, package-manager metadata/discovery, and one-shot child settlement. Keep prompts and Ink status updates in `init/command.ts`, where the detected manager is replaced only after the user explicitly selects an installed alternative.

**Tech Stack:** TypeScript, Node/Bun `child_process`, Clack prompts, existing CLI guardrail test harness.

---

### Task 1: Executable and process-settlement regression tests

**Files:**
- Create: `cli/src/init/command-execution.ts`
- Modify: `cli/test/test-init-guardrails.mjs`

- [ ] **Step 1: Write failing tests for executable probing and package-manager metadata**

Import `getAvailablePackageManagers`, `getPackageManagerInfo`, and `probeExecutable` from the new module. Assert that an impossible command is unavailable, a probe callback discovers only the declared installed alternatives, and each supported manager returns its expected direct command/runner pair.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: FAIL because `cli/src/init/command-execution.ts` does not exist.

- [ ] **Step 3: Implement the minimal probing and metadata functions**

Use direct `spawnSync(command, ['--version'], { cwd, env, stdio: 'ignore' })`. Treat any returned spawn error as unavailable; a started process is available regardless of its exit status. Define explicit metadata for `npm`, `pnpm`, `yarn`, and `bun`, and filter alternatives using the same probe.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: PASS.

- [ ] **Step 5: Write a failing regression test for spawn error settlement**

Spawn an impossible executable, pass the child to `waitForCommandResult`, and assert that the result retains `code === 'ENOENT'` instead of producing `Command exited with code -2`. Add controls for exit code `0` and a normal nonzero exit.

- [ ] **Step 6: Run the focused test and verify RED**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: FAIL because `waitForCommandResult` is not implemented.

- [ ] **Step 7: Implement one-shot child settlement**

Register `error` and `close` listeners behind a shared settled guard. Return the first result only; report code `0` as success and normal nonzero exits as `Command exited with code N`.

- [ ] **Step 8: Run the focused test and verify GREEN**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: PASS.

### Task 2: Onboarding integration and alternative selection

**Files:**
- Modify: `cli/src/init/command.ts:3237-3312`
- Modify: `cli/src/init/command.ts:3496-3620`
- Modify: `cli/test/test-init-guardrails.mjs`

- [ ] **Step 1: Add failing tests for alternative selection inputs**

Test that the detected manager is omitted from available alternatives and that no-manager discovery returns an empty list suitable for the targeted failure path.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: FAIL on the new selection/discovery assertions.

- [ ] **Step 3: Integrate generic command preflight**

Before `spawn()`, call `probeExecutable(runnerCmd, { cwd: params.cwd })`. On failure, update the streaming panel once with `Cannot find executable "<command>" in PATH` and return the original probe error as the cause. Replace the duplicate child event handlers with one awaited `waitForCommandResult` call, then update Ink status exactly once from that result.

- [ ] **Step 4: Add the package-manager fallback prompt**

Before automatic build, probe the detected manager. If it is missing, discover installed alternatives, prompt with `pSelect`, pass the explicit selection through `cancelCommand`, and construct the corresponding build and Capacitor runner metadata. If no alternatives exist, throw a targeted missing-executable error. Do not invoke a shell or PTY and do not silently change managers.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `bun cli/test/test-init-guardrails.mjs`

Expected: PASS with all init guardrail tests.

### Task 3: Repository validation and publication

**Files:**
- Verify all changed implementation, test, and documentation files.

- [ ] **Step 1: Run formatting and lint**

Run: `bun run cli:lint`

Expected: exit code 0.

- [ ] **Step 2: Run CLI typecheck and build**

Run: `bun run cli:check`

Expected: exit code 0 with lint, typecheck, build, and CLI tests passing.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git status --short && git diff origin/main...HEAD`

Expected: no whitespace errors and only the intended docs, runner, integration, and test changes; `codedb.snapshot` remains unstaged.

- [ ] **Step 4: Commit and push**

Stage only intended files, commit with Conventional Commits, and push `wolny/fix-onboarding-package-manager-spawn` to `origin`.

- [ ] **Step 5: Open a ready-for-review PR**

Create a non-draft PR targeting `main` with the root cause, behavior change, and exact validation commands in its body.

- [ ] **Step 6: Run the `pr-ready` workflow**

Converge local and remote gates, reviews, threads, and mergeability to green; record observation A; wait at least five minutes without relevant state changes; then record observation B from fresh GitHub state.
