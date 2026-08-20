# Onboarding v4 App-Step Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the admin Frontend onboarding funnel (v4) from four aggregate stages to the six app-creation stages requested in the approved design.

**Architecture:** Keep the existing four-stage model as the legacy path for onboarding v1-v3 and add a v4-specific stage definition, reach calculator, and best-attempt rank. Extend the existing PostHog attempt projection with the three app substep timestamps, then allow the frontend's order-driven funnel adapters to render the new backend stages.

**Tech Stack:** TypeScript, Vue 3, PostHog HogQL, Vitest, Tailwind CSS.

---

## File Structure

- `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`: owns attempt data, funnel construction, KPI summaries, and de-duplication ranking.
- `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`: owns the HogQL query, result mapping, and admin endpoint response.
- `src/services/adminFrontendOnboarding.ts`: owns frontend response types, funnel stage colors, and chart/summary adapters.
- `src/pages/admin/dashboard/frontend-onboarding.vue`: owns the responsive dashboard layout.
- `tests/frontend-onboarding-analytics-model.unit.test.ts`: verifies six-stage v4 semantics and unchanged legacy behavior.
- `tests/frontend-onboarding-analytics.unit.test.ts`: verifies HogQL projection and row mapping.
- `tests/admin-frontend-onboarding-dashboard.unit.test.ts`: verifies frontend six-stage adaptation and dashboard source wiring.

### Task 1: Specify the Backend Six-Stage Model

**Files:**
- Modify: `tests/frontend-onboarding-analytics-model.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`

- [ ] **Step 1: Add failing v4 stage tests and complete fixture defaults**

Add `appNameMs`, `appIdMs`, and `appIconMs` as `null` defaults in `attempt()`. Update the complete v4 fixtures to provide the three timestamps and assert this exact funnel:

```ts
expect(analytics.funnels.v4).toEqual([
  { key: 'intent', label: 'Intent', reached: 4, of_start_percent: 100, dropoff_percent: 0 },
  { key: 'app_name', label: 'App name', reached: 3, of_start_percent: 75, dropoff_percent: 25 },
  { key: 'app_id', label: 'App ID', reached: 2, of_start_percent: 50, dropoff_percent: 1 / 3 * 100 },
  { key: 'app_icon', label: 'App icon', reached: 2, of_start_percent: 50, dropoff_percent: 0 },
  { key: 'organization', label: 'Organization details', reached: 2, of_start_percent: 50, dropoff_percent: 0 },
  { key: 'setup', label: 'Setup reached', reached: 2, of_start_percent: 50, dropoff_percent: 0 },
])
expect(analytics.funnels.v1.map(stage => stage.key)).toEqual(['intent', 'details', 'organization', 'setup'])
```

Add a de-duplication case where the same person has an older attempt reaching `app_icon` and a newer attempt reaching only `app_id`; assert the older, furthest attempt wins.

- [ ] **Step 2: Run the model test and verify RED**

Run: `bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts`

Expected: FAIL because `FrontendOnboardingAttempt` has no app substep fields and v4 still returns four stages.

- [ ] **Step 3: Add legacy and v4 stage definitions**

Extend the model types and definitions:

```ts
export type FrontendOnboardingStageKey
  = 'intent' | 'details' | 'app_name' | 'app_id' | 'app_icon' | 'organization' | 'setup'

export interface FrontendOnboardingAttempt {
  // existing fields
  appNameMs: number | null
  appIdMs: number | null
  appIconMs: number | null
}

const LEGACY_FUNNEL_STAGES = [
  { key: 'intent', label: 'Intent' },
  { key: 'details', label: 'App details' },
  { key: 'organization', label: 'Organization' },
  { key: 'setup', label: 'Setup reached' },
] as const

const V4_FUNNEL_STAGES = [
  { key: 'intent', label: 'Intent' },
  { key: 'app_name', label: 'App name' },
  { key: 'app_id', label: 'App ID' },
  { key: 'app_icon', label: 'App icon' },
  { key: 'organization', label: 'Organization details' },
  { key: 'setup', label: 'Setup reached' },
] as const
```

