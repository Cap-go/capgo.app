# Fix Plans User Visit Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing `User visit` PostHog event while making it fire once per organization per Plans route activation and identifying it explicitly with `page: 'plans'`.

**Architecture:** Put the event payload and per-activation organization guard in a small frontend service. `Plans.vue` owns activation reset and calls the service after its existing auth, permission, and organization checks; `Usage.vue` stops emitting the Plans event. This keeps historical continuity without changing the backend tracking contract.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, existing `sendEvent` tracking service.

---

## File map

- Create `src/services/plansVisitTracking.ts`: owns the canonical event payload and the in-memory per-activation organization deduplication guard.
- Create `tests/plans-visit-tracking.unit.test.ts`: verifies payload, same-organization deduplication, organization switching, reset behavior, and page integration source contracts.
- Modify `src/pages/settings/organization/Plans.vue`: use the tracker and reset it when leaving the Plans route.
- Modify `src/pages/settings/organization/Usage.vue`: remove only the redundant Plans `User visit` branch and its `sendEvent` import; preserve the watcher and success-toast behavior.

### Task 1: Build and test the visit tracker

**Files:**
- Create: `src/services/plansVisitTracking.ts`
- Create: `tests/plans-visit-tracking.unit.test.ts`

- [ ] **Step 1: Write the failing tracker unit tests**

Create `tests/plans-visit-tracking.unit.test.ts` with the behavioral tests below. The integration-source tests are added in Task 2.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlansVisitTracker } from '../src/services/plansVisitTracking'

