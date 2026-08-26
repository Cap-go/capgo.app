# Repeatable Bento Frontend Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every existing frontend `User Login` tracking occurrence to Bento as `user:login` for all authenticated customer flows.

**Architecture:** Extend the existing allowlisted user Bento event registry; do not change authentication or invitation flows. Mark the mapping `delivery: 'every'` so `recordUserBentoEvent` uses its immediate repeatable-event path and never persists once-only state.

**Tech Stack:** TypeScript, Vitest, Bun, Hono backend utilities

---

### Task 1: Bind frontend login to repeatable Bento delivery

**Files:**
- Modify: `tests/user-bento-events.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/user_bento_events.ts`

- [ ] **Step 1: Write the failing registry test**

Add this test inside `describe('cli user Bento event registry', ...)`:

```ts
it('maps every frontend login to repeatable Bento delivery', () => {
  expect(buildMappedUserBentoEvent({
    sourceEvent: 'User Login',
    observedAt: '2026-08-26T10:00:00.000Z',
  })).toMatchObject({
    bentoEvent: 'user:login',
    delivery: 'every',
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bunx vitest run tests/user-bento-events.unit.test.ts`

Expected: FAIL because `buildMappedUserBentoEvent(...)` returns `undefined` for the unmapped `User Login` source event.

- [ ] **Step 3: Add the minimal data-only binding**

Add `user:login` to `USER_BENTO_EVENT_NAMES`, then add this registry entry:

```ts
'User Login': {
  bentoEvent: 'user:login',
  delivery: 'every',
  fields: [],
},
```

Do not add customer-type conditions: the existing shared auth guard emits this source event before self-signup onboarding and invitation routing.

- [ ] **Step 4: Run focused and relevant verification**

Run:

```bash
bunx vitest run tests/user-bento-events.unit.test.ts
bun lint:backend
bun test:unit
bun typecheck:backend
```

Expected: all commands exit successfully with the new registry test passing.

- [ ] **Step 5: Commit the implementation**

```bash
git add -- tests/user-bento-events.unit.test.ts supabase/functions/_backend/utils/user_bento_events.ts
git commit -m "feat(analytics): send frontend logins to Bento"
```
