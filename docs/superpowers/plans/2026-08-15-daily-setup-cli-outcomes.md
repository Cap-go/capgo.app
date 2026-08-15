# Daily Setup → CLI Outcomes (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily paired-stack chart that classifies each v2 Setup person-day into one of 12 CLI/copy outcomes while preserving the existing aggregate chart.

**Architecture:** A dedicated PostHog adapter returns bounded, normalized Setup/copy/CLI events for people who reached Setup in the selected range. A pure TypeScript model owns UTC-day anchoring, First-time/Returning classification, latest-anchor attribution, 12-way outcome classification, and zero filling. The existing admin endpoint adds the resulting field, while `AdminStackedBarChart` gains optional grouped-stack behavior used by a new dashboard card.

**Tech Stack:** TypeScript, Hono/Deno backend utilities, PostHog HogQL, Vue 3, Chart.js, vue-chartjs, Vitest, Bun

**Design spec:** `docs/superpowers/specs/2026-08-15-daily-setup-cli-outcomes-design.md`

---

## File map

### New files

- `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts` — typed event model, UTC person-day anchoring, action attribution, outcome classification, and daily aggregation.
- `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts` — dedicated HogQL builder, total validation, row parsing, PostHog failure handling, and limit logging.
- `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts` — pure business-rule coverage for all outcomes, repeat views, lifecycle, attribution, boundaries, and zero filling.
- `tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts` — HogQL, parsing, query failure, and event-limit coverage.

### Modified files

- `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts` — run the existing and new PostHog reads together and append `daily_setup_cli_outcomes` without changing `v2_setup_cli_outcomes`.
- `tests/frontend-onboarding-analytics.unit.test.ts` — cover two-query orchestration, the +24-hour daily boundary, response integration, and failure behavior.
- `src/components/admin/adminStackedBarChart.ts` — optional stack metadata, grouped tooltip totals, dynamic deduplicated legend generation, and grouped legend toggling.
- `src/components/admin/AdminStackedBarChart.vue` — pass optional stack metadata and select grouped options only when grouped data is present.
- `tests/admin-stacked-bar-chart.unit.test.ts` — grouped data, stack-scoped tooltips, zero-only legend filtering, deduplication, toggling, and legacy behavior.
- `src/services/adminFrontendOnboarding.ts` — API types, outcome definitions/colors, and the range-aware paired-series mapper.
- `tests/admin-frontend-onboarding-dashboard.unit.test.ts` — mapper behavior, dynamic categories, separate-card placement, old-chart preservation, and translations.
- `src/pages/admin/dashboard/frontend-onboarding.vue` — computed labels/series and the new chart card below the existing aggregate card.
- `messages/en.json` — title, description, lifecycle labels, and 12 outcome labels.

---

### Task 1: Define and test the 12-way outcome taxonomy

**Files:**
- Create: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts`
- Create: `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts`

- [ ] **Step 1: Write the failing table-driven taxonomy test**

Create `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts` with the taxonomy cases first:

```ts
import { describe, expect, it } from 'vitest'
import {
  classifyFrontendOnboardingDailySetupCliOutcome,
  FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS,
} from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts'

describe('frontend onboarding daily Setup CLI outcomes model', () => {
  it.each([
    [{ cliCopied: true, aiCopied: false, initRun: true, otherCliRun: false }, 'cli_copy_init'],
    [{ cliCopied: false, aiCopied: true, initRun: true, otherCliRun: false }, 'ai_copy_init'],
    [{ cliCopied: true, aiCopied: true, initRun: true, otherCliRun: false }, 'both_copy_init'],
    [{ cliCopied: false, aiCopied: false, initRun: true, otherCliRun: false }, 'no_copy_init'],
    [{ cliCopied: true, aiCopied: false, initRun: false, otherCliRun: true }, 'cli_copy_other_cli'],
    [{ cliCopied: false, aiCopied: true, initRun: false, otherCliRun: true }, 'ai_copy_other_cli'],
    [{ cliCopied: true, aiCopied: true, initRun: false, otherCliRun: true }, 'both_copy_other_cli'],
    [{ cliCopied: false, aiCopied: false, initRun: false, otherCliRun: true }, 'no_copy_other_cli'],
    [{ cliCopied: true, aiCopied: false, initRun: false, otherCliRun: false }, 'cli_copy_no_cli'],
    [{ cliCopied: false, aiCopied: true, initRun: false, otherCliRun: false }, 'ai_copy_no_cli'],
    [{ cliCopied: true, aiCopied: true, initRun: false, otherCliRun: false }, 'both_copy_no_cli'],
    [{ cliCopied: false, aiCopied: false, initRun: false, otherCliRun: false }, 'no_action'],
  ] as const)('classifies %o as %s', (signals, expected) => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome(signals)).toBe(expected)
  })

  it('gives init precedence over another CLI command', () => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome({
      cliCopied: true,
      aiCopied: true,
      initRun: true,
      otherCliRun: true,
    })).toBe('both_copy_init')
  })

  it('publishes every category exactly once in display order', () => {
    expect(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS).toEqual([
      'cli_copy_init',
      'ai_copy_init',
      'both_copy_init',
      'no_copy_init',
      'cli_copy_other_cli',
      'ai_copy_other_cli',
      'both_copy_other_cli',
      'no_copy_other_cli',
      'cli_copy_no_cli',
      'ai_copy_no_cli',
      'both_copy_no_cli',
      'no_action',
    ])
  })
})
```

- [ ] **Step 2: Run the new model test and verify the missing module failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
```

Expected: FAIL because `frontend_onboarding_daily_setup_cli_outcomes_model.ts` does not exist.

- [ ] **Step 3: Add the model types, empty-count factory, and classifier**

Create `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts`:

```ts
export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS = [
  'cli_copy_init',
  'ai_copy_init',
  'both_copy_init',
  'no_copy_init',
  'cli_copy_other_cli',
  'ai_copy_other_cli',
  'both_copy_other_cli',
  'no_copy_other_cli',
  'cli_copy_no_cli',
  'ai_copy_no_cli',
  'both_copy_no_cli',
  'no_action',
] as const

export type FrontendOnboardingDailySetupCliOutcomeKey = typeof FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS[number]
export type FrontendOnboardingDailySetupCliLifecycle = 'first_time' | 'returning'
export type FrontendOnboardingDailySetupCliEventKind = 'setup' | 'cli_copy' | 'ai_copy' | 'cli_command'

export interface FrontendOnboardingDailySetupCliEvent {
  personId: string
  timestampMs: number
  kind: FrontendOnboardingDailySetupCliEventKind
  commandPath?: string
}

export interface FrontendOnboardingDailySetupCliSignals {
  cliCopied: boolean
  aiCopied: boolean
  initRun: boolean
  otherCliRun: boolean
}

export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomePoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}

export function createFrontendOnboardingDailySetupCliOutcomeCounts(): FrontendOnboardingDailySetupCliOutcomeCounts {
  return Object.fromEntries(
    FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.map(key => [key, 0]),
  ) as FrontendOnboardingDailySetupCliOutcomeCounts
}

export function classifyFrontendOnboardingDailySetupCliOutcome(
  signals: FrontendOnboardingDailySetupCliSignals,
): FrontendOnboardingDailySetupCliOutcomeKey {
  const copyPrefix = signals.cliCopied && signals.aiCopied
    ? 'both_copy'
    : signals.cliCopied
      ? 'cli_copy'
      : signals.aiCopied
        ? 'ai_copy'
        : 'no_copy'

  if (signals.initRun)
    return `${copyPrefix}_init` as FrontendOnboardingDailySetupCliOutcomeKey
  if (signals.otherCliRun)
    return `${copyPrefix}_other_cli` as FrontendOnboardingDailySetupCliOutcomeKey
  if (copyPrefix !== 'no_copy')
    return `${copyPrefix}_no_cli` as FrontendOnboardingDailySetupCliOutcomeKey
  return 'no_action'
}
```

