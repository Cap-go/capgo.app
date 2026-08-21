# Onboarding v4 Welcome Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a v4-only daily Welcome-screen outcomes chart with raw-attempt and best-attempt-per-user views to the admin frontend-onboarding dashboard.

**Architecture:** Keep the existing Intent-rooted analytics untouched. Add a focused pure model and a dedicated bounded HogQL query that run through the existing endpoint, then adapt the additive response fields into the existing stacked-column and de-duplication components.

**Tech Stack:** TypeScript, Hono, PostHog HogQL, Vue 3, Chart.js, Vue I18n, Vitest, Bun

---

### Task 1: Build the pure Welcome-outcomes model

**Files:**
- Create: `supabase/functions/_backend/utils/frontend_onboarding_welcome_outcomes_model.ts`
- Create: `tests/frontend-onboarding-welcome-outcomes-model.unit.test.ts`

- [ ] **Step 1: Write failing classification and de-duplication tests**

Create attempts covering Welcome-to-Intent, Intent without Welcome, Welcome-only, the inclusive 24-hour boundary, Intent before Welcome, UTC anchoring, the four approved cross-day winner examples, tie-breakers, and missing person IDs. Assert the raw and de-duplicated daily points:

```ts
expect(result.daily).toEqual([{
  date: '2026-08-01',
  welcome_advanced_to_intent: 1,
  welcome_not_viewed: 1,
  welcome_did_not_advance: 1,
}])
expect(result.deduplicated).toEqual(expectedBestAttempts)
```

- [ ] **Step 2: Run the model test and verify RED**

Run:

```bash
bunx vitest run tests/frontend-onboarding-welcome-outcomes-model.unit.test.ts
```

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Implement the focused model**

Define the normalized input and daily output:

```ts
export interface FrontendOnboardingWelcomeAttempt {
  attemptId: string
  personId: string
  welcomeMs: number | null
  intentMs: number | null
}

export interface FrontendOnboardingDailyWelcomeOutcome {
  date: string
  welcome_advanced_to_intent: number
  welcome_not_viewed: number
  welcome_did_not_advance: number
}
```

Implement `buildFrontendOnboardingWelcomeOutcomes(attempts, startMs, endMs)` with an inclusive 24-hour window, Welcome-first anchor selection, zero-filled UTC days, and best-attempt ranking `advanced > no Welcome > Welcome-only`. Use latest anchor and greatest attempt ID tie-breakers; namespace missing identities by attempt ID.

- [ ] **Step 4: Run the model test and verify GREEN**

Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 5: Commit the pure model**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_welcome_outcomes_model.ts tests/frontend-onboarding-welcome-outcomes-model.unit.test.ts
git commit -m "feat(admin): model onboarding welcome outcomes"
```

### Task 2: Add the dedicated HogQL query and endpoint response

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts`
- Modify: `tests/frontend-onboarding-analytics.unit.test.ts`

- [ ] **Step 1: Write failing HogQL and endpoint tests**

Add assertions for a new exported `buildFrontendOnboardingWelcomeHogql`:

```ts
expect(query).toContain("event = 'onboarding_step_viewed'")
expect(query).toContain("toIntOrZero(toString(properties.onboarding_version)) = 4")
expect(query).toContain("JSONExtractString(toString(properties), 'flow') = 'pre_org'")
expect(query).toContain("JSONExtractString(toString(properties), '$host') = 'console.capgo.app'")
expect(query).toContain("step IN ('welcome', 'intent')")
expect(query).toContain('count() OVER () AS total_attempts')
expect(query).toContain('LIMIT 50000')
```

Extend endpoint tests so the third parallel PostHog result contains normalized Welcome rows. Assert `daily_welcome_outcomes`, `deduplicated.daily_welcome_outcomes`, three PostHog calls, boundary dates, malformed-row rejection, all-or-nothing failure, and total-limit validation.

- [ ] **Step 2: Run backend analytics tests and verify RED**

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: FAIL because the query and response fields do not exist.

- [ ] **Step 3: Implement the query, mapper, and endpoint integration**

Add a mapper that accepts a non-empty attempt ID plus at least one positive Welcome or Intent timestamp. Build a grouped query with first timestamps and an anchor-range `HAVING` clause. Add the query as the third `Promise.all` member after the existing two calls so current mocks retain their ordering.

Build both outcome variants through the Task 1 model and return:

```ts
return {
  ...analytics,
  daily_welcome_outcomes: welcomeOutcomes.daily,
  deduplicated: {
    ...analytics.deduplicated,
    daily_welcome_outcomes: welcomeOutcomes.deduplicated,
  },
  daily_setup_cli_outcomes: dailySetupCliOutcomes,
  posthog_configured: posthog.configured,
  posthog_connected: posthog.connected,
}
```

