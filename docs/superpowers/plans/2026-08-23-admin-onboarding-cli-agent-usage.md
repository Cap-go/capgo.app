# Admin Onboarding CLI Agent Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily stacked admin-onboarding chart that assigns every v2–v4 Setup person-day to No CLI invoked, No agent, one detected agent, Multiple agents, or Unknown agent.

**Architecture:** Extend the existing bounded PostHog Setup/CLI event adapter with normalized agent fields, then refactor the pure daily Setup model so existing CLI outcomes and new agent classification share the same latest-anchor attribution. Return dynamic agent groups and daily counts from the existing admin analytics response, map them to stable chart series in the frontend service, and render a new card immediately below the current daily CLI-outcomes card.

**Tech Stack:** TypeScript, Hono/Deno backend utilities, PostHog HogQL, Vue 3, Chart.js, Vitest, Bun

**Design spec:** `docs/superpowers/specs/2026-08-23-admin-onboarding-cli-agent-usage-design.md`

---

## File map

### Modified files

- `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts` — project and validate `agent_invoker`, `agent_identity.id`, and `agent_identity.name` on CLI rows.
- `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts` — share Setup anchoring, collect agent identities per anchor, and produce deterministic daily agent groups/counts.
- `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts` — append `daily_setup_cli_agent_usage` to the existing response.
- `src/services/adminFrontendOnboarding.ts` — define the new response types and map dynamic groups to stable stacked-bar series.
- `src/pages/admin/dashboard/frontend-onboarding.vue` — render the new graph after the current daily CLI-outcomes graph.
- `messages/en.json` — title, description, and reserved-group labels.
- `messages/en.context.json` — generated translation context for the new labels.
- `tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts` — HogQL projection and normalized-row validation.
- `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts` — classification, attribution, no-double-counting, zero filling, and deterministic order.
- `tests/frontend-onboarding-analytics.unit.test.ts` — response integration.
- `tests/admin-frontend-onboarding-dashboard.unit.test.ts` — series mapping, colors, translations, and card placement.

No migration, new PostHog request, new chart component, or CLI change is required.

---

### Task 1: Capture agent fields in the existing bounded PostHog adapter

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts`
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts`
- Test: `tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts`

- [ ] **Step 1: Add failing projection and row-mapping tests**

Extend the HogQL projection assertion with:

```ts
expect(selectedProjection).toContain("if(selected_events.event = 'CLI Command Invoked', JSONExtractBool(toString(selected_events.properties), 'agent_invoker'), false) AS agent_invoker")
expect(selectedProjection).toContain("JSONExtractString(toString(selected_events.properties.agent_identity), 'id') AS agent_id")
expect(selectedProjection).toContain("JSONExtractString(toString(selected_events.properties.agent_identity), 'name') AS agent_name")
```

Add adapter cases whose PostHog rows map to:

```ts
{
  personId: 'person-agent',
  timestampMs: 1_787_500_000_000,
  kind: 'cli_command',
  commandPath: 'app list',
  agentInvoker: true,
  agentId: 'codex',
  agentName: 'Codex',
}
```

and an older CLI row with absent agent columns mapping to `agentInvoker: false` and no identity fields. Add invalid cases for non-Boolean `agent_invoker`, non-string IDs, and non-string names; each must reject through `frontend_onboarding_daily_setup_cli_invalid_row`.

- [ ] **Step 2: Run the adapter test and verify failure**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
```

Expected: FAIL because the query and normalized event type do not contain agent fields.

- [ ] **Step 3: Extend the normalized CLI event contract**

Update `FrontendOnboardingDailySetupCliEvent`:

```ts
export interface FrontendOnboardingDailySetupCliEvent {
  personId: string
  timestampMs: number
  kind: FrontendOnboardingDailySetupCliEventKind
  commandPath?: string
  agentInvoker?: boolean
  agentId?: string
  agentName?: string
}
```

For CLI rows, `mapEvent` must validate agent columns and return trimmed optional identities:

```ts
const agentInvoker = row.agent_invoker ?? false
if (typeof agentInvoker !== 'boolean')
  throw new Error(INVALID_ROW_ERROR)

const agentId = row.agent_id === undefined || row.agent_id === null ? '' : row.agent_id
const agentName = row.agent_name === undefined || row.agent_name === null ? '' : row.agent_name
if (typeof agentId !== 'string' || typeof agentName !== 'string')
  throw new Error(INVALID_ROW_ERROR)

