# Remove the CLI Terminal Pixel Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent CLI replay startup from writing an xterm pixel-size query or manipulating stdin.

**Architecture:** Normal replay startup will resolve terminal pixel size to `undefined`, activating the existing columns/rows-derived viewport fallback. Explicit pixel dimensions remain supported for deterministic callers and tests.

**Tech Stack:** TypeScript, Node.js streams, xterm headless, CLI test script

---

### Task 1: Remove the runtime terminal query

**Files:**
- Modify: `cli/test/test-init-replay.mjs`
- Modify: `cli/src/init/replay.ts`

- [x] **Step 1: Write the failing regression test**

Update the replay startup test to omit `terminalPixelSize`, capture stdout writes before replay patches the stream, and assert that startup neither writes `\u001B[14t` nor calls `stdin.setRawMode`.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `bun cli/test/test-init-replay.mjs`

Expected: FAIL because current startup calls `queryTerminalPixelSize()`, writes `\u001B[14t`, and enables raw mode.

- [x] **Step 3: Implement the minimal behavior change**

In `startInitReplay`, replace the default `queryTerminalPixelSize()` source with `Promise.resolve(undefined)`. Remove the now-unused query constants, parser, query function, stdin import, and their dedicated tests. Preserve `TerminalPixelSize`, `getReplayViewportSize`, and explicit `terminalPixelSize` support.

- [x] **Step 4: Verify the focused test passes**

Run: `bun cli/test/test-init-replay.mjs`

Expected: PASS with `✅ init replay telemetry tests passed`.

- [x] **Step 5: Run repository CLI checks**

Run: `bun lint:backend && bun lint && bun run cli:check`

Expected: all commands exit successfully.

- [x] **Step 6: Commit the implementation**

Commit the two code files and this plan with Conventional Commit message `fix(cli): stop querying terminal pixel size`.
