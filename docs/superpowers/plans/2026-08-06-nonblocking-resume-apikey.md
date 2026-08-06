# Nonblocking Resume API Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render resumed app onboarding without waiting for API-key provisioning.

**Architecture:** Keep resume app loading on the page-level initialization path, then launch the existing API-key helper as a handled background promise. The CLI command card owns the key-loading feedback and remains noninteractive until the promise resolves.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest

---

## Task 1: Make resume API-key provisioning nonblocking

**Files:**
- Modify: `src/components/dashboard/AppOnboardingFlow.vue:864-890`
- Test: `tests/app-onboarding-apikey-loading.unit.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add an assertion that the mounted flow contains this order and does not await key creation:

```ts
it.concurrent('renders a resumed app without waiting for API key provisioning', () => {
  const resumeLoader = onboardingSource.slice(
    onboardingSource.indexOf('async function loadResumeApp()'),
    onboardingSource.indexOf('async function importStoreMetadata('),
  )
  const mountedFlow = onboardingSource.slice(onboardingSource.indexOf('onMounted(async () => {'))
  expect(resumeLoader).not.toContain('ensureApiKey')
  expect(mountedFlow.indexOf('const resumed = await loadResumeApp()'))
    .toBeLessThan(mountedFlow.indexOf('void ensureApiKey().catch'))
  expect(mountedFlow).not.toContain('await ensureApiKey()')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test tests/app-onboarding-apikey-loading.unit.test.ts`

Expected: FAIL because the current mounted flow awaits `ensureApiKey()` before `loadResumeApp()`.

- [ ] **Step 3: Implement the minimal nonblocking flow**

After organization and user initialization, await `loadResumeApp()` and set the details step when no app was resumed. Then launch the existing helper without awaiting it:

```ts
const resumed = await loadResumeApp()
if (!resumed)
  flowStep.value = 'details'

void ensureApiKey().catch((error) => {
  console.error('Cannot ensure API key', error)
  toast.error(t('app-onboarding-toast-apikey-error'))
})
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test tests/app-onboarding-apikey-loading.unit.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run repository verification**

Run: `bun lint:backend`, `bun lint`, `bun typecheck`, `bun test:unit`, and `bun run build`.

Expected: every command exits successfully and no generated-file changes remain.

- [ ] **Step 6: Commit and push PR #2877**

```bash
git add docs/superpowers/specs/2026-08-06-nonblocking-resume-apikey-design.md docs/superpowers/plans/2026-08-06-nonblocking-resume-apikey.md src/components/dashboard/AppOnboardingFlow.vue tests/app-onboarding-apikey-loading.unit.test.ts
git commit -m "fix(onboarding): keep setup resume nonblocking"
git push origin wolny/onboarding-apikey-loading
```

Expected: PR #2877 updates to the new head commit and CI starts.