return {
  personId,
  timestampMs: timestamp,
  kind,
  commandPath: commandPath.trim(),
  agentInvoker,
  ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
  ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
}
```

- [ ] **Step 4: Add agent projections without broadening the query**

Add these columns after `command_path` while preserving the existing cohort, time range, total count, order, and limit:

```sql
if(
  selected_events.event = 'CLI Command Invoked',
  JSONExtractBool(toString(selected_events.properties), 'agent_invoker'),
  false
) AS agent_invoker,
if(
  selected_events.event = 'CLI Command Invoked',
  JSONExtractString(toString(selected_events.properties.agent_identity), 'id'),
  ''
) AS agent_id,
if(
  selected_events.event = 'CLI Command Invoked',
  JSONExtractString(toString(selected_events.properties.agent_identity), 'name'),
  ''
) AS agent_name,
```

- [ ] **Step 5: Run the adapter test**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the adapter change**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
git commit -m "feat(admin): capture onboarding CLI agent identities"
```

---

### Task 2: Classify every Setup anchor into one agent-usage group

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts`
- Test: `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts`

- [ ] **Step 1: Add failing table-driven classification tests**

Add cases covering these exact outputs:

```ts
expect(classify([{ kind: 'setup' }])).toBe('no_cli_invoked')
expect(classify([{ kind: 'setup' }, cli({ agentInvoker: false })])).toBe('no_agent')
expect(classify([{ kind: 'setup' }, cli({ agentInvoker: true, agentId: 'codex', agentName: 'Codex' })])).toBe('agent:codex')
expect(classify([
  { kind: 'setup' },
  cli({ agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
  cli({ agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
])).toBe('agent:codex')
expect(classify([
  { kind: 'setup' },
  cli({ agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
  cli({ agentInvoker: true, agentId: 'claude', agentName: 'Claude Code' }),
])).toBe('multiple_agents')
expect(classify([{ kind: 'setup' }, cli({ agentInvoker: true })])).toBe('unknown_agent')
expect(classify([
  { kind: 'setup' },
  cli({ agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
  cli({ agentInvoker: true }),
])).toBe('multiple_agents')
```

Also assert that an event after a newer Setup anchor cannot alter the older day, daily counts sum to existing Setup person-day totals, and empty UTC dates remain in `points`.

- [ ] **Step 2: Run the model test and verify failure**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
```

Expected: FAIL because the agent-usage builder does not exist.

- [ ] **Step 3: Add agent state to the shared internal anchor**

Use one internal anchor for both existing CLI outcomes and the new metric:

```ts
interface FrontendOnboardingDailySetupCliAgentSignals {
  cliInvoked: boolean
  unknownAgentInvoked: boolean
  agents: Map<string, string>
}

interface FrontendOnboardingDailySetupCliAnchor {
  personId: string
  timestampMs: number
  date: string
  lifecycle: FrontendOnboardingDailySetupCliLifecycle | undefined
  signals: FrontendOnboardingDailySetupCliSignals
  agentSignals: FrontendOnboardingDailySetupCliAgentSignals
}
```

When a CLI event is assigned through the existing latest-anchor window:

```ts
anchor.agentSignals.cliInvoked = true
if (event.agentInvoker) {
  if (event.agentId)
    anchor.agentSignals.agents.set(event.agentId, event.agentName || event.agentId)
  else
    anchor.agentSignals.unknownAgentInvoked = true
}
```

Factor normalization, anchor creation, lifecycle assignment, and action attribution into one private builder used by both public aggregators. Do not duplicate the ownership-window algorithm.

- [ ] **Step 4: Implement deterministic agent aggregation**

Export these types and builder:

```ts
export interface FrontendOnboardingDailySetupCliAgentGroup {
  key: string
  agent_id?: string
  agent_name?: string
}

export interface FrontendOnboardingDailySetupCliAgentPoint {
  date: string
  counts: Record<string, number>
}

export interface FrontendOnboardingDailySetupCliAgentUsage {
  groups: FrontendOnboardingDailySetupCliAgentGroup[]
  points: FrontendOnboardingDailySetupCliAgentPoint[]
}

export function buildFrontendOnboardingDailySetupCliAgentUsage(
  events: readonly FrontendOnboardingDailySetupCliEvent[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailySetupCliAgentUsage
```

Classification must use:

```ts
if (!signals.cliInvoked)
  return 'no_cli_invoked'
if (signals.agents.size === 0)
  return signals.unknownAgentInvoked ? 'unknown_agent' : 'no_agent'
if (signals.agents.size > 1 || signals.unknownAgentInvoked)
  return 'multiple_agents'
return `agent:${signals.agents.keys().next().value}`
```

Sort detected groups by descending range total, then agent name, then key. Append active reserved groups in this order: `multiple_agents`, `unknown_agent`, `no_agent`, `no_cli_invoked`.

- [ ] **Step 5: Run both model suites**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the shared model**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
git commit -m "feat(admin): classify onboarding CLI agent usage"
```

---

### Task 3: Return agent usage from the admin analytics endpoint

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts`
- Test: `tests/frontend-onboarding-analytics.unit.test.ts`

- [ ] **Step 1: Add a failing response integration assertion**

Extend the existing analytics fixture with one Setup row and a Codex CLI row, then assert:

```ts
expect(result.daily_setup_cli_agent_usage).toEqual({
  groups: [{ key: 'agent:codex', agent_id: 'codex', agent_name: 'Codex' }],
  points: [{ date: '2026-08-10', counts: { 'agent:codex': 1 } }],
})
```

Keep the existing `daily_setup_cli_outcomes` assertion unchanged.

- [ ] **Step 2: Run the integration test and verify failure**

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: FAIL because `daily_setup_cli_agent_usage` is missing.

- [ ] **Step 3: Build both metrics from the same normalized rows**

Import `buildFrontendOnboardingDailySetupCliAgentUsage`, calculate it beside the existing outcome builder, and return it:

```ts
const dailySetupCliOutcomes = buildFrontendOnboardingDailySetupCliOutcomes(dailySetupCliEvents, startMs, endMs)
const dailySetupCliAgentUsage = buildFrontendOnboardingDailySetupCliAgentUsage(dailySetupCliEvents, startMs, endMs)

return {
  ...analytics,
  daily_setup_cli_outcomes: dailySetupCliOutcomes,
  daily_setup_cli_agent_usage: dailySetupCliAgentUsage,
  // existing fields remain unchanged
}
```

- [ ] **Step 4: Run backend analytics tests**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit endpoint integration**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics.ts tests/frontend-onboarding-analytics.unit.test.ts
git commit -m "feat(admin): expose onboarding CLI agent usage"
```

---

### Task 4: Map dynamic agent groups to stable chart series

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts`
- Test: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Add failing service tests**

Create a fixture containing Codex, Multiple agents, No agent, and No CLI invoked across two dates. Assert that `buildFrontendOnboardingDailySetupCliAgentSeries`:

- returns one series per active group in backend order;
- displays `agent_name`, falling back to `agent_id`;
- uses translated labels for reserved keys;
- preserves both dates and zero values;
- produces the same color for the same key across calls;
- retains No CLI invoked when it is the only active group.

- [ ] **Step 2: Run the dashboard service test and verify failure**

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the response types and mapper are absent.

- [ ] **Step 3: Add API types and the deterministic mapper**

Add the response interfaces from Task 2 to `FrontendOnboardingAnalytics` as `daily_setup_cli_agent_usage`. Export:

```ts
export function buildFrontendOnboardingDailySetupCliAgentSeries(
  usage: FrontendOnboardingDailySetupCliAgentUsage | null | undefined,
  reservedLabels: Record<'multiple_agents' | 'unknown_agent' | 'no_agent' | 'no_cli_invoked', string>,
): FrontendOnboardingDailySeries[]
```

Use fixed colors for reserved groups and common agents, then a deterministic fallback palette:

```ts
const AGENT_GROUP_COLORS: Record<string, string> = {
  'agent:codex': '#10a37f',
  'agent:claude-code': '#d97757',
  multiple_agents: '#8b5cf6',
  unknown_agent: '#f59e0b',
  no_agent: '#3b82f6',
  no_cli_invoked: '#94a3b8',
}
```

The mapper must use backend group order and `points.map(point => ({ date: point.date, value: point.counts[group.key] ?? 0 }))`.

- [ ] **Step 4: Run the service test**

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the frontend model**

```bash
git add src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): map CLI agent usage chart data"
```

---

### Task 5: Render the graph and translations

**Files:**
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue`
- Modify: `messages/en.json`
- Modify: `messages/en.context.json`
- Test: `tests/admin-frontend-onboarding-dashboard.unit.test.ts`

- [ ] **Step 1: Add failing placement and translation assertions**

Assert that the page contains a new card ID `daily-setup-cli-agent-usage-v2-v4`, uses `AdminStackedBarChart`, and that its source position is after `daily-setup-cli-outcomes-v2-v4` but before `funnel-v1-legacy`. Assert the English messages include:

```json
{
  "frontend-onboarding-daily-setup-cli-agent-usage-v2-v4": "Daily Setup → CLI agent usage (v2–v4)",
  "frontend-onboarding-cli-agent-multiple": "Multiple agents",
  "frontend-onboarding-cli-agent-unknown": "Unknown agent",
  "frontend-onboarding-cli-agent-none": "No agent",
  "frontend-onboarding-cli-agent-no-cli": "No CLI invoked"
}
```

- [ ] **Step 2: Run the dashboard test and verify failure**

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the card and messages do not exist.

- [ ] **Step 3: Add computed series and valid-data detection**

```ts
const dailySetupCliAgentSeries = computed(() => buildFrontendOnboardingDailySetupCliAgentSeries(
  visibleAnalytics.value?.daily_setup_cli_agent_usage,
  {
    multiple_agents: t('frontend-onboarding-cli-agent-multiple'),
    unknown_agent: t('frontend-onboarding-cli-agent-unknown'),
    no_agent: t('frontend-onboarding-cli-agent-none'),
    no_cli_invoked: t('frontend-onboarding-cli-agent-no-cli'),
  },
))
const hasDailySetupCliAgentData = computed(() => dailySetupCliAgentSeries.value.length > 0)
```

- [ ] **Step 4: Add the card directly below the existing daily card**

```vue
<ChartCard
  chart-id="daily-setup-cli-agent-usage-v2-v4"
  :title="t('frontend-onboarding-daily-setup-cli-agent-usage-v2-v4')"
  :is-loading="isLoadingStats"
  :has-data="hasDailySetupCliAgentData"
>
  <template #header>
    <div class="min-w-0">
      <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
        {{ t('frontend-onboarding-daily-setup-cli-agent-usage-v2-v4') }}
      </h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {{ t('frontend-onboarding-daily-setup-cli-agent-usage-description') }}
      </p>
    </div>
  </template>
  <AdminStackedBarChart
    :series="dailySetupCliAgentSeries"
    :is-loading="isLoadingStats"
    accessible-borders
  />
</ChartCard>
```

Add the title, description, and four reserved labels to `messages/en.json`, then regenerate their context entries:

```bash
bun run i18n:contexts
```

- [ ] **Step 5: Run focused tests, lint, typecheck, and build**

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
bun run i18n:contexts
bun lint
bun typecheck
bun build
```

Expected: every command exits 0.

- [ ] **Step 6: Commit the dashboard graph**

```bash
git add src/pages/admin/dashboard/frontend-onboarding.vue messages/en.json messages/en.context.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): chart onboarding CLI agent usage"
```

---

### Task 6: Final verification and pull request

**Files:**
- Verify all changed files from Tasks 1–5.

- [ ] **Step 1: Run final repository checks**

```bash
bun lint
bun typecheck
bun build
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts tests/frontend-onboarding-analytics.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git diff --check origin/main...HEAD
git status --short
```

Expected: all checks pass and the working tree is clean.

- [ ] **Step 2: Push the branch and create the PR**

```bash
git push -u origin wolny/admin-onboarding-cli-agents
gh pr create --repo Cap-go/capgo.app --base main --head wolny/admin-onboarding-cli-agents --title "feat(admin): chart onboarding CLI agent usage" --body-file /tmp/admin-onboarding-cli-agent-pr.md
```

The PR body must summarize the shared onboarding attribution, classification groups, chart placement, and exact verification commands.

- [ ] **Step 3: Drive the PR to stable green**

Inspect required checks, reviews, unresolved threads, and mergeability. After the first fully green observation, wait at least five minutes, re-fetch the unchanged head/base and remote gates, and record the second stable-green observation before handoff.
