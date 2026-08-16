# Admin Chart Minimize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent minimize control to every graph in the Capgo admin dashboard.

**Architecture:** Extend the existing shared `ChartCard` with an accessible chevron toggle backed by a cached preference map in `useAdminDashboardStore`. Hydrate once from the already-loaded `main.user.onboarding`, update locally first, and serialize merged frontend writes to the signed-in user's existing row without adding any backend or Supabase schema work.

**Tech Stack:** Vue 3 Composition API, Vue Router, Vue I18n, Tailwind CSS, Vitest with happy-dom

---

### Task 1: Lock the shared card interaction with a failing test

**Files:**
- Create: `tests/admin-chart-card-collapse.unit.test.ts`

- [x] Mount `ChartCard` on an `/admin/dashboard` route and assert that the toggle is present, starts expanded, retains the title after a click, and removes graph content.
- [x] Mount it on a customer route and assert that no toggle appears.
- [x] Run `bun vitest run tests/admin-chart-card-collapse.unit.test.ts` and confirm it fails because the toggle does not exist.

### Task 2: Implement the shared minimize control

**Files:**
- Modify: `src/components/dashboard/ChartCard.vue`
- Modify: `messages/en.json`

- [x] Add route-scoped, component-local `isCollapsed` state.
- [x] Add an icon-only chevron button with translated `aria-label`, tooltip text, `aria-expanded`, focus styling, and a rotation transition.
- [x] Switch the card to a compact title-only row while collapsed and unmount the graph content.
- [x] Add the English `collapse-chart` and `expand-chart` translation keys, run `bun run i18n:contexts`, and commit the regenerated context catalog.
- [x] Re-run the focused test and confirm it passes.

### Task 3: Put custom admin graphs into the shared shell

**Files:**
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `src/pages/admin/dashboard/users.vue`

- [x] Replace both custom funnel sections and the journey graph section in `frontend-onboarding.vue` with `ChartCard`, retaining their descriptions, sizing, summaries, loading state, and data.
- [x] Replace the custom onboarding funnel section in `users.vue` with `ChartCard`, retaining its loading, empty, chart, summary, and telemetry states.

### Task 4: Verify the result

**Files:**
- Verify only

- [x] Run the focused unit test.
- [x] Run `bun lint` before the build, per repository policy.
- [x] Run `bun typecheck` and `bun run build`.
- [x] Confirm the existing production-backed server hot-reloads and inspect the admin frontend-onboarding page at desktop and mobile widths.

### Task 5: Define preference parsing, merging, and stable graph keys

**Files:**
- Create: `src/services/adminDashboardPreferences.ts`
- Create: `tests/admin-dashboard-preferences.unit.test.ts`

- [x] **Step 1: Write failing tests for safe parsing and merging**

```ts
expect(readAdminDashboardMinimize({ admin_dashboard_minimize: { users_graph: true, invalid: 'yes' } })).toEqual({ users_graph: true })
expect(withAdminDashboardMinimize({ status: 'in_progress' }, { users_graph: false })).toEqual({ status: 'in_progress', admin_dashboard_minimize: { users_graph: false } })
expect(preserveAdminDashboardMinimize({ status: 'completed' }, existing, false)).toEqual({ status: 'completed' })
```

- [x] **Step 2: Run the focused test and verify the missing-module failure**

Run: `bun vitest run tests/admin-dashboard-preferences.unit.test.ts`
Expected: FAIL because `src/services/adminDashboardPreferences.ts` does not exist.

- [x] **Step 3: Implement the pure preference helpers**

```ts
export type AdminDashboardMinimize = Record<string, boolean>

export function readAdminDashboardMinimize(onboarding: Json | undefined): AdminDashboardMinimize
export function withAdminDashboardMinimize(onboarding: Json, preferences: AdminDashboardMinimize): Json
export function preserveAdminDashboardMinimize(next: Json, current: Json | undefined, isAdmin: boolean): Json
export function createAdminDashboardChartPreferenceKey(routePath: string, title: string): string
```

