# Hide Pre-Organization Terminal Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent pre-organization onboarding from rendering an unusable terminal option before API-key prerequisites exist.

**Architecture:** Guard the existing shared terminal-option container at the Vue template boundary with `!props.preOrg`. Keep the post-creation setup command and existing-organization onboarding behavior unchanged.

**Tech Stack:** Vue 3, TypeScript, Vitest, Bun

---

### Task 1: Guard the pre-organization terminal option

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:1283`
- Test: `tests/app-onboarding-apikey-loading.unit.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add this assertion to the existing test suite:

```ts
it.concurrent('does not render the terminal alternative before an organization exists', () => {
  expect(onboardingSource).toContain('<div v-if="!props.preOrg" class="pt-1">')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `bunx vitest run tests/app-onboarding-apikey-loading.unit.test.ts`. Expect
the new assertion to fail because the container is currently `<div
class="pt-1">`.

- [ ] **Step 3: Implement the minimal render guard**

Change the shared command container to:

```vue
<div v-if="!props.preOrg" class="pt-1">
```

Do not change API-key creation or the dedicated setup-step command.

- [ ] **Step 4: Verify GREEN and repository checks**

Run `bunx vitest run tests/app-onboarding-apikey-loading.unit.test.ts`, `bun
lint`, `bun test:unit`, `bun typecheck`, and `CHOKIDAR_USEPOLLING=1 bun run
build`. Expect every command to exit successfully.

- [ ] **Step 5: Commit and publish**

Stage only the spec, plan, Vue component, and focused test. Commit with `fix(onboarding): hide terminal option before org creation`, push the branch, and open a non-draft pull request.
