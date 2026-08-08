# Fix Terminal Replay Clipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the final rows of CLI replay SVGs from being clipped.

**Architecture:** Keep the existing viewport sizing and normalize the SVG's
inner typography to match it exactly. Cover the production SVG output with a
30-row regression test.

**Tech Stack:** TypeScript, Bun, xterm headless, rrweb snapshots

---

### Task 1: Add the clipping regression and CSS correction

**Files:**
- Modify: `cli/src/init/replay.ts`
- Test: `cli/test/test-init-replay.mjs`

- [ ] **Step 1: Write the failing test**

Create a 100-by-30 frame whose final row contains `LAST ROW MUST BE FULLY
VISIBLE`, build its snapshot, decode the SVG data URL, and assert that the SVG
uses an exact 20-pixel line height and a zero-margin inherited-font `<pre>`.

- [ ] **Step 2: Run the focused test and verify RED**

Run `bun cli/test/test-init-replay.mjs`. Expect the new SVG-layout assertion to
fail against the current `14px/1.45` font and default `<pre>` margin.

- [ ] **Step 3: Implement the minimal correction**

In `buildTerminalImageDataUrl`, change the wrapper font to
`14px/20px ui-monospace,...` and add `<style>pre{margin:0;font:inherit}</style>`
before the serialized terminal HTML. Do not change replay throttling.

- [ ] **Step 4: Verify GREEN and repository checks**

Run `bun cli/test/test-init-replay.mjs`, `bun lint:backend`, `bun lint`, and
`bun run cli:check`. Expect every command to pass.

- [ ] **Step 5: Commit and publish**

Stage only the spec, plan, replay implementation, and replay test. Commit with
`fix(cli): prevent terminal replay clipping`, push the branch, and open a PR.