Validate the Welcome query connection and total metadata with the existing fail-closed behavior and logging.

- [ ] **Step 4: Run backend analytics and model tests and verify GREEN**

```bash
bunx vitest run tests/frontend-onboarding-welcome-outcomes-model.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the backend integration**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics.ts supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts tests/frontend-onboarding-analytics.unit.test.ts
git commit -m "feat(admin): query onboarding welcome outcomes"
```

### Task 3: Add frontend response types and chart adapter

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Write a failing series-adapter test**

Extend the analytics fixture with raw and de-duplicated daily Welcome outcomes. Import and test `buildFrontendOnboardingDailyWelcomeOutcomeSeries`:

```ts
expect(buildFrontendOnboardingDailyWelcomeOutcomeSeries(points, labels)).toEqual([
  { label: labels.advanced, color: '#10b981', data: [{ date: '2026-08-10', value: 4 }] },
  { label: labels.notViewed, color: '#f59e0b', data: [{ date: '2026-08-10', value: 2 }] },
  { label: labels.didNotAdvance, color: '#f43f5e', data: [{ date: '2026-08-10', value: 1 }] },
])
```

- [ ] **Step 2: Run the dashboard unit test and verify RED**

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the response types and adapter do not exist.

- [ ] **Step 3: Add additive types and the pure adapter**

Add `FrontendOnboardingDailyWelcomeOutcomePoint`, the two response fields, and a label interface. Implement the adapter with the approved emerald, amber, and rose series order and absolute values.

- [ ] **Step 4: Run the dashboard unit test and verify GREEN**

Run the Step 2 command. Expected: all adapter tests pass.

- [ ] **Step 5: Commit frontend data support**

```bash
git add src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): adapt welcome outcome chart data"
```

### Task 4: Render the Welcome outcomes card

**Files:**
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `messages/en.json`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Write failing dashboard structure tests**

Assert the page contains:

```ts
expect(source).toContain('const deduplicateWelcomeOutcomes = ref(false)')
expect(source).toContain('visibleAnalytics.value?.deduplicated.daily_welcome_outcomes')
expect(source).toContain('buildFrontendOnboardingDailyWelcomeOutcomeSeries')
expect(template.indexOf('chart-id="funnel-v4"')).toBeLessThan(template.indexOf('chart-id="welcome-outcomes-v4"'))
expect(template.indexOf('chart-id="welcome-outcomes-v4"')).toBeLessThan(template.indexOf('chart-id="daily-intent-to-details"'))
```

Also assert the new response arrays are validated and toggling is local by preserving one loader call site.

- [ ] **Step 2: Run the dashboard unit test and verify RED**

Run the Task 3 Step 2 command. Expected: FAIL on missing page wiring.

- [ ] **Step 3: Wire the card, control, and translations**

Add computed raw/de-duplicated points, chart series, and `hasWelcomeOutcomeData`. Insert a full-width `ChartCard` immediately after `funnel-v4` with a header description explaining the provisional 24-hour window:

```vue
<AdminStackedBarChart
  :series="welcomeOutcomeSeries"
  :is-loading="isLoadingStats"
  accessible-borders
/>
<AdminChartDeduplicateControl
  v-model="deduplicateWelcomeOutcomes"
  :chart-label="t('frontend-onboarding-welcome-outcomes-v4')"
/>
```

Add translation keys for the chart title, description, and three exact category labels. Extend the analytics response guard to require both raw and de-duplicated arrays.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
bunx vitest run tests/frontend-onboarding-welcome-outcomes-model.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Run repository completion gates**

```bash
bun lint
bun run typecheck:backend
bun run typecheck:frontend
bun build
bun test:unit
```

Expected: all commands exit successfully.

- [ ] **Step 6: Commit the rendered chart**

```bash
git add src/pages/admin/dashboard/frontend-onboarding.vue messages/en.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): show onboarding welcome outcomes"
```

### Task 5: Publish and stabilize the pull request

**Files:**
- No additional source files expected.

- [ ] **Step 1: Review the complete diff**

```bash
git diff origin/main...HEAD --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no unintended files, and only the planned commits.

- [ ] **Step 2: Push the branch and open the PR**

Push `wolny/onboarding-v4-welcome-outcomes` and open a non-draft PR against `main` with a conventional title that does not start with `[CODEX]`.

- [ ] **Step 3: Run the `pr-ready` workflow**

Inspect checks, reviews, requested reviewers, unresolved conversations, mergeability, and repository requirements for the current head SHA. Address actionable failures, then establish two fully green observations at least five minutes apart with unchanged head and base SHAs.