describe('plans visit tracking', () => {
  const sender = vi.fn(async () => null)

  beforeEach(() => {
    sender.mockReset()
    sender.mockResolvedValue(null)
  })

  it('sends the existing User visit event with an explicit plans page property', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sender).toHaveBeenCalledWith({
      channel: 'usage',
      event: 'User visit',
      icon: '💳',
      org_id: 'org-1',
      tracking_version: 2,
      notify: false,
      tags: { page: 'plans' },
    })
  })

  it('does not send twice for the same organization during one route activation', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(tracker.track('org-1')).toBe(false)
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('tracks a different organization during the same route activation', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(tracker.track('org-2')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('allows the organization to be tracked again after leaving the route', () => {
    const tracker = createPlansVisitTracker(sender)

    tracker.track('org-1')
    tracker.reset()

    expect(tracker.track('org-1')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('ignores a missing organization id', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track(undefined)).toBe(false)
    expect(sender).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the focused test and verify that it fails**

Run:

```bash
bunx vitest run tests/plans-visit-tracking.unit.test.ts
```

Expected: FAIL because `src/services/plansVisitTracking.ts` does not exist.

- [ ] **Step 3: Implement the minimal tracker service**

Create `src/services/plansVisitTracking.ts`:

```ts
import { sendEvent } from './tracking'

export function createPlansVisitTracker(sender: typeof sendEvent = sendEvent) {
  const trackedOrganizationIds = new Set<string>()

  return {
    reset() {
      trackedOrganizationIds.clear()
    },

    track(orgId: string | null | undefined) {
      if (!orgId || trackedOrganizationIds.has(orgId))
        return false

      trackedOrganizationIds.add(orgId)
      void sender({
        channel: 'usage',
        event: 'User visit',
        icon: '💳',
        org_id: orgId,
        tracking_version: 2,
        notify: false,
        tags: { page: 'plans' },
      })
      return true
    },
  }
}
```

- [ ] **Step 4: Run the focused test and verify that it passes**

Run:

```bash
bunx vitest run tests/plans-visit-tracking.unit.test.ts
```

Expected: PASS with five tests.

- [ ] **Step 5: Commit the tracker and its behavioral tests**

```bash
git add src/services/plansVisitTracking.ts tests/plans-visit-tracking.unit.test.ts
git commit -m "fix(analytics): deduplicate plans visit events"
```

### Task 2: Wire the tracker into the Plans route and remove the duplicate emitter

**Files:**
- Modify: `src/pages/settings/organization/Plans.vue:1-30,390-460`
- Modify: `src/pages/settings/organization/Usage.vue:1-60`
- Modify: `tests/plans-visit-tracking.unit.test.ts`

- [ ] **Step 1: Add failing page-integration source contracts**

Add the import and second `describe` block below to `tests/plans-visit-tracking.unit.test.ts`:

```ts
import { readFileSync } from 'node:fs'

describe('plans visit page integration', () => {
  const plansSource = readFileSync(new URL('../src/pages/settings/organization/Plans.vue', import.meta.url), 'utf8')
  const usageSource = readFileSync(new URL('../src/pages/settings/organization/Usage.vue', import.meta.url), 'utf8')

  it('uses and resets the guarded tracker from the Plans page', () => {
    expect(plansSource).toContain("import { createPlansVisitTracker } from '~/services/plansVisitTracking'")
    expect(plansSource).toContain('plansVisitTracker.track(orgId)')
    expect(plansSource).toContain('plansVisitTracker.reset()')
  })

  it('does not emit the Plans visit event from the Usage page', () => {
    expect(usageSource).not.toContain("event: 'User visit'")
    expect(usageSource).not.toContain("import { sendEvent } from '~/services/tracking'")
  })
})
```

- [ ] **Step 2: Run the focused test and verify that integration contracts fail**

Run:

```bash
bunx vitest run tests/plans-visit-tracking.unit.test.ts
```

Expected: the five tracker tests pass and both page-integration tests fail.

- [ ] **Step 3: Wire the tracker into `Plans.vue`**

Add this service import beside the other service imports:

```ts
import { createPlansVisitTracker } from '~/services/plansVisitTracking'
```

Create one tracker with the page instance and reset it when the route is no longer Plans:

```ts
const plansVisitTracker = createPlansVisitTracker()

watch(() => route.path, (path) => {
  if (path !== '/settings/organization/plans')
    plansVisitTracker.reset()
}, { immediate: true })
```

Replace the existing inline `sendEvent({ event: 'User visit', ... })` block inside the Plans `watchEffect` with:

```ts
const orgId = currentOrganization.value?.gid
plansVisitTracker.track(orgId)
```

Do not alter `trackPlanCheckoutStarted`; `Plans.vue` still needs its existing `sendEvent` import for `Checkout Started`.

- [ ] **Step 4: Remove only the redundant event branch from `Usage.vue`**

Inside the existing `watchEffect`, delete only this `else if` branch:

```ts
else if (main.user?.id) {
  const orgId = currentOrganization.value?.gid
  if (orgId) {
    sendEvent({
      channel: 'usage',
      event: 'User visit',
      icon: '💳',
      org_id: orgId,
      tracking_version: 2,
      notify: false,
    }).catch()
  }
}
```

Remove only the now-unused tracking import:

```ts
import { sendEvent } from '~/services/tracking'
```

Keep `watchEffect`, `route`, `router`, `toast`, `main`, `currentOrganization`, and `organizationStore`. The success-query toast and every other Usage behavior remain unchanged.

- [ ] **Step 5: Run the focused test and verify that all seven tests pass**

Run:

```bash
bunx vitest run tests/plans-visit-tracking.unit.test.ts
```

Expected: PASS with seven tests.

- [ ] **Step 6: Commit the page integration**

```bash
git add src/pages/settings/organization/Plans.vue src/pages/settings/organization/Usage.vue tests/plans-visit-tracking.unit.test.ts
git commit -m "fix(analytics): emit one plans visit per activation"
```

### Task 3: Verify and prepare the pull request

**Files:**
- Verify only; no application files should change.

- [ ] **Step 1: Run repository lint first**

Run:

```bash
bun lint
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 2: Run the focused regression test**

Run:

```bash
bunx vitest run tests/plans-visit-tracking.unit.test.ts
```

Expected: PASS with seven tests.

- [ ] **Step 3: Run the full unit suite**

Run:

```bash
bun test:unit
```

Expected: all unit test files pass.

- [ ] **Step 4: Run the frontend typecheck**

Run:

```bash
bun run typecheck:frontend
```

Expected: exit code 0 with no Vue or TypeScript errors.

- [ ] **Step 5: Confirm the diff remains narrowly scoped**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- src/services/plansVisitTracking.ts src/pages/settings/organization/Plans.vue src/pages/settings/organization/Usage.vue tests/plans-visit-tracking.unit.test.ts
```

Expected: only the tracker service, two page integrations, focused test, and planning documents are present; no generated declarations or unrelated files are included.

- [ ] **Step 6: Hand the branch to the repository's PR-ready workflow**

Invoke the repository `pr-ready` skill. It must review the complete diff, push `wolny/fix-plans-user-visit-tracking`, open a ready-for-review pull request without a `[CODEX]` prefix, monitor required checks, and report stable green before completion.