- [ ] **Step 4: Run the taxonomy test and verify it passes**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
```

Expected: PASS with 14 assertions/cases and no other test failures.

- [ ] **Step 5: Commit the taxonomy model**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
git commit -m "feat(admin): define daily Setup CLI outcomes"
```

---

### Task 2: Implement UTC person-day anchoring and latest-anchor attribution

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts`
- Modify: `tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts`

- [ ] **Step 1: Add failing tests for daily uniqueness, returning users, attribution, tail anchors, and zero-filled dates**

Append inside the existing `describe` block:

```ts
  it('counts one anchor per UTC day and assigns overlapping actions only to the latest anchor', () => {
    const startMs = Date.UTC(2026, 7, 3)
    const endMs = Date.UTC(2026, 7, 6)
    const hour = 60 * 60 * 1000
    const events = [
      { personId: 'person-a', timestampMs: startMs + 9 * hour, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: startMs + 12 * hour, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: startMs + 13 * hour, kind: 'ai_copy' as const },
      { personId: 'person-a', timestampMs: startMs + 24 * hour + 8 * hour, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: startMs + 24 * hour + 9 * hour, kind: 'cli_command' as const, commandPath: 'init' },
      { personId: 'person-b', timestampMs: startMs + 24 * hour + 10 * hour, kind: 'setup' as const },
      { personId: 'person-b', timestampMs: startMs + 24 * hour + 11 * hour, kind: 'cli_copy' as const },
      { personId: 'person-b', timestampMs: startMs + 24 * hour + 12 * hour, kind: 'cli_command' as const, commandPath: 'app-debug' },
    ]

    const points = buildFrontendOnboardingDailySetupCliOutcomes(events, startMs, endMs)

    expect(points).toHaveLength(3)
    expect(points[0].date).toBe('2026-08-03')
    expect(points[0].first_time.ai_copy_no_cli).toBe(1)
    expect(points[0].returning.no_action).toBe(0)
    expect(points[1].date).toBe('2026-08-04')
    expect(points[1].returning.no_copy_init).toBe(1)
    expect(points[1].first_time.cli_copy_other_cli).toBe(1)
    expect(Object.values(points[2].first_time).reduce((sum, value) => sum + value, 0)).toBe(0)
    expect(Object.values(points[2].returning).reduce((sum, value) => sum + value, 0)).toBe(0)

    const expectedSetupPersonDays: Record<string, Record<'first_time' | 'returning', number>> = {
      '2026-08-03': { first_time: 1, returning: 0 },
      '2026-08-04': { first_time: 1, returning: 1 },
      '2026-08-05': { first_time: 0, returning: 0 },
    }
    for (const point of points) {
      for (const lifecycle of ['first_time', 'returning'] as const) {
        const outcomeTotal = Object.values(point[lifecycle]).reduce((sum, value) => sum + value, 0)
        expect(outcomeTotal).toBe(expectedSetupPersonDays[point.date][lifecycle])
      }
    }
  })

  it('uses an ownership-only tail anchor to prevent the last displayed day stealing an action', () => {
    const startMs = Date.UTC(2026, 7, 31)
    const endMs = Date.UTC(2026, 8, 1)
    const minute = 60 * 1000
    const events = [
      { personId: 'person-a', timestampMs: endMs - 30 * minute, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: endMs + 15 * minute, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: endMs + 20 * minute, kind: 'cli_command' as const, commandPath: 'init' },
    ]

    const [point] = buildFrontendOnboardingDailySetupCliOutcomes(events, startMs, endMs)

    expect(point.first_time.no_action).toBe(1)
    expect(point.first_time.no_copy_init).toBe(0)
    expect(point.returning.no_copy_init).toBe(0)
  })

  it('uses half-open action windows at the next anchor and 24-hour boundary', () => {
    const startMs = Date.UTC(2026, 7, 1)
    const endMs = Date.UTC(2026, 7, 4)
    const day = 24 * 60 * 60 * 1000
    const events = [
      { personId: 'next-anchor', timestampMs: startMs, kind: 'setup' as const },
      { personId: 'next-anchor', timestampMs: startMs + day, kind: 'setup' as const },
      { personId: 'next-anchor', timestampMs: startMs + day, kind: 'cli_command' as const, commandPath: 'init' },
      { personId: 'boundary', timestampMs: startMs, kind: 'setup' as const },
      { personId: 'boundary', timestampMs: startMs + day, kind: 'cli_command' as const, commandPath: 'init' },
    ]

    const points = buildFrontendOnboardingDailySetupCliOutcomes(events, startMs, endMs)

    expect(points[0].first_time.no_action).toBe(2)
    expect(points[0].first_time.no_copy_init).toBe(0)
    expect(points[1].returning.no_copy_init).toBe(1)
  })

  it.each([
    [['cli_copy', 'ai_copy'] as const],
    [['ai_copy', 'cli_copy'] as const],
  ])('treats copy order as irrelevant for %o', ([firstCopy, secondCopy]) => {
    const startMs = Date.UTC(2026, 7, 1)
    const endMs = Date.UTC(2026, 7, 2)
    const events = [
      { personId: 'person-a', timestampMs: startMs + 1_000, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: startMs + 2_000, kind: firstCopy },
      { personId: 'person-a', timestampMs: startMs + 3_000, kind: secondCopy },
      { personId: 'person-a', timestampMs: startMs + 4_000, kind: 'cli_command' as const, commandPath: 'init' },
    ]

    const [point] = buildFrontendOnboardingDailySetupCliOutcomes(events, startMs, endMs)

    expect(point.first_time.both_copy_init).toBe(1)
  })

  it('ignores Setup history before the selected range when assigning lifecycle', () => {
    const startMs = Date.UTC(2026, 7, 1)
    const endMs = Date.UTC(2026, 7, 2)
    const events = [
      { personId: 'person-a', timestampMs: startMs - 1_000, kind: 'setup' as const },
      { personId: 'person-a', timestampMs: startMs + 1_000, kind: 'setup' as const },
    ]

    const [point] = buildFrontendOnboardingDailySetupCliOutcomes(events, startMs, endMs)

    expect(point.first_time.no_action).toBe(1)
    expect(Object.values(point.returning).reduce((sum, value) => sum + value, 0)).toBe(0)
  })

  it('rejects invalid bounds and invalid normalized events', () => {
    const startMs = Date.UTC(2026, 7, 1)
    const endMs = Date.UTC(2026, 7, 2)

    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([], endMs, startMs)).toThrow(RangeError)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([
      { personId: '', timestampMs: startMs, kind: 'setup' },
    ], startMs, endMs)).toThrow('daily Setup CLI event is invalid')
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([
      { personId: 'person-a', timestampMs: startMs, kind: 'cli_command' },
    ], startMs, endMs)).toThrow('daily Setup CLI command path is invalid')
  })
```

Update the import to include `buildFrontendOnboardingDailySetupCliOutcomes`.

- [ ] **Step 2: Run the model test and verify the missing builder failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
```

Expected: FAIL because `buildFrontendOnboardingDailySetupCliOutcomes` is not exported.

