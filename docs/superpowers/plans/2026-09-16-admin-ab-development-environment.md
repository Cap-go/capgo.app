# A/B Development Environment Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the five app-building answer buckets for unique development-environment treatment C users on the admin A/B Tests page.

**Architecture:** Add a dedicated replica-backed statistic behind the existing platform-admin endpoint. Validate its five-bucket response on the frontend and reuse the existing horizontal-progress-card pattern. Do not change experiments, schema, onboarding, or other metrics.

**Tech Stack:** Vue 3, TypeScript, Hono, PostgreSQL, Vitest, Tailwind and DaisyUI.

## Task 1: Implement and integrate the chart

**Files:**
- Create `supabase/functions/_backend/utils/ab_test_development_environment.ts` for the treatment-only read and bucket aggregation.
- Modify `supabase/functions/_backend/private/admin_stats.ts` for the new `ab_test_development_environment` category and dispatch.
- Create `src/services/adminABTestDevelopmentEnvironment.ts` for the response type, strict parser and percentage calculation.
- Create `src/components/admin/AdminABTestDevelopmentEnvironment.vue` for the accessible five-row horizontal card.
- Modify `src/stores/adminDashboard.ts` to extend `MetricCategory`.
- Modify `src/pages/admin/dashboard/ab-tests.vue` to load, parse and render the new card with existing loading/retry behavior.
- Modify `messages/en.json` for chart copy.
- Create `tests/admin-ab-test-development-environment.unit.test.ts` for backend behavior and `tests/admin-ab-test-development-environment-dashboard.unit.test.ts` for parsing, rendering, integration and copy.

- [ ] Write tests first. Assert stable order `ai_assistant`, `hosted_builder`, `other`, `hand_coded`, `no_selection_yet`; empty input produces five zero buckets; string DB counts normalize; invalid counts cannot produce misleading data. Check treatment-only query parameters, replica connection and cleanup after query failure. Check malformed frontend payloads (duplicates, missing bucket, unsafe count, mismatched total) return null, and the real Vue card renders five labelled progress bars and count/percentage text, including zero-data behavior.

```ts
expect(buildAdminABTestDevelopmentEnvironment([{ outcome: 'ai_assistant', people: '2' }])).toEqual({
  total: 2,
  outcomes: [
    { outcome: 'ai_assistant', count: 2 },
    { outcome: 'hosted_builder', count: 0 },
    { outcome: 'other', count: 0 },
    { outcome: 'hand_coded', count: 0 },
    { outcome: 'no_selection_yet', count: 0 },
  ],
})
```

- [ ] Run targeted Vitest tests and confirm failures identify the missing implementation.

```sh
bunx vitest run tests/admin-ab-test-development-environment.unit.test.ts tests/admin-ab-test-development-environment-dashboard.unit.test.ts
```

- [ ] Implement the backend read using a single aggregation over indexed assigned users. Read the configured treatment branch from `AB_TESTS_CONFIG.webnativeapp_development_environment`; throw if configuration is absent. Use `getPgClient(c, true)` and always `closeClient` in finally. The query uses parameter `$1` containing JSON `{webnativeapp_development_environment:{branch:'C'}}` and `$2` containing the four recognized answers:

```sql
SELECT CASE
  WHEN user_account.onboarding ->> 'development_environment' = ANY($2::text[])
    THEN user_account.onboarding ->> 'development_environment'
  ELSE 'no_selection_yet'
END AS outcome, count(*)::bigint AS people
FROM public.users AS user_account
WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb
GROUP BY 1
```

- [ ] Implement the strict response parser, requiring exactly five unique recognized buckets and nonnegative safe-integer counts whose sum equals the safe-integer total. Restore stable display order. Export a percentage helper with zero-total behavior and one-decimal rounding:

```ts
return total === 0 ? 0 : Math.round((count / total) * 1_000) / 10
```

- [ ] Implement the card with localized labels, a total-person count, counts and percentages, native labelled progress elements, responsive current dashboard styling and an explicit empty-data message. Include notes that AI assistant includes Claude and that the unavailable-answer bucket includes skipped/legacy answers.

```vue
<progress :aria-label="t(outcomeLabels[item.outcome])" :value="item.count" :max="Math.max(outcome.total, 1)" class="d-progress h-3 w-full" />
```

- [ ] Integrate the statistic with existing fetch/parse/error handling and render after the Publish intent outcome card:

```ts
adminStore.fetchStats('ab_test_development_environment', forceRefresh)
```

```vue
<AdminABTestDevelopmentEnvironment v-if="developmentEnvironment" :outcome="developmentEnvironment" />
```

- [ ] Run project lint, targeted tests, self-review and report the exact changed files and red/green evidence. Keep schema dumps, generated runtime code, release fields and unrelated changes untouched. Commit only the intended feature files after verification.

## Task 2: Review, verify and open the PR

- [ ] Perform independent spec review followed by code-quality review; fix actionable findings and re-review before finishing.
- [ ] Run `bun lint`, `bun lint:backend`, `bun typecheck`, `bun test:unit`, and `bun build`; investigate failures rather than assuming pass.
- [ ] Refresh repository graph using `bun run graphify:generate` and inspect generated changes.
- [ ] Exercise the real admin page/card with controlled, clearly fake responses and capture desktop/mobile screenshots. Do not use private customer data in the public PR.
- [ ] Push `wolny/admin-ab-development-environment`, open a draft PR against `main` using required AI-marked Summary, Motivation, Business Impact and Test Plan sections, and include visual proof. Wait for green CI, mark ready, and address automatic review as required by repository lifecycle.
- [ ] Run pr-ready against fresh GitHub checks, reviews, conversations, rules, head/base SHAs and mergeability. Record two passing observations at least 300 seconds apart on unchanged state; otherwise report the precise pending gate without claiming stable-green.