- [ ] **Step 4: Build v4-specific reach and ranking behavior**

Keep `buildLegacyFunnel()` on the existing details/organization/setup logic. Add `buildV4Funnel()` whose counts are monotonic by checking the current or any later timestamp, and make the rank version-aware:

```ts
function stageRank(attempt: FrontendOnboardingAttempt): number {
  if (isStepInFollowupWindow(attempt.setupMs, attempt.intentMs)) return attempt.onboardingVersion === 4 ? 5 : 3
  if (isStepInFollowupWindow(attempt.organizationMs, attempt.intentMs)) return attempt.onboardingVersion === 4 ? 4 : 2
  if (attempt.onboardingVersion !== 4)
    return isStepInFollowupWindow(attempt.detailsMs, attempt.intentMs) ? 1 : 0
  if (isStepInFollowupWindow(attempt.appIconMs, attempt.intentMs)) return 3
  if (isStepInFollowupWindow(attempt.appIdMs, attempt.intentMs)) return 2
  if (isStepInFollowupWindow(attempt.appNameMs, attempt.intentMs)) return 1
  return 0
}
```

Change `summarizePeriod(attempts, buildFunnel)` to accept a funnel builder, calculate completion from the final stage instead of index `3`, and use `buildV4Funnel` for current/previous v4 and v4 de-duplicated output. Keep `buildLegacyFunnel` for v1-v3.

- [ ] **Step 5: Run the model test and verify GREEN**

Run: `bunx vitest run tests/frontend-onboarding-analytics-model.unit.test.ts`

Expected: PASS with v4 returning six stages and v1-v3 returning four.

- [ ] **Step 6: Run formatting and lint checks before the first commit**

Run: `bun lint:fix && bun lint:backend`

Expected: both commands exit 0.

- [ ] **Step 7: Commit the model behavior**

```bash
git add tests/frontend-onboarding-analytics-model.unit.test.ts supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts
git commit -m "feat(analytics): expand onboarding v4 funnel stages"
```

### Task 2: Project App-Step Timestamps from PostHog

**Files:**
- Modify: `tests/frontend-onboarding-analytics.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`

- [ ] **Step 1: Add failing HogQL and mapping assertions**

Extend the mocked PostHog row with:

```ts
app_name_ms: intentMs + 500,
app_id_ms: intentMs + 1_000,
app_icon_ms: intentMs + 1_500,
```

Assert the built query includes the three `minIf` projections and the mapped v4 funnel contains the keys `['intent', 'app_name', 'app_id', 'app_icon', 'organization', 'setup']`.

- [ ] **Step 2: Run the endpoint unit test and verify RED**

Run: `bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts`

Expected: FAIL because the query and mapped attempt do not contain the new timestamps.

- [ ] **Step 3: Extend query projection and result mapping**

Add these expressions to `onboarding_attempts` and select the aliases in the final projection:

```sql
toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_name')) AS app_name_ms,
toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_id')) AS app_id_ms,
toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_icon')) AS app_icon_ms,
```

Map them with the existing nullable timestamp helper:

```ts
appNameMs: nullableMs(row.app_name_ms),
appIdMs: nullableMs(row.app_id_ms),
appIconMs: nullableMs(row.app_icon_ms),
```

- [ ] **Step 4: Run endpoint and model tests and verify GREEN**