- [ ] **Step 3: Implement the person-day builder in the pure model**

Append to `frontend_onboarding_daily_setup_cli_outcomes_model.ts`:

```ts
const DAY_MS = 24 * 60 * 60 * 1000

interface SetupAnchor {
  personId: string
  date: string
  timestampMs: number
  lifecycle: FrontendOnboardingDailySetupCliLifecycle | null
  signals: FrontendOnboardingDailySetupCliSignals
}

function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function eachUtcDate(startMs: number, endMs: number): string[] {
  const start = new Date(startMs)
  let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const dates: string[] = []
  while (cursor < endMs) {
    dates.push(utcDate(cursor))
    cursor += DAY_MS
  }
  return dates
}

function validateEvent(event: FrontendOnboardingDailySetupCliEvent): void {
  if (!event.personId.trim() || !Number.isFinite(event.timestampMs))
    throw new TypeError('daily Setup CLI event is invalid')
  if (event.kind === 'cli_command' && !event.commandPath?.trim())
    throw new TypeError('daily Setup CLI command path is invalid')
}

function createSignals(): FrontendOnboardingDailySetupCliSignals {
  return { cliCopied: false, aiCopied: false, initRun: false, otherCliRun: false }
}

function applyAction(anchor: SetupAnchor, event: FrontendOnboardingDailySetupCliEvent): void {
  if (event.kind === 'cli_copy')
    anchor.signals.cliCopied = true
  else if (event.kind === 'ai_copy')
    anchor.signals.aiCopied = true
  else if (event.kind === 'cli_command' && event.commandPath === 'init')
    anchor.signals.initRun = true
  else if (event.kind === 'cli_command')
    anchor.signals.otherCliRun = true
}

export function buildFrontendOnboardingDailySetupCliOutcomes(
  events: readonly FrontendOnboardingDailySetupCliEvent[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailySetupCliOutcomePoint[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    throw new RangeError('daily Setup CLI bounds are invalid')

  const followupEndMs = endMs + DAY_MS
  const firstSetupByPersonDay = new Map<string, FrontendOnboardingDailySetupCliEvent>()

  for (const event of events) {
    validateEvent(event)
    if (event.kind !== 'setup' || event.timestampMs < startMs || event.timestampMs >= followupEndMs)
      continue
    const key = `${event.personId}\u0000${utcDate(event.timestampMs)}`
    const current = firstSetupByPersonDay.get(key)
    if (!current || event.timestampMs < current.timestampMs)
      firstSetupByPersonDay.set(key, event)
  }

  const anchorsByPerson = new Map<string, SetupAnchor[]>()
  for (const setup of firstSetupByPersonDay.values()) {
    const anchors = anchorsByPerson.get(setup.personId) ?? []
    anchors.push({
      personId: setup.personId,
      date: utcDate(setup.timestampMs),
      timestampMs: setup.timestampMs,
      lifecycle: null,
      signals: createSignals(),
    })
    anchorsByPerson.set(setup.personId, anchors)
  }

  for (const anchors of anchorsByPerson.values()) {
    anchors.sort((left, right) => left.timestampMs - right.timestampMs)
    let displayedAnchors = 0
    for (const anchor of anchors) {
      if (anchor.timestampMs >= endMs)
        continue
      anchor.lifecycle = displayedAnchors === 0 ? 'first_time' : 'returning'
      displayedAnchors++
    }
  }

  for (const event of events) {
    if (event.kind === 'setup' || event.timestampMs < startMs || event.timestampMs >= followupEndMs)
      continue
    const anchors = anchorsByPerson.get(event.personId) ?? []
    for (let index = anchors.length - 1; index >= 0; index--) {
      const anchor = anchors[index]
      if (event.timestampMs < anchor.timestampMs)
        continue
      const nextAnchorMs = anchors[index + 1]?.timestampMs ?? Number.POSITIVE_INFINITY
      const windowEndMs = Math.min(anchor.timestampMs + DAY_MS, nextAnchorMs)
      if (event.timestampMs < windowEndMs && anchor.lifecycle)
        applyAction(anchor, event)
      break
    }
  }

  const points = eachUtcDate(startMs, endMs).map(date => ({
    date,
    first_time: createFrontendOnboardingDailySetupCliOutcomeCounts(),
    returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
  }))
  const pointsByDate = new Map(points.map(point => [point.date, point]))

  for (const anchors of anchorsByPerson.values()) {
    for (const anchor of anchors) {
      if (!anchor.lifecycle)
        continue
      const point = pointsByDate.get(anchor.date)
      if (!point)
        continue
      const outcome = classifyFrontendOnboardingDailySetupCliOutcome(anchor.signals)
      point[anchor.lifecycle][outcome]++
    }
  }

  return points
}
```

- [ ] **Step 4: Run the model tests and verify every attribution case passes**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
```

Expected: PASS, including August 31/September 1 ownership and exact-boundary cases.

- [ ] **Step 5: Commit the attribution model**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts
git commit -m "feat(admin): attribute daily Setup CLI actions"
```

---

### Task 3: Add the bounded PostHog event adapter

**Files:**
- Create: `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts`
- Create: `tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts`

- [ ] **Step 1: Write failing query, parsing, and limit tests**

Create `tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts`:

```ts
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertFrontendOnboardingDailySetupCliEventTotal,
  buildFrontendOnboardingDailySetupCliHogql,
  FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
  getFrontendOnboardingDailySetupCliEvents,
} from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts'

const { cloudlogErrMock, queryPosthogHogqlMock } = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  queryPosthogHogqlMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({
  queryPosthogHogql: queryPosthogHogqlMock,
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
}))

function createContext(): Context {
  return { get: () => 'request-id' } as unknown as Context
}

beforeEach(() => {
  cloudlogErrMock.mockReset()
  queryPosthogHogqlMock.mockReset()
})

describe('daily Setup CLI PostHog adapter', () => {
  it('selects only cohort people and relevant v2 Setup, copy, and CLI events', () => {
    const query = buildFrontendOnboardingDailySetupCliHogql(
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )

    expect(query).toContain("event = 'onboarding_step_viewed'")
    expect(query).toContain("event IN ('onboarding_cli_command_copied', 'onboarding_ai_instructions_copied')")
    expect(query).toContain("event = 'CLI Command Invoked'")
    expect(query).toContain("JSONExtractString(toString(properties), 'flow') = 'pre_org'")
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) = 2')
    expect(query).toContain("JSONExtractString(toString(properties), 'step') = 'setup'")
    expect(query).toContain('INNER JOIN setup_people AS cohort')
    expect(query).toContain("timestamp < parseDateTimeBestEffort('2026-09-02T00:00:00.000Z')")
    expect(query).toContain('count() OVER () AS total_events')
    expect(query).toContain('ORDER BY person_id ASC, timestamp_ms ASC, event_kind ASC')
    expect(query).toContain(`LIMIT ${FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT}`)
  })

  it('maps normalized rows and trims CLI command paths', async () => {
    queryPosthogHogqlMock.mockResolvedValue({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-a', timestamp_ms: 1_000, event_kind: 'setup', command_path: '', total_events: 2 },
        { person_id: 'person-a', timestamp_ms: 2_000, event_kind: 'cli_command', command_path: ' init ', total_events: 2 },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )).resolves.toEqual([
      { personId: 'person-a', timestampMs: 1_000, kind: 'setup' },
      { personId: 'person-a', timestampMs: 2_000, kind: 'cli_command', commandPath: 'init' },
    ])
  })

  it('fails closed and logs when total event metadata exceeds the limit', async () => {
    queryPosthogHogqlMock.mockResolvedValue({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ total_events: FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT + 1 }],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query exceeded event limit')
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_event_limit_exceeded',
    }))
  })

  it('rejects malformed rows and unsuccessful PostHog responses', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ person_id: 'person-a', timestamp_ms: 1_000, event_kind: 'cli_command', command_path: '', total_events: 1 }],
    })
    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics row is invalid')

    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: false,
      failureReason: 'unavailable',
      rows: [],
    })
    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics PostHog query failed')
  })

  it('validates total metadata directly', () => {
    expect(() => assertFrontendOnboardingDailySetupCliEventTotal(1, 1)).not.toThrow()
    expect(() => assertFrontendOnboardingDailySetupCliEventTotal('1', 1)).toThrow('daily Setup CLI analytics query returned invalid total metadata')
  })
})
```

