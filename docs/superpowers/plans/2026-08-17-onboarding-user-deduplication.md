# Onboarding User De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two existing de-duplication checkboxes switch Daily onboarding attempts and the v3 funnel to one furthest-reaching attempt per PostHog person.

**Architecture:** Reuse the existing PostHog attempt result. A small pure backend selector builds two additive response variants, and two frontend computed values select raw or de-duplicated data locally. No query, endpoint, persistence, migration, or cache changes.

**Tech Stack:** TypeScript, Vue 3 Composition API, Supabase Edge Functions, Vitest

---

## Simplicity guardrail

Keep the implementation narrow:

- one private selector in the existing analytics model;
- one additive `deduplicated` response object;
- two computed frontend data sources;
- no new backend files;
- no HogQL changes;
- no attempt to infer identity beyond PostHog `personId`;
- no abstraction for hypothetical future charts.

Expected production impact is roughly 50–80 lines plus the already-designed checkbox component. Tests should prove the central business rule without enumerating every theoretical event-ordering edge case.

## File map

- Modify `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`: select winning attempts and return the two alternate chart datasets.
- Modify `tests/frontend-onboarding-analytics-model.unit.test.ts`: prove range-level daily selection, stage priority, latest tie-breaking, v3-only funnel selection, and safe missing identities in one focused scenario.
- Modify `src/services/adminFrontendOnboarding.ts`: describe the additive response field for the frontend.
- Modify `src/pages/admin/dashboard/frontend-onboarding.vue`: switch each chart to its independent selected dataset.
- Modify `tests/admin-frontend-onboarding-dashboard.unit.test.ts`: prove default-off independent wiring and update the typed fixture.
- Keep `src/components/admin/AdminChartDeduplicateControl.vue` and `messages/en.json`: the already-approved local checkbox design and label.
- Regenerate or retain only the expected declaration in `src/components.d.ts` if the component generator requires it.

### Task 1: Build de-duplicated backend variants

**Files:**
- Modify: `tests/frontend-onboarding-analytics-model.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`

- [ ] **Step 1: Write one failing model test for the complete selection rule**

Add this test inside `describe('buildFrontendOnboardingAnalytics', ...)`:

```ts
it.concurrent('builds range-level daily and v3-only de-duplicated variants', () => {
  const dayTwo = CURRENT_START_MS + DAY_MS
  const analytics = buildFrontendOnboardingAnalytics([
    attempt({
      attemptId: 'furthest-v1',
      personId: 'furthest',
      onboardingVersion: 1,
      intentMs: CURRENT_START_MS,
      setupMs: CURRENT_START_MS + MINUTE_MS,
    }),
    attempt({
      attemptId: 'furthest-v3',
      personId: 'furthest',
      intentMs: dayTwo,
      organizationMs: dayTwo + MINUTE_MS,
    }),
    attempt({
      attemptId: 'latest-v1',
      personId: 'latest',
      onboardingVersion: 1,
      intentMs: CURRENT_START_MS + 2 * MINUTE_MS,
      detailsMs: CURRENT_START_MS + 3 * MINUTE_MS,
    }),
    attempt({
      attemptId: 'latest-v3',
      personId: 'latest',
      intentMs: dayTwo + 2 * MINUTE_MS,
      detailsMs: dayTwo + 3 * MINUTE_MS,
    }),
    attempt({ attemptId: 'anonymous-one', personId: '', intentMs: CURRENT_START_MS + 4 * MINUTE_MS }),
    attempt({ attemptId: 'anonymous-two', personId: '', intentMs: dayTwo + 4 * MINUTE_MS }),
  ], CURRENT_START_MS, CURRENT_END_MS)

  expect(analytics.deduplicated.daily_attempts).toEqual([
    { date: '2026-08-01', v1_attempts: 1, v2_attempts: 0, v3_attempts: 1 },
    { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 2 },
  ])
  expect(analytics.deduplicated.funnels.v3.map(stage => stage.reached)).toEqual([4, 2, 1, 0])
})
```

This single scenario proves the important behavior:

- the earlier Setup attempt beats a later Organization attempt for the daily chart;
- a later App details attempt wins an equal-stage tie;
- the v3 funnel considers only v3 attempts;
- anonymous attempts are not collapsed together;
- the daily winner appears on the winner's UTC day and version.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts -t "builds range-level daily and v3-only de-duplicated variants"
```

Expected: FAIL because `analytics.deduplicated` does not exist.

- [ ] **Step 3: Add the minimal response type and private selector**

In `FrontendOnboardingAnalytics`, add:

```ts
deduplicated: {
  daily_attempts: FrontendOnboardingDailyAttempt[]
  funnels: {
    v3: FrontendOnboardingFunnelStage[]
  }
}
```

Add these private helpers next to the existing funnel helpers:

```ts
function reachedStageRank(attempt: FrontendOnboardingAttempt): number {
  if (isStepInFollowupWindow(attempt.setupMs, attempt.intentMs))
    return 3
  if (isStepInFollowupWindow(attempt.organizationMs, attempt.intentMs))
    return 2
  if (isStepInFollowupWindow(attempt.detailsMs, attempt.intentMs))
    return 1
  return 0
}