The key must combine a compact route slug, compact title slug, and deterministic hash so all current graphs remain comfortably below the existing 8 KB onboarding limit.

- [x] **Step 4: Re-run the helper test**

Run: `bun vitest run tests/admin-dashboard-preferences.unit.test.ts`
Expected: PASS.

### Task 6: Cache and write preferences from the admin dashboard store

**Files:**
- Modify: `src/stores/adminDashboard.ts`
- Create: `tests/admin-dashboard-minimize-store.unit.test.ts`

- [x] **Step 1: Write failing store tests**

Cover one-time hydration from `main.user.onboarding`, optimistic cache updates, preservation of unrelated onboarding keys, serialized `.from('users').update(...).eq('id', userId)` writes, and a no-op for `main.isAdmin === false`.

- [x] **Step 2: Run the store test and verify failure**

Run: `bun vitest run tests/admin-dashboard-minimize-store.unit.test.ts`
Expected: FAIL because the store has no minimize preference actions.

- [x] **Step 3: Add the cached store state and actions**

```ts
const adminDashboardMinimize = ref<AdminDashboardMinimize>({})
const adminDashboardMinimizeUserId = ref<string | null>(null)
let adminDashboardMinimizeWriteChain = Promise.resolve()

function isChartMinimized(key: string): boolean
function setChartMinimized(key: string, minimized: boolean): Promise<void>
```

`setChartMinimized` must update the Pinia map and `main.user.onboarding` synchronously, then enqueue a merged frontend Supabase update. It must not select or refetch after writing.

- [x] **Step 4: Re-run the store test**

Run: `bun vitest run tests/admin-dashboard-minimize-store.unit.test.ts`
Expected: PASS.

### Task 7: Connect every admin ChartCard and preserve preferences during onboarding saves

**Files:**
- Modify: `src/components/dashboard/ChartCard.vue`
- Modify: `src/components/dashboard/AppOnboardingFlow.vue`
- Modify: `tests/admin-chart-card-collapse.unit.test.ts`

- [x] **Step 1: Extend the component test with persisted initial state and write-through assertions**

Mount with an admin main store whose onboarding contains the generated graph key set to `true`; assert the chart begins minimized. Expand it and assert the local map changes to `false` and a merged users update is issued.

- [x] **Step 2: Run the component test and verify failure**

Run: `bun vitest run tests/admin-chart-card-collapse.unit.test.ts`
Expected: FAIL because `ChartCard` still owns a component-local ref.

- [x] **Step 3: Replace local state with the admin dashboard store**

```ts
const preferenceKey = computed(() => props.preferenceKey || createAdminDashboardChartPreferenceKey(route.path, props.title))
const isCollapsed = computed(() => adminDashboard.isChartMinimized(preferenceKey.value))

function toggleCollapsed() {
  void adminDashboard.setChartMinimized(preferenceKey.value, !isCollapsed.value)
}
```

- [x] **Step 4: Preserve admin preferences in onboarding progress writes**

```ts
const onboarding = preserveAdminDashboardMinimize(
  progress as unknown as Json,
  main.user?.onboarding,
  main.isAdmin,
)
```

- [x] **Step 5: Run all focused tests**

Run: `bun vitest run tests/admin-dashboard-preferences.unit.test.ts tests/admin-dashboard-minimize-store.unit.test.ts tests/admin-chart-card-collapse.unit.test.ts`
Expected: PASS.

### Task 8: Verify frontend-only scope and production build

**Files:**
- Verify only

- [x] Confirm `git diff -- supabase` is empty.
- [x] Run `bun lint` before build, per repository policy.
- [x] Run `bun typecheck`.
- [x] Run `CHOKIDAR_USEPOLLING=true bun run build`.
- [x] Reload the production-backed admin dashboard, toggle a graph, and confirm the request updates only the signed-in user's `public.users.onboarding` while the graph remains responsive.