- [ ] **Step 2: Run the adapter test and verify the missing module failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the HogQL builder, parser, limit guard, and query wrapper**

Create `supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts`:

```ts
import type { Context } from 'hono'
import type {
  FrontendOnboardingDailySetupCliEvent,
  FrontendOnboardingDailySetupCliEventKind,
} from './frontend_onboarding_daily_setup_cli_outcomes_model.ts'
import { cloudlogErr } from './logging.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const INVALID_TOTAL_ERROR = 'daily Setup CLI analytics query returned invalid total metadata'
const LIMIT_EXCEEDED_ERROR = 'daily Setup CLI analytics query exceeded event limit'
const INVALID_ROW_ERROR = 'daily Setup CLI analytics row is invalid'

export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT = 50_000

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

export function assertFrontendOnboardingDailySetupCliEventTotal(
  totalEvents: unknown,
  limit = FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
): number {
  if (typeof totalEvents !== 'number'
    || !Number.isFinite(totalEvents)
    || !Number.isInteger(totalEvents)
    || totalEvents < 0) {
    throw new Error(INVALID_TOTAL_ERROR)
  }
  if (totalEvents > limit)
    throw new Error(LIMIT_EXCEEDED_ERROR)
  return totalEvents
}

export function buildFrontendOnboardingDailySetupCliHogql(
  startDate: string,
  endDate: string,
  followupEndDate: string,
): string {
  return `
    WITH setup_people AS (
      SELECT person_id
      FROM events
      WHERE event = 'onboarding_step_viewed'
        AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
        AND toIntOrZero(toString(properties.onboarding_version)) = 2
        AND JSONExtractString(toString(properties), 'step') = 'setup'
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(endDate)})
      GROUP BY person_id
    ), relevant_events AS (
      SELECT
        toString(source.person_id) AS person_id,
        toUnixTimestamp64Milli(source.timestamp) AS timestamp_ms,
        multiIf(
          source.event = 'onboarding_step_viewed', 'setup',
          source.event = 'onboarding_cli_command_copied', 'cli_copy',
          source.event = 'onboarding_ai_instructions_copied', 'ai_copy',
          'cli_command'
        ) AS event_kind,
        if(
          source.event = 'CLI Command Invoked',
          JSONExtractString(toString(source.properties), 'command_path'),
          ''
        ) AS command_path
      FROM events AS source
      INNER JOIN setup_people AS cohort ON source.person_id = cohort.person_id
      WHERE source.timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND source.timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
        AND (
          (source.event = 'onboarding_step_viewed'
            AND JSONExtractString(toString(source.properties), 'flow') = 'pre_org'
            AND toIntOrZero(toString(source.properties.onboarding_version)) = 2
            AND JSONExtractString(toString(source.properties), 'step') = 'setup')
          OR (source.event IN ('onboarding_cli_command_copied', 'onboarding_ai_instructions_copied')
            AND JSONExtractString(toString(source.properties), 'flow') = 'pre_org'
            AND toIntOrZero(toString(source.properties.onboarding_version)) = 2
            AND JSONExtractString(toString(source.properties), 'step') = 'setup')
          OR source.event = 'CLI Command Invoked'
        )
    )
    SELECT
      person_id,
      timestamp_ms,
      event_kind,
      command_path,
      count() OVER () AS total_events
    FROM relevant_events
    ORDER BY person_id ASC, timestamp_ms ASC, event_kind ASC
    LIMIT ${FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT}`
}

function timestampMs(value: unknown): number | null {
  const timestamp = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function mapRows(c: Context, rows: Record<string, unknown>[]): FrontendOnboardingDailySetupCliEvent[] {
  const validKinds = new Set<FrontendOnboardingDailySetupCliEventKind>(['setup', 'cli_copy', 'ai_copy', 'cli_command'])
  return rows.map((row, rowIndex) => {
    try {
      const personId = typeof row.person_id === 'string' ? row.person_id.trim() : ''
      const timestamp = timestampMs(row.timestamp_ms)
      const kind = typeof row.event_kind === 'string' ? row.event_kind as FrontendOnboardingDailySetupCliEventKind : null
      const commandPath = row.command_path

      if (!personId || timestamp === null || !kind || !validKinds.has(kind))
        throw new Error(INVALID_ROW_ERROR)
      if (kind === 'cli_command' && (typeof commandPath !== 'string' || commandPath.trim() === ''))
        throw new Error(INVALID_ROW_ERROR)

      return {
        personId,
        timestampMs: timestamp,
        kind,
        ...(kind === 'cli_command' ? { commandPath: commandPath as string } : {}),
      }
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'frontend_onboarding_daily_setup_cli_invalid_row',
        row_index: rowIndex,
        returned_rows: rows.length,
      })
      throw error
    }
  })
}

export async function getFrontendOnboardingDailySetupCliEvents(
  c: Context,
  startDate: string,
  endDate: string,
  followupEndDate: string,
): Promise<FrontendOnboardingDailySetupCliEvent[]> {
  const posthog = await queryPosthogHogql(
    c,
    buildFrontendOnboardingDailySetupCliHogql(startDate, endDate, followupEndDate),
  )
  if (!posthog.configured || !posthog.connected || posthog.failureReason !== null)
    throw new Error('daily Setup CLI analytics PostHog query failed')

  if (posthog.rows.length > 0) {
    try {
      assertFrontendOnboardingDailySetupCliEventTotal(posthog.rows[0].total_events)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: error instanceof Error && error.message === LIMIT_EXCEEDED_ERROR
          ? 'frontend_onboarding_daily_setup_cli_event_limit_exceeded'
          : 'frontend_onboarding_daily_setup_cli_invalid_total_events',
        event_limit: FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
        total_events: posthog.rows[0].total_events,
        returned_rows: posthog.rows.length,
      })
      throw error
    }
  }

  return mapRows(c, posthog.rows)
}
```

- [ ] **Step 4: Run the adapter tests and verify they pass**

Run:

```bash
bunx vitest run tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
```

Expected: PASS with query boundaries, identity join, row mapping, and fail-closed limits covered.

