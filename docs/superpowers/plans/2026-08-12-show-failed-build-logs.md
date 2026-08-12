# Show Failed Build Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a failed-build menu action that reopens the retained build log at the bottom without retrying the build.

**Architecture:** Introduce an Ink-only `build-log-view` state shared by the iOS and Android onboarding apps. Extend the existing fullscreen build viewer with an optional exit callback, leaving its live `requesting-build` behavior unchanged and reusing its bottom-following scroll state for the read-only view.

**Tech Stack:** TypeScript, React Ink, Bun CLI regression scripts

---

### Task 1: Specify the failed-build log interaction

**Files:**
- Modify: `cli/test/test-frame-fit-build.mjs`
- Modify: `cli/test/test-ios-tui-render.mjs`
- Modify: `cli/test/test-android-tail-render.mjs`

- [ ] **Step 1: Write failing rendering tests**

Assert that both AI failure prompts contain `Show me the build logs` before `Skip`, and that a read-only `FullscreenBuildOutput` renders the newest retained line plus an Esc/Enter dismissal hint without the active `Building...` spinner.

```js
const frame = renderFrameText(h(AiAnalysisPromptStep, { onChange: noop }), 100, 30)
assert(frame.includes('Show me the build logs'), 'missing build-log option')
assert(frame.indexOf('Show me the build logs') < frame.indexOf('Skip'), 'build-log option must appear above Skip')

const logFrame = renderFrameText(h(FullscreenBuildOutput, {
  title: 'Build failed',
  lines: longLog,
  terminalRows: 24,
  onExit: noop,
}), 80, 24)
assert(logFrame.includes('build log line 400'), 'read-only viewer must open at the bottom')
assert(logFrame.includes('Press Esc or Enter to go back.'), 'missing dismissal hint')
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
bun cli/test/test-frame-fit-build.mjs
bun cli/test/test-ios-tui-render.mjs
bun cli/test/test-android-tail-render.mjs
```

Expected: the new assertions fail because the menu action and read-only viewer mode do not exist.

### Task 2: Implement the dedicated viewer state

**Files:**
- Modify: `cli/src/build/onboarding/types.ts`
- Modify: `cli/src/build/onboarding/android/types.ts`
- Modify: `cli/src/build/onboarding/ui/components.tsx`
- Modify: `cli/src/build/onboarding/ui/steps/ios-shared.tsx`
- Modify: `cli/src/build/onboarding/ui/steps/android-shared.tsx`
- Modify: `cli/src/build/onboarding/ui/app.tsx`
- Modify: `cli/src/build/onboarding/android/ui/app.tsx`

- [ ] **Step 1: Add the shared state and prompt choice**

Add `build-log-view` to both `OnboardingStep` and `AndroidOnboardingStep`, including each platform's progress and phase-label mappings. Add the `logs` choice immediately above `skip` in both platform prompts, and route that choice to the dedicated state.

```tsx
{ label: '👀  Show me the build logs', value: 'logs' },
{ label: '⏭   Skip', value: 'skip' },

if (choice === 'logs') {
  setStep('build-log-view')
  return
}
```

- [ ] **Step 2: Add read-only viewer behavior**

Give `FullscreenBuildOutput` an optional `onExit` callback. When supplied, Esc/Enter calls it and the footer shows a completed failure label and dismissal hint; when omitted, retain the current spinner, elapsed timer, auto-follow, and scrolling behavior.

```tsx
onExit?: () => void

useInput((input, key) => {
  if (onExit && isBuildCompleteDismissKey(input, key)) {
    onExit()
    return
  }
  // Existing buildScrollAction handling remains unchanged.
})
```

- [ ] **Step 3: Render the retained log without invoking the build effect**

For `build-log-view`, render `FullscreenBuildOutput` with the existing `buildOutput`, a failure title, and an exit callback that returns to `ai-analysis-prompt`. Keep `requesting-build` as the only state that resets output and runs the build effect.

```tsx
if (step === 'build-log-view') {
  return (
    <FullscreenBuildOutput
      title="Build failed"
      lines={buildOutput}
      terminalRows={terminalRows}
      onExit={() => setStep('ai-analysis-prompt')}
    />
  )
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
bun cli/test/test-frame-fit-build.mjs
bun cli/test/test-ios-tui-render.mjs
bun cli/test/test-android-tail-render.mjs
```

Expected: all focused tests pass.

### Task 3: Validate and publish

**Files:**
- Verify all files changed by Tasks 1 and 2

- [ ] **Step 1: Run repository completion gates**

Run:

```bash
bun lint
bun typecheck
bun run cli:check
```

Expected: all commands exit successfully.

- [ ] **Step 2: Review the final diff**

Confirm the automatic failure transition remains unchanged, `requesting-build` is still the only build-submission state, and unrelated workspace changes are excluded.

- [ ] **Step 3: Commit and open the PR**

Commit with Conventional Commits, push `wolny/show-build-logs`, create a non-draft PR, and monitor it through the repository's stable-green PR readiness gate.
