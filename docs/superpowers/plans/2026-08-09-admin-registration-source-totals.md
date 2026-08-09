# Admin Registration Source Totals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show selected-period totals for normal registrations, organization-invite registrations, and authentication accounts without profiles directly below the existing registration-source chart.

**Architecture:** Keep the backend response unchanged and derive three totals in `users.vue` from the raw `registration_source_trend` points already filtered by the admin date range. Render the totals with the existing `AdminStatsCard` component inside the registration-source `ChartCard`, preserving the chart's category labels and colors.

**Tech Stack:** Vue 3 Composition API, TypeScript, Tailwind CSS/DaisyUI, Vue I18n, Vitest, Bun.

---

## File Structure

- Modify `tests/admin-registration-source-dashboard.unit.test.ts` to specify the totals computation, card wiring, color mapping, selected-period subtitle, and placement beneath the chart.
- Modify `src/pages/admin/dashboard/users.vue` to compute the three totals from existing trend points and render the responsive card row.
- No backend, schema, API, or translation-file changes are needed; the page reuses existing translation keys.

## Task 1: Specify the selected-period totals row

**Files:**
- Modify: `tests/admin-registration-source-dashboard.unit.test.ts`
- Test: `tests/admin-registration-source-dashboard.unit.test.ts`

- [ ] **Step 1: Write the failing dashboard wiring test**

Add this test inside the existing `describe('admin registration source dashboard', ...)` block:

```ts
it.concurrent('renders selected-period source totals below the stacked chart', async () => {
  const source = await readFile(new URL('../src/pages/admin/dashboard/users.vue', import.meta.url), 'utf8')

  expect(source).toContain('const registrationSourceTotals = computed(() => {')
  expect(source).toContain('normalRegistrations: totals.normalRegistrations + (Number(item.normal_registrations) || 0)')
  expect(source).toContain('organizationInvites: totals.organizationInvites + (Number(item.invite_registrations) || 0)')
  expect(source).toContain('withoutProfiles: totals.withoutProfiles + (Number(item.without_profile) || 0)')
  expect(source).toContain(':value="registrationSourceTotals.normalRegistrations"')
  expect(source).toContain(':value="registrationSourceTotals.organizationInvites"')
  expect(source).toContain(':value="registrationSourceTotals.withoutProfiles"')
  expect(source).toContain('color-class="text-blue-500"')
  expect(source).toContain('color-class="text-orange-500"')
  expect(source).toContain('color-class="text-slate-400"')
  expect(source.match(/:subtitle="t\('selected-period'\)"/g)).toHaveLength(3)

  const chartIndex = source.indexOf('<AdminStackedBarChart')
  const totalsIndex = source.indexOf('data-test="registration-source-totals"')
  const onboardingTrendIndex = source.indexOf('<!-- Onboarding Trend Chart -->')

  expect(chartIndex).toBeGreaterThan(-1)
  expect(totalsIndex).toBeGreaterThan(chartIndex)
  expect(onboardingTrendIndex).toBeGreaterThan(totalsIndex)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/admin-registration-source-dashboard.unit.test.ts
```

Expected: FAIL because `registrationSourceTotals` and `data-test="registration-source-totals"` do not exist yet.

## Task 2: Compute and render the totals

**Files:**
- Modify: `src/pages/admin/dashboard/users.vue:1116-1148`
- Modify: `src/pages/admin/dashboard/users.vue:1243-1260`
- Test: `tests/admin-registration-source-dashboard.unit.test.ts`

- [ ] **Step 1: Add the computed totals beside the chart series**

Insert this computed value immediately before `registrationSourceTrendSeries`:

```ts
const registrationSourceTotals = computed(() => {
  const trend = onboardingFunnelData.value?.registration_source_trend ?? []

  return trend.reduce((totals, item) => ({
    normalRegistrations: totals.normalRegistrations + (Number(item.normal_registrations) || 0),
    organizationInvites: totals.organizationInvites + (Number(item.invite_registrations) || 0),
    withoutProfiles: totals.withoutProfiles + (Number(item.without_profile) || 0),
  }), {
    normalRegistrations: 0,
    organizationInvites: 0,
    withoutProfiles: 0,
  })
})
```

- [ ] **Step 2: Render three matching cards below the stacked chart**

Insert this row immediately after `AdminStackedBarChart` inside the registration-source `ChartCard`:

```vue
<div data-test="registration-source-totals" class="grid grid-cols-1 gap-6 mt-6 md:grid-cols-3">
  <AdminStatsCard
    :title="t('normal-registration')"
    :value="registrationSourceTotals.normalRegistrations"
    color-class="text-blue-500"
    :is-loading="isLoadingOnboardingFunnel"
    :subtitle="t('selected-period')"
  />
  <AdminStatsCard
    :title="t('organization-invite')"
    :value="registrationSourceTotals.organizationInvites"
    color-class="text-orange-500"
    :is-loading="isLoadingOnboardingFunnel"
    :subtitle="t('selected-period')"
  />
  <AdminStatsCard
    :title="t('without-profile')"
    :value="registrationSourceTotals.withoutProfiles"
    color-class="text-slate-400"
    :is-loading="isLoadingOnboardingFunnel"
    :subtitle="t('selected-period')"
  />
</div>
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
bunx vitest run tests/admin-registration-source-dashboard.unit.test.ts
```

Expected: PASS with all tests in the file green.

- [ ] **Step 4: Run frontend lint immediately before committing**

Run:

```bash
bun lint:fix
```

Expected: PASS with no lint errors; retain any safe formatting changes limited to the feature files.

- [ ] **Step 5: Commit the feature**

Run:

```bash
git add tests/admin-registration-source-dashboard.unit.test.ts src/pages/admin/dashboard/users.vue
git commit -m "feat(admin): summarize registration sources"
```

Expected: one feature commit containing only the test and frontend implementation.

## Task 3: Validate and publish the PR

**Files:**
- Verify: `src/pages/admin/dashboard/users.vue`
- Verify: `tests/admin-registration-source-dashboard.unit.test.ts`
- Verify: `docs/superpowers/specs/2026-08-09-admin-registration-source-totals-design.md`
- Verify: `docs/superpowers/plans/2026-08-09-admin-registration-source-totals.md`

- [ ] **Step 1: Run all prescribed local completion gates**

Run:

```bash
bun lint
bun run lint:deadcode
bun typecheck
bun test:unit
CHOKIDAR_USEPOLLING=true bun run build
```

Expected: every command exits successfully; the full unit suite and production build pass.

- [ ] **Step 2: Check the final diff and working tree**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors; only the pre-existing user-owned `codedb.snapshot` modification remains outside committed feature files.

- [ ] **Step 3: Push and open the PR**

Run:

```bash
git push -u origin wolny/admin-registration-source-totals
gh pr create --repo Cap-go/capgo.app --base main --head wolny/admin-registration-source-totals --title "feat(admin): summarize registration sources" --body "Adds three selected-period registration-source totals below the existing stacked chart. Reuses the filtered frontend trend data and existing admin stats cards; no backend changes. Verified with focused and full unit tests, lint, dead-code analysis, type checking, and a production build."
```

Expected: a new non-draft PR targeting `main` with the design, implementation, and verification evidence.

- [ ] **Step 4: Run the `pr-ready` workflow**

Inspect all checks, reviews, requested reviewers, unresolved threads, mergeability, and repository requirements for the pushed head. Address actionable feedback in scope, rerun impacted local gates, and restart the readiness audit after every push.

Expected: record stable-green observations A and B at least 300 seconds apart for unchanged head and base SHAs before reporting completion.