- [ ] **Step 5: Commit the PostHog adapter**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts
git commit -m "feat(admin): query daily Setup CLI events"
```

---

### Task 4: Integrate daily outcomes into the existing analytics endpoint

**Files:**
- Modify: `supabase/functions/_backend/utils/frontend_onboarding_analytics.ts:1-10,227-283`
- Modify: `tests/frontend-onboarding-analytics.unit.test.ts:1-332`

- [ ] **Step 1: Add a failing endpoint integration test**

In `tests/frontend-onboarding-analytics.unit.test.ts`, add this test inside `describe('getAdminFrontendOnboardingAnalytics')`:

```ts
  it('adds daily Setup CLI outcomes without changing the aggregate outcome field', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const end = '2026-08-03T00:00:00.000Z'
    const startMs = Date.parse(start)

    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({
        configured: true,
        connected: true,
        failureReason: null,
        rows: [
          { person_id: 'person-a', timestamp_ms: startMs + 1_000, event_kind: 'setup', command_path: '', total_events: 3 },
          { person_id: 'person-a', timestamp_ms: startMs + 2_000, event_kind: 'cli_copy', command_path: '', total_events: 3 },
          { person_id: 'person-a', timestamp_ms: startMs + 3_000, event_kind: 'cli_command', command_path: 'init', total_events: 3 },
        ],
      })

    const result = await getAdminFrontendOnboardingAnalytics(createContext(), start, end)

    expect(result.daily_setup_cli_outcomes[0].first_time.cli_copy_init).toBe(1)
    expect(result.daily_setup_cli_outcomes[1].first_time.cli_copy_init).toBe(0)
    expect(result.v2_setup_cli_outcomes).toEqual({
      total_users: 0,
      cli_only: 0,
      cli_and_ai_instructions: 0,
      no_cli: 0,
    })
  })

  it('fails the analytics request when the dedicated daily query fails', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'unavailable', rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics PostHog query failed')
  })

  it('propagates either PostHog promise rejection after starting both queries', async () => {
    queryPosthogHogqlMock
      .mockRejectedValueOnce(new Error('aggregate PostHog request rejected'))
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('aggregate PostHog request rejected')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(2)

    queryPosthogHogqlMock.mockReset()
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockRejectedValueOnce(new Error('daily PostHog request rejected'))
    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('daily PostHog request rejected')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(2)
  })
```

Update the boundary tests so successful requests expect two PostHog calls. Assert that the existing query still ends at `end + 48 hours`, while the second query starts at the selected start and ends at `end + 24 hours`:

```ts
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(2)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + 2 * DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `source.timestamp >= parseDateTimeBestEffort('${start}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `source.timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + DAY_MS).toISOString()}')`,
    )
```

- [ ] **Step 2: Run the endpoint tests and verify the missing response field failure**

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts
```

Expected: FAIL because `daily_setup_cli_outcomes` is absent and successful calls still execute one query.

- [ ] **Step 3: Wire the dedicated query and pure builder into the endpoint**

Add imports in `frontend_onboarding_analytics.ts`:

```ts
import { getFrontendOnboardingDailySetupCliEvents } from './frontend_onboarding_daily_setup_cli_outcomes.ts'
import { buildFrontendOnboardingDailySetupCliOutcomes } from './frontend_onboarding_daily_setup_cli_outcomes_model.ts'
```

Replace the single existing PostHog call in `getAdminFrontendOnboardingAnalytics` with:

```ts
  const normalizedStartDate = new Date(startMs).toISOString()
  const normalizedEndDate = new Date(endMs).toISOString()
  const dailyFollowupEndDate = new Date(endMs + FRONTEND_ONBOARDING_FOLLOWUP_MS).toISOString()

  const [posthog, dailySetupCliEvents] = await Promise.all([
    queryPosthogHogql(
      c,
      buildFrontendOnboardingHogql(
        new Date(queryStartMs).toISOString(),
        normalizedEndDate,
        new Date(followupEndMs).toISOString(),
      ),
    ),
    getFrontendOnboardingDailySetupCliEvents(
      c,
      normalizedStartDate,
      normalizedEndDate,
      dailyFollowupEndDate,
    ),
  ])
```

After `buildFrontendOnboardingAnalytics`, create the daily result:

```ts
  const dailySetupCliOutcomes = buildFrontendOnboardingDailySetupCliOutcomes(
    dailySetupCliEvents,
    startMs,
    endMs,
  )
```

Add it to the returned object without editing `buildV2SetupCliOutcomes` or `v2_setup_cli_outcomes`:

```ts
  return {
    ...analytics,
    daily_setup_cli_outcomes: dailySetupCliOutcomes,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
```

- [ ] **Step 4: Update existing one-query expectations and run both backend suites**

Change successful `toHaveBeenCalledTimes(1)` expectations in `tests/frontend-onboarding-analytics.unit.test.ts` to `2`. Keep invalid-bound tests at zero calls. Where a test inspects the current aggregate query, continue using `mock.calls[0][1]`; use `mock.calls[1][1]` only for the dedicated daily query.

Run:

```bash
bunx vitest run tests/frontend-onboarding-analytics.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes.unit.test.ts tests/frontend-onboarding-daily-setup-cli-outcomes-model.unit.test.ts tests/frontend-onboarding-analytics-model.unit.test.ts
```

Expected: PASS. The existing aggregate-model suite must remain unchanged and green.

- [ ] **Step 5: Commit the endpoint integration**

```bash
git add supabase/functions/_backend/utils/frontend_onboarding_analytics.ts tests/frontend-onboarding-analytics.unit.test.ts
git commit -m "feat(admin): expose daily Setup CLI outcomes"
```

---

### Task 5: Extend `AdminStackedBarChart` for optional paired stacks

**Files:**
- Modify: `src/components/admin/adminStackedBarChart.ts:1-81`
- Modify: `src/components/admin/AdminStackedBarChart.vue:1-81`
- Modify: `tests/admin-stacked-bar-chart.unit.test.ts:1-63`

- [ ] **Step 1: Add failing grouped-stack helper tests**

Update imports in `tests/admin-stacked-bar-chart.unit.test.ts` to include:

```ts
  buildAdminStackedBarLegendItems,
  getAdminStackedBarTooltipTotal,
  toggleAdminStackedBarLegendGroup,
```

Append these tests:

```ts
  it.concurrent('preserves optional stack metadata and uses stack-scoped tooltip totals', () => {
    const grouped = buildAdminStackedBarChartData(['Aug 1'], [
      { label: 'No action', data: [3], color: '#94a3b8', stack: 'first_time', stackLabel: 'First-time' },
      { label: 'No action', data: [2], color: '#94a3b8', stack: 'returning', stackLabel: 'Returning' },
      { label: 'CLI + init', data: [1], color: '#10b981', stack: 'first_time', stackLabel: 'First-time' },
    ])

    expect(grouped.datasets.map(dataset => ({
      stack: dataset.stack,
      stackLabel: dataset.stackLabel,
    }))).toEqual([
      { stack: 'first_time', stackLabel: 'First-time' },
      { stack: 'returning', stackLabel: 'Returning' },
      { stack: 'first_time', stackLabel: 'First-time' },
    ])
    expect(getAdminStackedBarTooltipTotal(grouped.datasets, 0, 0)).toBe(4)
    expect(getAdminStackedBarTooltipTotal(grouped.datasets, 1, 0)).toBe(2)
  })

  it.concurrent('deduplicates active grouped legend labels and removes zero-only categories', () => {
    const grouped = buildAdminStackedBarChartData(['Aug 1', 'Aug 2'], [
      { label: 'No action', data: [3, 0], color: '#94a3b8', stack: 'first_time' },
      { label: 'No action', data: [0, 1], color: '#94a3b8', stack: 'returning' },
      { label: 'Never happened', data: [0, 0], color: '#ef4444', stack: 'first_time' },
      { label: 'Never happened', data: [0, 0], color: '#ef4444', stack: 'returning' },
    ])
    const chart = {
      data: grouped,
      isDatasetVisible: () => true,
    } as any

    expect(buildAdminStackedBarLegendItems(chart).map(item => item.text)).toEqual(['No action'])
  })

  it.concurrent('toggles every lifecycle dataset represented by one legend item', () => {
    const visibility = [true, true, true]
    const chart = {
      data: { datasets: [{ label: 'No action' }, { label: 'No action' }, { label: 'CLI + init' }] },
      isDatasetVisible: (index: number) => visibility[index],
      setDatasetVisibility: (index: number, visible: boolean) => { visibility[index] = visible },
      update: () => undefined,
    } as any

    toggleAdminStackedBarLegendGroup(chart, 'No action')
    expect(visibility).toEqual([false, false, true])
    toggleAdminStackedBarLegendGroup(chart, 'No action')
    expect(visibility).toEqual([true, true, true])
  })

  it.concurrent('uses grouped interaction only when requested', () => {
    expect((buildAdminStackedBarChartOptions(false, false) as any).interaction.mode).toBe('index')
    expect((buildAdminStackedBarChartOptions(false, true) as any).interaction.mode).toBe('nearest')
  })
```