Run: `bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the query and mapping**

```bash
git add tests/frontend-onboarding-analytics.unit.test.ts supabase/functions/_backend/utils/frontend_onboarding_analytics.ts
git commit -m "feat(analytics): query onboarding v4 app steps"
```

### Task 3: Render Six Stages in the Admin Dashboard

**Files:**
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`
- Modify: `src/services/adminFrontendOnboarding.ts`
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`

- [ ] **Step 1: Add failing frontend adapter and layout tests**

Add a six-stage v4 fixture and assert stable key-based colors and ordered conversion summaries:

```ts
expect(buildFrontendOnboardingFunnelStages(analytics.funnels.v4).map(stage => stage.label)).toEqual([
  'Intent', 'App name', 'App ID', 'App icon', 'Organization details', 'Setup reached',
])
expect(buildFrontendOnboardingFunnelSummaries(analytics.funnels.v4).map(stage => stage.reached)).toEqual([10, 9, 8, 7, 6, 5])
```

Assert the Vue source contains `xl:grid-cols-6` for the v4 summary grid while the legacy v1 summary remains four columns.

- [ ] **Step 2: Run the dashboard unit test and verify RED**

Run: `bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts`

Expected: FAIL because the stage union/colors and v4 layout support only four keys/cards.

- [ ] **Step 3: Extend frontend types and colors**

Use the same expanded stage union as the backend and add colors that preserve the blue-to-green journey:

```ts
const FUNNEL_STAGE_COLORS: Record<FrontendOnboardingStageKey, string> = {
  intent: '#119eff',
  details: '#6366f1',
  app_name: '#4f7cff',
  app_id: '#6366f1',
  app_icon: '#7c3aed',
  organization: '#8b5cf6',
  setup: '#10b981',
}
```

Do not add label-specific branching: the existing adapters must continue honoring backend order and labels.

- [ ] **Step 4: Make the v4 summary grid responsive for six cards**

Change only the v4 summary container to:

```html
<div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-3 xl:grid-cols-6 dark:border-slate-700">
```

- [ ] **Step 5: Run the dashboard unit test and verify GREEN**

Run: `bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the dashboard rendering**

```bash
git add tests/admin-frontend-onboarding-dashboard.unit.test.ts src/services/adminFrontendOnboarding.ts src/pages/admin/dashboard/frontend-onboarding.vue
git commit -m "feat(admin): render expanded onboarding v4 funnel"
```

### Task 4: Full Verification and Pull Request

**Files:**
- Verify all modified files

- [ ] **Step 1: Run backend and frontend typechecks**

Run: `bun run typecheck:backend && bun run typecheck:frontend`

Expected: both commands exit 0.

- [ ] **Step 2: Run the full unit suite**

Run: `bun test:unit`

Expected: all unit tests pass.

- [ ] **Step 3: Run the production build**

Run: `CHOKIDAR_USEPOLLING=true bun run build`

Expected: production build exits 0. If generated declarations change without semantic source changes, restore them to `HEAD` and confirm the worktree contains only intended files.

- [ ] **Step 4: Push and create the pull request**

```bash
git push -u origin wolny/onboarding-v4-app-step-funnel
gh pr create --base main --head wolny/onboarding-v4-app-step-funnel --title "feat(admin): expand onboarding v4 funnel stages" --body "## Summary (AI generated)

- expand only the onboarding v4 funnel to Intent, App name, App ID, App icon, Organization details, and Setup reached
- source the three new stages from console.capgo.app onboarding_step_viewed events and rank de-duplicated v4 attempts by the furthest expanded stage
- keep v1-v3 funnels and existing daily conversion charts unchanged

## Motivation (AI generated)

- expose where users drop off inside the app-creation portion of onboarding v4 instead of grouping those interactions into one App details stage

## Business Impact (AI generated)

- make onboarding experiments measurable at each app-creation step while preserving historical v1-v3 reporting

## Test Plan (AI generated)

- bun lint:fix
- bun lint:backend
- bun run typecheck:backend
- bun run typecheck:frontend
- bun test:unit
- CHOKIDAR_USEPOLLING=true bun run build"
```

The PR body must summarize the six-stage model, v4-only scope, PostHog source, de-duplication change, and verification commands. Do not merge the PR.

- [ ] **Step 5: Run the `pr-ready` workflow**

Observe checks, reviews, mergeability, and unresolved threads. Fix actionable findings, rerun affected local verification, push updates, and restart observation. Report stable-green only after two identical fully green observations at least five minutes apart.