function selectBestAttemptPerPerson(attempts: FrontendOnboardingAttempt[]): FrontendOnboardingAttempt[] {
  const bestByPerson = new Map<string, FrontendOnboardingAttempt>()

  for (const candidate of attempts) {
    const identity = candidate.personId.trim() || `attempt:${candidate.attemptId}`
    const current = bestByPerson.get(identity)
    const candidateRank = reachedStageRank(candidate)
    const currentRank = current ? reachedStageRank(current) : -1
    const isBetter = current === undefined
      || candidateRank > currentRank
      || (candidateRank === currentRank && candidate.intentMs > current.intentMs)
      || (candidateRank === currentRank && candidate.intentMs === current.intentMs && candidate.attemptId > current.attemptId)

    if (isBetter)
      bestByPerson.set(identity, candidate)
  }

  return [...bestByPerson.values()]
}
```

Inside `buildFrontendOnboardingAnalytics`, derive only the two required winner sets:

```ts
const deduplicatedCurrentAttempts = selectBestAttemptPerPerson(currentAttempts)
const deduplicatedCurrentV3Attempts = selectBestAttemptPerPerson(currentV3Attempts)
```

Add the alternate fields to the returned object:

```ts
deduplicated: {
  daily_attempts: buildDailyAttempts(deduplicatedCurrentAttempts, currentStartMs, currentEndMs),
  funnels: {
    v3: buildFunnel(deduplicatedCurrentV3Attempts),
  },
},
```

- [ ] **Step 4: Run the complete model and endpoint analytics tests**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: both files pass with zero failures.

- [ ] **Step 5: Commit the backend behavior**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts tests/frontend-onboarding-analytics-model.unit.test.ts
git commit -m "feat(admin): deduplicate onboarding attempts by user"
```

### Task 2: Wire the two independent chart switches

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts`
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`
- Keep: `src/components/admin/AdminChartDeduplicateControl.vue`
- Modify: `messages/en.json`
- Modify only if generated: `src/components.d.ts`

- [ ] **Step 1: Extend the existing failing dashboard wiring test**

Add a `deduplicated` value to the typed `FrontendOnboardingAnalytics` fixture:

```ts
deduplicated: {
  daily_attempts: [
    { date: '2026-08-01', v1_attempts: 0, v2_attempts: 0, v3_attempts: 1 },
  ],
  funnels: {
    v3: [
      { key: 'intent', label: 'Intent', reached: 1, of_start_percent: 100, dropoff_percent: 0 },
    ],
  },
},
```

Extend the existing `shows independent local de-duplicate controls...` test with source-level assertions for the deliberately small wiring surface:

```ts
expect(source).toContain('const displayedDailyAttempts = computed')
expect(source).toContain('deduplicateDailyAttempts.value')
expect(source).toContain('visibleAnalytics.value?.deduplicated.daily_attempts')
expect(source).toContain('const displayedV3Funnel = computed')
expect(source).toContain('deduplicateV3Funnel.value')
expect(source).toContain('visibleAnalytics.value?.deduplicated.funnels.v3')
expect(source).toContain('buildFrontendOnboardingDailySeries(\n  displayedDailyAttempts.value,')
expect(source).toContain('buildFrontendOnboardingFunnelStages(displayedV3Funnel.value)')
expect(source).toContain('buildFrontendOnboardingFunnelSummaries(displayedV3Funnel.value)')
```

- [ ] **Step 2: Run the focused dashboard test and verify RED**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts -t "shows independent local de-duplicate controls"
```

Expected: FAIL because the controls exist but do not yet select the alternate response data.

- [ ] **Step 3: Extend the frontend response type**

In `FrontendOnboardingAnalytics`, add the same additive shape used by the backend:

```ts
deduplicated: {
  daily_attempts: Array<{
    date: string
    v1_attempts: number
    v2_attempts: number
    v3_attempts: number
  }>
  funnels: {
    v3: FrontendOnboardingFunnelStage[]
  }
}
```

- [ ] **Step 4: Add only two computed selectors and reuse them**

Immediately after `visibleAnalytics`, add:

```ts
const displayedDailyAttempts = computed(() => deduplicateDailyAttempts.value
  ? visibleAnalytics.value?.deduplicated.daily_attempts ?? []
  : visibleAnalytics.value?.daily_attempts ?? [])
const displayedV3Funnel = computed(() => deduplicateV3Funnel.value
  ? visibleAnalytics.value?.deduplicated.funnels.v3 ?? []
  : visibleAnalytics.value?.funnels.v3 ?? [])
```

Change only the relevant derived values:

```ts
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  displayedDailyAttempts.value,
  t('frontend-onboarding-version-1'),
  t('frontend-onboarding-version-2'),
  t('frontend-onboarding-version-3'),
))
const v3FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(displayedV3Funnel.value))
const v3FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(displayedV3Funnel.value))
const hasDailyAttempts = computed(() => displayedDailyAttempts.value
  .some(day => day.v1_attempts > 0 || day.v2_attempts > 0 || day.v3_attempts > 0))