- [ ] **Step 2: Run the chart tests and verify the missing helper failures**

Run:

```bash
bunx vitest run tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: FAIL because grouped metadata and helper exports are absent.

- [ ] **Step 3: Implement grouped datasets, tooltips, and legends in the chart helper**

Extend `AdminStackedBarDataset`:

```ts
export interface AdminStackedBarDataset {
  label: string
  data: number[]
  color: string
  stack?: string
  stackLabel?: string
}
```

In `buildAdminStackedBarChartData`, pass through both optional values:

```ts
      stack: item.stack,
      stackLabel: item.stackLabel,
```

Change the Chart.js type import to:

```ts
import type { Chart as ChartJs, ChartData, ChartOptions, LegendItem } from 'chart.js'
```

Add these reusable chart-data types below `AdminStackedBarDataset`, and change `buildAdminStackedBarChartData` plus `applyAdminStackedBarAccessibleBorders` to return `AdminStackedBarChartData`:

```ts
export type AdminStackedBarChartDataset = ChartData<'bar'>['datasets'][number] & { stackLabel?: string }
export type AdminStackedBarChartData = Omit<ChartData<'bar'>, 'datasets'> & { datasets: AdminStackedBarChartDataset[] }
```

Add these helpers before `buildAdminStackedBarChartOptions`:

```ts
type AdminLegendDataChart = Pick<ChartJs<'bar'>, 'data' | 'isDatasetVisible'>
type AdminLegendToggleChart = Pick<ChartJs<'bar'>, 'data' | 'isDatasetVisible' | 'setDatasetVisibility' | 'update'>

function datasetTotal(dataset: AdminStackedBarChartDataset): number {
  return dataset.data.reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
}

export function getAdminStackedBarTooltipTotal(
  datasets: readonly AdminStackedBarChartDataset[],
  datasetIndex: number,
  dataIndex: number,
): number {
  const activeStack = datasets[datasetIndex]?.stack
  return datasets.reduce((sum, dataset) => {
    if (activeStack !== undefined && dataset.stack !== activeStack)
      return sum
    return sum + Number(dataset.data[dataIndex] ?? 0)
  }, 0)
}

export function buildAdminStackedBarLegendItems(chart: AdminLegendDataChart): LegendItem[] {
  const seen = new Set<string>()
  return chart.data.datasets.flatMap((rawDataset, datasetIndex) => {
    const dataset = rawDataset as AdminStackedBarChartDataset
    const label = dataset.label ?? ''
    if (!label || seen.has(label) || datasetTotal(dataset) === 0)
      return []
    seen.add(label)
    return [{
      text: label,
      fillStyle: typeof dataset.backgroundColor === 'string' ? dataset.backgroundColor : '#94a3b8',
      strokeStyle: typeof dataset.borderColor === 'string' ? dataset.borderColor : '#94a3b8',
      lineWidth: typeof dataset.borderWidth === 'number' ? dataset.borderWidth : 0,
      hidden: chart.data.datasets
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => candidate.label === label)
        .every(({ index }) => !chart.isDatasetVisible(index)),
      datasetIndex,
      pointStyle: 'circle' as const,
    }]
  })
}

export function toggleAdminStackedBarLegendGroup(chart: AdminLegendToggleChart, label: string): void {
  const indexes = chart.data.datasets
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset }) => dataset.label === label)
    .map(({ index }) => index)
  const show = indexes.every(index => !chart.isDatasetVisible(index))
  for (const index of indexes)
    chart.setDatasetVisibility(index, show)
  chart.update()
}
```

Change the options signature and interaction mode:

```ts
export function buildAdminStackedBarChartOptions(
  isDark: boolean,
  groupedStacks = false,
): ChartOptions<'bar'> {
```

```ts
    interaction: {
      mode: groupedStacks ? 'nearest' : 'index',
      intersect: false,
    },
```

Inside `plugins.legend`, retain the existing label styling and add grouped-only generation/toggling:

```ts
        labels: {
          color: textColor,
          boxHeight: 10,
          boxWidth: 10,
          font: { size: 12, weight: 500 },
          padding: 18,
          usePointStyle: true,
          ...(groupedStacks ? { generateLabels: buildAdminStackedBarLegendItems } : {}),
        },
        ...(groupedStacks
          ? { onClick: (_event, item, legend) => toggleAdminStackedBarLegendGroup(legend.chart, item.text) }
          : {}),
```

Replace the tooltip total calculation with stack-aware logic and prefix grouped labels:

```ts
            const total = getAdminStackedBarTooltipTotal(
              context.chart.data.datasets,
              context.datasetIndex,
              context.dataIndex,
            )
            const dataset = context.dataset as AdminStackedBarChartDataset
            const label = dataset.stackLabel
              ? `${dataset.stackLabel} · ${dataset.label ?? ''}`
              : dataset.label ?? ''
            return formatAdminStackedBarTooltip(label, value, total)
```

- [ ] **Step 4: Pass grouped metadata through the Vue wrapper without changing legacy callers**

Extend the local `DataSeries` interface in `AdminStackedBarChart.vue`:

```ts
interface DataSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
  stack?: string
  stackLabel?: string
}
```

Pass the fields into datasets:

```ts
    stack: item.stack,
    stackLabel: item.stackLabel,
```

Detect grouped mode and pass it to the options builder:

```ts
const hasGroupedStacks = computed(() => props.series.some(item => item.stack !== undefined))
const chartOptions = computed(() => buildAdminStackedBarChartOptions(isDark.value, hasGroupedStacks.value))
```

- [ ] **Step 5: Run the chart tests and verify legacy and grouped behavior pass together**

Run:

```bash
bunx vitest run tests/admin-stacked-bar-chart.unit.test.ts
```

Expected: PASS. Existing non-grouped options remain `index` mode, while grouped data uses paired stacks and a dynamic legend.

- [ ] **Step 6: Commit the reusable chart extension**

```bash
git add src/components/admin/adminStackedBarChart.ts src/components/admin/AdminStackedBarChart.vue tests/admin-stacked-bar-chart.unit.test.ts
git commit -m "feat(admin): support grouped stacked bar charts"
```

---

### Task 6: Add frontend API types and the dynamic paired-series mapper

**Files:**
- Modify: `src/services/adminFrontendOnboarding.ts:1-165`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts:1-165`

- [ ] **Step 1: Extend the fixture and write a failing dynamic-series test**

Add `buildFrontendOnboardingDailySetupCliSeries` to the service imports in `tests/admin-frontend-onboarding-dashboard.unit.test.ts`.

Add this field to the shared `analytics` fixture after `v2_setup_cli_outcomes`:

