import type { FrontendOnboardingDailySetupCliEvent } from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts'
import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingDailySetupCliAgentUsage,
  buildFrontendOnboardingDailySetupCliOutcomes,
  classifyFrontendOnboardingDailySetupCliOutcome,
  createFrontendOnboardingDailySetupCliOutcomeCounts,
  FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS,
} from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts'

function utcMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`)
}

function setup(personId: string, timestampMs: number): FrontendOnboardingDailySetupCliEvent {
  return { personId, timestampMs, kind: 'setup' }
}

function cli(
  personId: string,
  timestampMs: number,
  agent: { agentInvoker?: boolean, agentId?: string, agentName?: string } = {},
): FrontendOnboardingDailySetupCliEvent {
  return { personId, timestampMs, kind: 'cli_command', commandPath: 'app list', ...agent }
}

function categoryTotal(point: ReturnType<typeof buildFrontendOnboardingDailySetupCliOutcomes>[number], lifecycle: 'first_time' | 'returning'): number {
  return Object.values(point[lifecycle]).reduce((total, count) => total + count, 0)
}

describe('classifyFrontendOnboardingDailySetupCliOutcome', () => {
  it.each([
    [true, false, true, false, 'cli_copy_init'],
    [false, true, true, false, 'ai_copy_init'],
    [true, true, true, false, 'both_copy_init'],
    [false, false, true, false, 'no_copy_init'],
    [true, false, false, true, 'cli_copy_other_cli'],
    [false, true, false, true, 'ai_copy_other_cli'],
    [true, true, false, true, 'both_copy_other_cli'],
    [false, false, false, true, 'no_copy_other_cli'],
    [true, false, false, false, 'cli_copy_no_cli'],
    [false, true, false, false, 'ai_copy_no_cli'],
    [true, true, false, false, 'both_copy_no_cli'],
    [false, false, false, false, 'no_action'],
  ] as const)('classifies cliCopied=%s, aiCopied=%s, initRun=%s, otherCliRun=%s as %s', (cliCopied, aiCopied, initRun, otherCliRun, expected) => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome({ cliCopied, aiCopied, initRun, otherCliRun })).toBe(expected)
  })

  it.each([
    [false, false, 'no_copy_init'],
    [true, false, 'cli_copy_init'],
    [false, true, 'ai_copy_init'],
    [true, true, 'both_copy_init'],
  ] as const)('prioritizes init over another CLI command for cliCopied=%s and aiCopied=%s', (cliCopied, aiCopied, expected) => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome({
      cliCopied,
      aiCopied,
      initRun: true,
      otherCliRun: true,
    })).toBe(expected)
  })

  it('exports every outcome key once in taxonomy order', () => {
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
    expect(new Set(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS).size).toBe(12)
  })

  it('creates zero counts in canonical outcome order', () => {
    expect(Object.entries(createFrontendOnboardingDailySetupCliOutcomeCounts())).toEqual(
      FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.map(key => [key, 0]),
    )
  })
})

describe('buildFrontendOnboardingDailySetupCliOutcomes', () => {
  it('keeps only the earliest Setup view for a person UTC day', () => {
    const august3 = utcMs('2026-08-03')

    expect(buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august3 + 4_000),
      setup('person', august3 + 1_000),
      { personId: 'person', timestampMs: august3 + 2_000, kind: 'cli_copy' },
    ], august3, august3 + 86_400_000)).toMatchObject([
      {
        date: '2026-08-03',
        first_time: { cli_copy_no_cli: 1 },
        returning: { no_action: 0 },
      },
    ])
  })

  it('does not let a pre-range Setup suppress an in-range Setup on the same UTC day', () => {
    const august3 = utcMs('2026-08-03')
    const startMs = august3 + 12 * 60 * 60 * 1_000

    expect(buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august3 + 9 * 60 * 60 * 1_000),
      setup('person', august3 + 13 * 60 * 60 * 1_000),
    ], startMs, august3 + 86_400_000)).toMatchObject([
      { date: '2026-08-03', first_time: { no_action: 1 } },
    ])
  })

  it('classifies first-time and returning Setup person-days and zero-fills dates', () => {
    const august3 = utcMs('2026-08-03')
    const august4 = utcMs('2026-08-04')
    const august6 = utcMs('2026-08-06')
    const points = buildFrontendOnboardingDailySetupCliOutcomes([
      setup('returning-person', august3 + 1_000),
      { personId: 'returning-person', timestampMs: august3 + 2_000, kind: 'ai_copy' },
      setup('returning-person', august4 + 1_000),
      { personId: 'returning-person', timestampMs: august4 + 2_000, kind: 'cli_command', commandPath: 'init' },
      setup('independent-person', august4 + 3_000),
      { personId: 'independent-person', timestampMs: august4 + 4_000, kind: 'cli_copy' },
      { personId: 'independent-person', timestampMs: august4 + 5_000, kind: 'cli_command', commandPath: 'deploy' },
    ], august3, august6)

    expect(points).toMatchObject([
      { date: '2026-08-03', first_time: { ai_copy_no_cli: 1 } },
      {
        date: '2026-08-04',
        first_time: { cli_copy_other_cli: 1 },
        returning: { no_copy_init: 1 },
      },
      { date: '2026-08-05' },
    ])
    expect(categoryTotal(points[2], 'first_time')).toBe(0)
    expect(categoryTotal(points[2], 'returning')).toBe(0)
  })

  it('uses an end-boundary Setup only to truncate the final displayed window', () => {
    const august31 = utcMs('2026-08-31')
    const september1 = utcMs('2026-09-01')

    expect(buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august31 + 23 * 60 * 60 * 1_000 + 30 * 60 * 1_000),
      setup('person', september1 + 15 * 60 * 1_000),
      { personId: 'person', timestampMs: september1 + 20 * 60 * 1_000, kind: 'cli_command', commandPath: 'init' },
    ], august31, september1)).toMatchObject([
      { date: '2026-08-31', first_time: { no_action: 1 } },
    ])
  })

  it('assigns a next-anchor boundary action to that new anchor and excludes the 24-hour boundary', () => {
    const august3 = utcMs('2026-08-03')
    const august4 = utcMs('2026-08-04')
    const august5 = utcMs('2026-08-05')
    const points = buildFrontendOnboardingDailySetupCliOutcomes([
      setup('next-anchor', august3 + 1_000),
      setup('next-anchor', august4 + 1_000),
      { personId: 'next-anchor', timestampMs: august4 + 1_000, kind: 'cli_copy' },
      setup('twenty-four-hours', august3 + 2_000),
      { personId: 'twenty-four-hours', timestampMs: august4 + 2_000, kind: 'cli_copy' },
    ], august3, august5)

    expect(points).toMatchObject([
      { date: '2026-08-03', first_time: { no_action: 2 } },
      { date: '2026-08-04', returning: { cli_copy_no_cli: 1 } },
    ])
  })

  it.each([
    ['cli then ai', ['cli_copy', 'ai_copy']],
    ['ai then cli', ['ai_copy', 'cli_copy']],
  ] as const)('classifies %s copy order as both_copy_init', (_description, copyKinds) => {
    const august3 = utcMs('2026-08-03')

    const points = buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august3 + 1_000),
      { personId: 'person', timestampMs: august3 + 2_000, kind: copyKinds[0] },
      { personId: 'person', timestampMs: august3 + 3_000, kind: copyKinds[1] },
      { personId: 'person', timestampMs: august3 + 4_000, kind: 'cli_command', commandPath: 'init' },
    ], august3, august3 + 86_400_000)

    expect(points[0].first_time.both_copy_init).toBe(1)
  })

  it('treats whitespace-padded init as another CLI command', () => {
    const august3 = utcMs('2026-08-03')

    expect(buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august3 + 1_000),
      { personId: 'person', timestampMs: august3 + 2_000, kind: 'cli_command', commandPath: ' init ' },
    ], august3, august3 + 86_400_000)[0].first_time.no_copy_other_cli).toBe(1)
  })

  it('treats an in-range Setup as first-time despite pre-range Setup history', () => {
    const august2 = utcMs('2026-08-02')
    const august3 = utcMs('2026-08-03')

    expect(buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', august2 + 1_000),
      setup('person', august3 + 1_000),
    ], august3, august3 + 86_400_000)[0].first_time.no_action).toBe(1)
  })

  it('rejects invalid bounds and normalized events', () => {
    const august3 = utcMs('2026-08-03')

    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([], august3, august3)).toThrow(RangeError)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([], Number.NaN, august3)).toThrow(RangeError)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([], august3, august3 - 1)).toThrow(RangeError)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([
      setup('  ', august3),
    ], august3, august3 + 86_400_000)).toThrow(/personId/i)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person', Number.NaN),
    ], august3, august3 + 86_400_000)).toThrow(/timestampMs/i)
    expect(() => buildFrontendOnboardingDailySetupCliOutcomes([
      { personId: 'person', timestampMs: august3, kind: 'cli_command' },
    ], august3, august3 + 86_400_000)).toThrow(/commandPath/i)
  })

  it('keeps category totals equal to displayed Setup person-days for each date and lifecycle', () => {
    const august3 = utcMs('2026-08-03')
    const august5 = utcMs('2026-08-05')
    const points = buildFrontendOnboardingDailySetupCliOutcomes([
      setup('person-a', august3 + 1_000),
      setup('person-a', august3 + 2_000),
      setup('person-a', august3 + 86_400_000 + 1_000),
      setup('person-b', august3 + 3_000),
      { personId: 'person-b', timestampMs: august3 + 4_000, kind: 'cli_copy' },
    ], august3, august5)

    const expectedSetupPersonDays: Record<string, Record<'first_time' | 'returning', number>> = {
      '2026-08-03': { first_time: 2, returning: 0 },
      '2026-08-04': { first_time: 0, returning: 1 },
    }

    for (const point of points) {
      for (const lifecycle of ['first_time', 'returning'] as const)
        expect(categoryTotal(point, lifecycle)).toBe(expectedSetupPersonDays[point.date][lifecycle])
    }
  })
})

describe('buildFrontendOnboardingDailySetupCliAgentUsage', () => {
  it.each([
    ['no_cli_invoked', []],
    ['no_agent', [{ agentInvoker: false }]],
    ['agent:codex', [{ agentInvoker: true, agentId: 'codex', agentName: 'Codex' }]],
    ['agent:codex', [
      { agentInvoker: true, agentId: 'codex', agentName: 'Codex' },
      { agentInvoker: true, agentId: 'codex', agentName: 'Codex' },
    ]],
    ['multiple_agents', [
      { agentInvoker: true, agentId: 'codex', agentName: 'Codex' },
      { agentInvoker: true, agentId: 'claude-code', agentName: 'Claude Code' },
    ]],
    ['unknown_agent', [{ agentInvoker: true }]],
    ['multiple_agents', [
      { agentInvoker: true, agentId: 'codex', agentName: 'Codex' },
      { agentInvoker: true },
    ]],
  ] as const)('classifies a Setup person-day as %s', (expectedKey, agents) => {
    const august3 = utcMs('2026-08-03')
    const events: FrontendOnboardingDailySetupCliEvent[] = [setup('person', august3 + 1_000)]
    agents.forEach((agent, index) => events.push(cli('person', august3 + 2_000 + index, agent)))

    const usage = buildFrontendOnboardingDailySetupCliAgentUsage(events, august3, august3 + 86_400_000)

    expect(usage.points).toEqual([{
      date: '2026-08-03',
      counts: { [expectedKey]: 1 },
    }])
    expect(usage.groups.map(group => group.key)).toEqual([expectedKey])
  })

  it('keeps attribution on the latest Setup anchor and excludes the 24-hour boundary', () => {
    const august3 = utcMs('2026-08-03')
    const august4 = utcMs('2026-08-04')
    const august5 = utcMs('2026-08-05')

    expect(buildFrontendOnboardingDailySetupCliAgentUsage([
      setup('next-anchor', august3 + 1_000),
      setup('next-anchor', august4 + 1_000),
      cli('next-anchor', august4 + 1_000, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
      setup('twenty-four-hours', august3 + 2_000),
      cli('twenty-four-hours', august4 + 2_000, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
    ], august3, august5)).toEqual({
      groups: [
        { key: 'agent:codex', agent_id: 'codex', agent_name: 'Codex' },
        { key: 'no_cli_invoked' },
      ],
      points: [
        { date: '2026-08-03', counts: { 'agent:codex': 0, no_cli_invoked: 2 } },
        { date: '2026-08-04', counts: { 'agent:codex': 1, no_cli_invoked: 0 } },
      ],
    })
  })

  it('zero-fills UTC dates and keeps daily group totals equal to Setup person-days', () => {
    const august3 = utcMs('2026-08-03')
    const august6 = utcMs('2026-08-06')
    const usage = buildFrontendOnboardingDailySetupCliAgentUsage([
      setup('person-a', august3 + 1_000),
      setup('person-a', august3 + 2_000),
      cli('person-a', august3 + 3_000, { agentInvoker: false }),
      setup('person-b', august3 + 4_000),
      cli('person-b', august3 + 5_000, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' }),
    ], august3, august6)

    expect(usage.groups).toEqual([
      { key: 'agent:codex', agent_id: 'codex', agent_name: 'Codex' },
      { key: 'no_agent' },
    ])
    expect(usage.points).toEqual([
      { date: '2026-08-03', counts: { 'agent:codex': 1, no_agent: 1 } },
      { date: '2026-08-04', counts: { 'agent:codex': 0, no_agent: 0 } },
      { date: '2026-08-05', counts: { 'agent:codex': 0, no_agent: 0 } },
    ])
    expect(usage.points.map(point => Object.values(point.counts).reduce((sum, count) => sum + count, 0))).toEqual([2, 0, 0])
  })

  it('sorts detected agents by total then name and appends reserved groups in taxonomy order', () => {
    const august3 = utcMs('2026-08-03')
    const events: FrontendOnboardingDailySetupCliEvent[] = []
    const add = (personId: string, offset: number, agent?: { agentInvoker?: boolean, agentId?: string, agentName?: string }) => {
      events.push(setup(personId, august3 + offset))
      if (agent)
        events.push(cli(personId, august3 + offset + 1, agent))
    }

    add('codex-1', 1_000, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' })
    add('codex-2', 2_000, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' })
    add('zed', 3_000, { agentInvoker: true, agentId: 'zed', agentName: 'Zed' })
    add('claude', 4_000, { agentInvoker: true, agentId: 'claude-code', agentName: 'Claude Code' })
    events.push(setup('multiple', august3 + 5_000))
    events.push(cli('multiple', august3 + 5_001, { agentInvoker: true, agentId: 'codex', agentName: 'Codex' }))
    events.push(cli('multiple', august3 + 5_002, { agentInvoker: true, agentId: 'claude-code', agentName: 'Claude Code' }))
    add('unknown', 6_000, { agentInvoker: true })
    add('no-agent', 7_000, { agentInvoker: false })
    add('no-cli', 8_000)

    expect(buildFrontendOnboardingDailySetupCliAgentUsage(events, august3, august3 + 86_400_000).groups).toEqual([
      { key: 'agent:codex', agent_id: 'codex', agent_name: 'Codex' },
      { key: 'agent:claude-code', agent_id: 'claude-code', agent_name: 'Claude Code' },
      { key: 'agent:zed', agent_id: 'zed', agent_name: 'Zed' },
      { key: 'multiple_agents' },
      { key: 'unknown_agent' },
      { key: 'no_agent' },
      { key: 'no_cli_invoked' },
    ])
  })

  it('uses the first non-empty name reported for an agent identity', () => {
    const august3 = utcMs('2026-08-03')

    expect(buildFrontendOnboardingDailySetupCliAgentUsage([
      setup('person', august3 + 1_000),
      cli('person', august3 + 2_000, { agentInvoker: true, agentId: 'codex', agentName: 'Zeta Codex' }),
      cli('person', august3 + 3_000, { agentInvoker: true, agentId: 'codex', agentName: 'Alpha Codex' }),
    ], august3, august3 + 86_400_000).groups).toEqual([
      { key: 'agent:codex', agent_id: 'codex', agent_name: 'Zeta Codex' },
    ])
  })
})