```

Do not add watchers, request parameters, local storage, or loading behavior.

- [ ] **Step 5: Run the dashboard and chart-card tests**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts tests/admin-chart-card-collapse.unit.test.ts
```

Expected: both files pass with zero failures.

- [ ] **Step 6: Commit the frontend control and wiring**

Stage only the feature files. Include `src/components.d.ts` only if its diff contains the expected generated declaration and no unrelated declarations.

```bash
git add messages/en.json src/components/admin/AdminChartDeduplicateControl.vue src/pages/admin/dashboard/frontend-onboarding.vue src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): toggle deduplicated onboarding charts"
```

### Task 3: Verify the final branch without expanding scope

**Files:**
- Verify all intended feature files
- Preserve the unrelated `codedb.snapshot` working-tree modification

- [ ] **Step 1: Rebase the completed feature onto the latest remote main**

```bash
git fetch origin main
git rebase --autostash origin/main
```

Expected: the feature commits are based on the current `origin/main`, and the unrelated `codedb.snapshot` modification is restored by autostash. Resolve a conflict only when it overlaps an intended feature file; otherwise stop and report it.

- [ ] **Step 2: Format only touched TypeScript and Vue files**

```bash
bunx oxlint --fix supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts src/components/admin/AdminChartDeduplicateControl.vue src/pages/admin/dashboard/frontend-onboarding.vue src/services/adminFrontendOnboarding.ts tests/frontend-onboarding-analytics-model.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
bunx eslint --fix src/components/admin/AdminChartDeduplicateControl.vue src/pages/admin/dashboard/frontend-onboarding.vue src/services/adminFrontendOnboarding.ts tests/frontend-onboarding-analytics-model.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: exit 0. Do not run a broad formatter that rewrites unrelated files.

- [ ] **Step 3: Run the relevant unit suite**

```bash
bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts tests/admin-chart-card-collapse.unit.test.ts
```

Expected: all selected files and tests pass.

- [ ] **Step 4: Run repository completion gates**

```bash
bun run lint
bun run typecheck
bun run build
git diff --check
```

Expected: every command exits 0. Existing lint warnings may be reported, but there must be zero lint errors and no warnings introduced in touched files.

- [ ] **Step 5: Audit the final scope**

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- . ':(exclude)codedb.snapshot'
```

Expected: the PR contains the design, plan, backend model/test, frontend type/control/wiring/test, and translation only. `codedb.snapshot` remains unstaged and outside every feature commit.

### Task 4: Publish the PR and prove stable-green

**Files:**
- No source changes unless a local gate, CI failure, or actionable review identifies a defect

- [ ] **Step 1: Confirm GitHub access and branch identity**

```bash
gh --version
gh auth status
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

Expected: authenticated GitHub CLI, branch `wolny/dedupe-onboarding-controls`, and explicit head/base SHAs.

- [ ] **Step 2: Push the feature branch**

```bash
git push -u origin wolny/dedupe-onboarding-controls
```

Expected: the remote branch points to the verified local head SHA.

- [ ] **Step 3: Open a ready-for-review PR against `main`**

Create a concise body covering the winning-attempt rule, additive response, local independent switches, and verification commands. Open the PR as non-draft because the requested `pr-ready` workflow requires an open ready-for-review PR.

Write `/private/tmp/capgo-onboarding-dedup-pr-body.md` with:

```markdown
## What changed

- add one furthest-reaching onboarding attempt per PostHog person as an alternate analytics response
- let Daily onboarding attempts and the v3 funnel switch independently to the de-duplicated data
- keep both controls local, default-off, and instant

## Selection rule

Attempts are ranked by Setup, Organization, App details, then Intent. Equal-stage attempts use the latest Intent timestamp. Daily attempts compete across v1/v2/v3 for the selected range; the v3 funnel competes only among v3 attempts.

## Verification

- `bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts tests/admin-chart-card-collapse.unit.test.ts`
- `bun run lint`
- `bun run typecheck`
- `bun run build`
```

```bash
gh pr create --base main --head wolny/dedupe-onboarding-controls --title "feat(admin): deduplicate onboarding charts by user" --body-file /private/tmp/capgo-onboarding-dedup-pr-body.md
```

Expected: GitHub returns the new PR URL.

- [ ] **Step 4: Run the `pr-ready` converge phase**

Fetch the PR's current head/base SHAs, required checks, effective reviews, requested reviewers, unresolved threads, mergeability, and repository requirements. Fix only concrete failures within this feature's scope, rerun the affected local gates, commit, push, and restart the observation window after every change.

Expected observation A: all required checks pass, the PR is mergeable, no change request or unresolved thread remains, required approvals are satisfied, and no requested reviewer remains pending.

- [ ] **Step 5: Prove stable-green after five minutes**

Wait at least 300 seconds after observation A without blocking for more than 60 seconds at a time. Fetch fresh GitHub state and record observation B only if head SHA, base SHA, check suite, review state, requested reviewers, mergeability, and repository requirements are unchanged and still green.

Expected: stable-green evidence contains both UTC timestamps at least five minutes apart.