```ts
    daily_setup_cli_outcomes: [{
      date: '2026-08-10',
      first_time: {
        cli_copy_init: 2,
        ai_copy_init: 0,
        both_copy_init: 0,
        no_copy_init: 0,
        cli_copy_other_cli: 0,
        ai_copy_other_cli: 0,
        both_copy_other_cli: 0,
        no_copy_other_cli: 0,
        cli_copy_no_cli: 0,
        ai_copy_no_cli: 0,
        both_copy_no_cli: 0,
        no_action: 0,
      },
      returning: {
        cli_copy_init: 0,
        ai_copy_init: 0,
        both_copy_init: 0,
        no_copy_init: 0,
        cli_copy_other_cli: 0,
        ai_copy_other_cli: 0,
        both_copy_other_cli: 0,
        no_copy_other_cli: 0,
        cli_copy_no_cli: 0,
        ai_copy_no_cli: 1,
        both_copy_no_cli: 0,
        no_action: 0,
      },
    }],
```

Add the mapper test:

```ts
  it.concurrent('builds paired stacks only for outcome categories present in the range', () => {
    const labels = {
      cli_copy_init: 'CLI copy + init',
      ai_copy_init: 'AI copy + init',
      both_copy_init: 'Both copied + init',
      no_copy_init: 'No copy + init',
      cli_copy_other_cli: 'CLI copy + other CLI',
      ai_copy_other_cli: 'AI copy + other CLI',
      both_copy_other_cli: 'Both copied + other CLI',
      no_copy_other_cli: 'No copy + other CLI',
      cli_copy_no_cli: 'CLI copied · no CLI run',
      ai_copy_no_cli: 'AI copied · no CLI run',
      both_copy_no_cli: 'Both copied · no CLI run',
      no_action: 'No action',
    }

    const series = buildFrontendOnboardingDailySetupCliSeries(
      analytics.daily_setup_cli_outcomes,
      labels,
      'First-time',
      'Returning',
    )

    expect(series).toHaveLength(4)
    expect(series.map(item => ({ label: item.label, stack: item.stack, stackLabel: item.stackLabel, value: item.data[0].value }))).toEqual([
      { label: 'CLI copy + init', stack: 'first_time', stackLabel: 'First-time', value: 2 },
      { label: 'CLI copy + init', stack: 'returning', stackLabel: 'Returning', value: 0 },
      { label: 'AI copied · no CLI run', stack: 'first_time', stackLabel: 'First-time', value: 0 },
      { label: 'AI copied · no CLI run', stack: 'returning', stackLabel: 'Returning', value: 1 },
    ])
    expect(series.some(item => item.label === 'No action')).toBe(false)
  })
```

- [ ] **Step 2: Run the dashboard service tests and verify the missing type/mapper failures**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the response type lacks `daily_setup_cli_outcomes` and the mapper is not exported.

- [ ] **Step 3: Add API types, outcome order/colors, and the mapper**

Add near the top of `src/services/adminFrontendOnboarding.ts`:

```ts
export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS = [
  'cli_copy_init',
  'ai_copy_init',
  'both_copy_init',
  'no_copy_init',
  'cli_copy_other_cli',
  'ai_copy_other_cli',
  'both_copy_other_cli',
  'no_copy_other_cli',
  'cli_copy_no_cli',
  'ai_copy_no_cli',
  'both_copy_no_cli',
  'no_action',
] as const

export type FrontendOnboardingDailySetupCliOutcomeKey = typeof FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS[number]
export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomePoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}
```

Add to `FrontendOnboardingAnalytics`:

```ts
  daily_setup_cli_outcomes: FrontendOnboardingDailySetupCliOutcomePoint[]
```

Extend `FrontendOnboardingDailySeries`:

```ts
  stack?: 'first_time' | 'returning'
  stackLabel?: string
```

Add the stable color map and mapper below `buildFrontendOnboardingDailySeries`:

```ts
const DAILY_SETUP_CLI_OUTCOME_COLORS: Record<FrontendOnboardingDailySetupCliOutcomeKey, string> = {
  cli_copy_init: '#047857',
  ai_copy_init: '#10b981',
  both_copy_init: '#34d399',
  no_copy_init: '#86efac',
  cli_copy_other_cli: '#1d4ed8',
  ai_copy_other_cli: '#3b82f6',
  both_copy_other_cli: '#7c3aed',
  no_copy_other_cli: '#a78bfa',
  cli_copy_no_cli: '#c2410c',
  ai_copy_no_cli: '#f97316',
  both_copy_no_cli: '#fbbf24',
  no_action: '#94a3b8',
}

export function buildFrontendOnboardingDailySetupCliSeries(
  points: readonly FrontendOnboardingDailySetupCliOutcomePoint[],
  labels: Record<FrontendOnboardingDailySetupCliOutcomeKey, string>,
  firstTimeLabel: string,
  returningLabel: string,
): FrontendOnboardingDailySeries[] {
  const activeKeys = FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.filter(key => points.some(
    point => point.first_time[key] + point.returning[key] > 0,
  ))

  return activeKeys.flatMap(key => ([
    {
      label: labels[key],
      color: DAILY_SETUP_CLI_OUTCOME_COLORS[key],
      stack: 'first_time' as const,
      stackLabel: firstTimeLabel,
      data: points.map(point => ({ date: point.date, value: point.first_time[key] })),
    },
    {
      label: labels[key],
      color: DAILY_SETUP_CLI_OUTCOME_COLORS[key],
      stack: 'returning' as const,
      stackLabel: returningLabel,
      data: points.map(point => ({ date: point.date, value: point.returning[key] })),
    },
  ]))
}
```

- [ ] **Step 4: Run the dashboard service tests and verify the dynamic mapper passes**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS, including the new mapper test and the still-unchanged page structure assertions.

- [ ] **Step 5: Commit the typed mapper**

```bash
git add src/services/adminFrontendOnboarding.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): map daily Setup CLI chart series"
```

---

### Task 7: Add the separate daily chart card and translations

**Files:**
- Modify: `src/pages/admin/dashboard/frontend-onboarding.vue:7-136,456-487`
- Modify: `messages/en.json`
- Modify: `tests/admin-frontend-onboarding-dashboard.unit.test.ts:360-521`

- [ ] **Step 1: Add failing structural and translation assertions**

Update the existing component-count expectations:

```ts
    expect(source.match(/<ChartCard(?:\s|\/?>)/g)).toHaveLength(6)
    expect(source.match(/<AdminBarChart(?:\s|\/?>)/g)).toHaveLength(1)
    expect(source.match(/<AdminStackedBarChart(?:\s|\/?>)/g)).toHaveLength(2)
```

Add the new card ordering assertion while preserving the aggregate chart assertion:

```ts
    const dailyCliOutcomeIndex = source.indexOf(`t('frontend-onboarding-daily-setup-cli-outcomes-v2')`)
    expect(source).toContain(':values="setupCliOutcomeValues"')
    expect(source).toContain('visibleAnalytics.value?.v2_setup_cli_outcomes')
    expect(cliOutcomeIndex).toBeLessThan(dailyCliOutcomeIndex)
    expect(dailyCliOutcomeIndex).toBeLessThan(legacyIndex)
```

Add translation assertions to the English-label test:

```ts
    expect(messages['frontend-onboarding-daily-setup-cli-outcomes-v2']).toBe('Daily Setup → CLI outcomes (v2)')
    expect(messages['frontend-onboarding-daily-setup-cli-first-time']).toBe('First-time')
    expect(messages['frontend-onboarding-daily-setup-cli-returning']).toBe('Returning')
    expect(messages['frontend-onboarding-daily-setup-cli-no-action']).toBe('No action')
```

