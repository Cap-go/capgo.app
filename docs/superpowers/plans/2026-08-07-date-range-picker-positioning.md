# Date Range Picker Positioning Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the shared date range popover aligned to its trigger instead of pinning it to the viewport's left edge.

**Architecture:** Preserve the existing body teleport and viewport-relative `right` calculation. Reset the native dialog's conflicting inline-start position in the component stylesheet, with a focused source regression test covering both sides of the positioning contract.

**Tech Stack:** Vue 3 SFC, scoped CSS, Vitest, Bun

---

### Task 1: Add the positioning regression test

**Files:**
- Create: `tests/date-range-picker-positioning.unit.test.ts`
- Test: `src/components/DateRangePicker.vue`

- [ ] **Step 1: Write the failing test**

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('date range picker positioning', () => {
  it('clears the native dialog left inset while retaining trigger right alignment', async () => {
    const source = await readFile(new URL('../src/components/DateRangePicker.vue', import.meta.url), 'utf8')

    expect(source).toMatch(/right:\s*`\$\{Math\.round\(window\.innerWidth - rect\.right\)\}px`/)
    expect(source).toMatch(/\.date-range-popover\s*\{[^}]*\bleft:\s*auto\s*;/s)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/date-range-picker-positioning.unit.test.ts`

Expected: FAIL because `.date-range-popover` does not contain `left: auto`.

### Task 2: Reset the dialog's native left inset

**Files:**
- Modify: `src/components/DateRangePicker.vue:511`
- Test: `tests/date-range-picker-positioning.unit.test.ts`

- [ ] **Step 1: Add the minimal CSS reset**

```css
.date-range-popover {
  left: auto;
  max-width: none;
  max-height: none;
}
```

- [ ] **Step 2: Run the focused test to verify it passes**

Run: `bunx vitest run tests/date-range-picker-positioning.unit.test.ts`

Expected: PASS with one passing test.

- [ ] **Step 3: Run repository validation**

Run: `bun lint`

Expected: exit code 0.

Run: `bun typecheck`

Expected: exit code 0.

Run: `bun test:unit`

Expected: exit code 0 with all unit tests passing.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/components/DateRangePicker.vue tests/date-range-picker-positioning.unit.test.ts
git commit -m "fix(ui): align date picker popover with trigger"
```

### Task 3: Publish and validate the pull request

**Files:**
- No additional file changes expected.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin wolny/fix-date-range-picker-position`

Expected: the branch is available on GitHub.

- [ ] **Step 2: Open a draft pull request**

Run: `gh pr create --draft --base main --head wolny/fix-date-range-picker-position --title "fix(ui): align date picker popover with trigger" --body-file /private/tmp/date-range-picker-pr-body.md`

Expected: GitHub returns the new pull request URL.

- [ ] **Step 3: Prove stable-green readiness**

Inspect required GitHub checks, reviews, unresolved conversations, and mergeability for the pushed head. Once all gates are green, record two fresh observations at least five minutes apart with unchanged head and base SHAs.