- [ ] **Step 2: Run the dashboard tests and verify the card/translation failures**

Run:

```bash
bunx vitest run tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: FAIL because the page still has five cards/one stacked chart and the new translation keys are missing.

- [ ] **Step 3: Add translated labels and paired-series computed state to the page**

Add `FrontendOnboardingDailySetupCliOutcomeKey` to the existing type-only service import in `frontend-onboarding.vue`, and add the mapper to the existing value import:

```ts
import type {
  FrontendOnboardingAnalytics,
  FrontendOnboardingDailySetupCliOutcomeKey,
} from '~/services/adminFrontendOnboarding'
```

```ts
  buildFrontendOnboardingDailySetupCliSeries,
```

After `hasSetupCliOutcomeData`, add:

```ts
const dailySetupCliOutcomeLabels = computed<Record<FrontendOnboardingDailySetupCliOutcomeKey, string>>(() => ({
  cli_copy_init: t('frontend-onboarding-daily-setup-cli-cli-copy-init'),
  ai_copy_init: t('frontend-onboarding-daily-setup-cli-ai-copy-init'),
  both_copy_init: t('frontend-onboarding-daily-setup-cli-both-copy-init'),
  no_copy_init: t('frontend-onboarding-daily-setup-cli-no-copy-init'),
  cli_copy_other_cli: t('frontend-onboarding-daily-setup-cli-cli-copy-other-cli'),
  ai_copy_other_cli: t('frontend-onboarding-daily-setup-cli-ai-copy-other-cli'),
  both_copy_other_cli: t('frontend-onboarding-daily-setup-cli-both-copy-other-cli'),
  no_copy_other_cli: t('frontend-onboarding-daily-setup-cli-no-copy-other-cli'),
  cli_copy_no_cli: t('frontend-onboarding-daily-setup-cli-cli-copy-no-cli'),
  ai_copy_no_cli: t('frontend-onboarding-daily-setup-cli-ai-copy-no-cli'),
  both_copy_no_cli: t('frontend-onboarding-daily-setup-cli-both-copy-no-cli'),
  no_action: t('frontend-onboarding-daily-setup-cli-no-action'),
}))
const dailySetupCliSeries = computed(() => buildFrontendOnboardingDailySetupCliSeries(
  visibleAnalytics.value?.daily_setup_cli_outcomes ?? [],
  dailySetupCliOutcomeLabels.value,
  t('frontend-onboarding-daily-setup-cli-first-time'),
  t('frontend-onboarding-daily-setup-cli-returning'),
))
const hasDailySetupCliOutcomeData = computed(() => dailySetupCliSeries.value.length > 0)
```

- [ ] **Step 4: Add the separate chart card below the existing aggregate card**

Insert this block immediately after the existing `AdminBarChart` outcome `ChartCard` and before the legacy v1 section:

```vue
          <ChartCard
            :title="t('frontend-onboarding-daily-setup-cli-outcomes-v2')"
            :is-loading="isLoadingStats"
            :has-data="hasDailySetupCliOutcomeData"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('frontend-onboarding-daily-setup-cli-outcomes-v2') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-daily-setup-cli-outcomes-description') }}
                </p>
              </div>
            </template>
            <AdminStackedBarChart
              :series="dailySetupCliSeries"
              :is-loading="isLoadingStats"
              accessible-borders
            />
          </ChartCard>
```

Do not add `:total` or `:unit`; the measure is person-days and returning people can appear on multiple dates.

- [ ] **Step 5: Add all English translations**

Add these keys to `messages/en.json` next to the existing Setup CLI outcome keys:

```json
"frontend-onboarding-daily-setup-cli-outcomes-v2": "Daily Setup → CLI outcomes (v2)",
"frontend-onboarding-daily-setup-cli-outcomes-description": "Each person is counted once per UTC day. Left: first-time Setup views; right: returning views. Actions are attributed for up to 24 hours.",
"frontend-onboarding-daily-setup-cli-first-time": "First-time",
"frontend-onboarding-daily-setup-cli-returning": "Returning",
"frontend-onboarding-daily-setup-cli-cli-copy-init": "CLI copy + init",
"frontend-onboarding-daily-setup-cli-ai-copy-init": "AI copy + init",
"frontend-onboarding-daily-setup-cli-both-copy-init": "Both copied + init",
"frontend-onboarding-daily-setup-cli-no-copy-init": "No copy + init",
"frontend-onboarding-daily-setup-cli-cli-copy-other-cli": "CLI copy + other CLI",
"frontend-onboarding-daily-setup-cli-ai-copy-other-cli": "AI copy + other CLI",
"frontend-onboarding-daily-setup-cli-both-copy-other-cli": "Both copied + other CLI",
"frontend-onboarding-daily-setup-cli-no-copy-other-cli": "No copy + other CLI",
"frontend-onboarding-daily-setup-cli-cli-copy-no-cli": "CLI copied · no CLI run",
"frontend-onboarding-daily-setup-cli-ai-copy-no-cli": "AI copied · no CLI run",
"frontend-onboarding-daily-setup-cli-both-copy-no-cli": "Both copied · no CLI run",
"frontend-onboarding-daily-setup-cli-no-action": "No action"
```

- [ ] **Step 6: Run the complete frontend feature tests**

Run:

```bash
bunx vitest run tests/admin-stacked-bar-chart.unit.test.ts tests/admin-frontend-onboarding-dashboard.unit.test.ts
```

Expected: PASS with six `ChartCard` instances, two `AdminStackedBarChart` instances, the existing aggregate `AdminBarChart`, the new card below it, and all mapper/legend behavior green.

- [ ] **Step 7: Commit the dashboard card**

```bash
git add src/pages/admin/dashboard/frontend-onboarding.vue src/services/adminFrontendOnboarding.ts messages/en.json tests/admin-frontend-onboarding-dashboard.unit.test.ts
git commit -m "feat(admin): chart daily Setup CLI outcomes"
```

---

### Task 8: Run full validation and inspect the final diff

**Files:**
- Verify all files listed in Tasks 1-7

- [ ] **Step 1: Run formatting/lint validation for frontend and backend**

Run:

```bash
bun lint
bun lint:backend
```

Expected: both commands exit 0 with no lint errors.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
bun typecheck
```

Expected: exit 0 with no frontend, backend, or CLI type errors.

- [ ] **Step 3: Run the complete unit suite**

Run:

```bash
bun test:unit
```

Expected: all unit tests pass, including the four onboarding analytics suites and the stacked-chart/dashboard suites.

- [ ] **Step 4: Verify formatting and scope**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff origin/main...HEAD -- supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts
```

Expected:

- `git diff --check` prints nothing.
- `git status --short` shows only the pre-existing unrelated `codedb.snapshot` modification, if it is still present.
- The final diff command prints nothing, proving the existing aggregate analytics model and `buildV2SetupCliOutcomes` were not modified.

- [ ] **Step 5: Review the implementation against the design acceptance criteria**

Confirm all of these from tests and the final diff:

- the old aggregate card and `v2_setup_cli_outcomes` remain intact;
- the new API field contains every selected UTC date;
- every displayed person-day is in exactly one category;
- a later Setup anchor owns overlapping actions;
- a follow-up-tail anchor truncates the final displayed day;
- grouped tooltips use a single lifecycle denominator;
- zero-only outcome categories are absent from the legend;
- the daily card has no misleading range-level people total.
