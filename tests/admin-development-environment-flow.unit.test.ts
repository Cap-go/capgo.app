import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDevelopmentEnvironmentFlowHogql, getAdminDevelopmentEnvironmentFlow } from '../supabase/functions/_backend/utils/ab_test_development_environment_flow.ts'
import { buildDevelopmentEnvironmentFlow } from '../supabase/functions/_backend/utils/ab_test_development_environment_flow_model.ts'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({ queryPosthogHogql: queryMock }))

const start = '2026-09-01T00:00:00.000Z'
const end = '2026-09-16T00:00:00.000Z'
const question = 'publish_app_question'
const viewed = (timestampMs = 100, step = question) => ({ event: 'onboarding_step_viewed', step, timestampMs, answer: '' })
const selected = (timestampMs = 200) => ({ event: 'onboarding_development_environment_selected', step: question, timestampMs, answer: 'hosted_builder' })
const completed = (answer = 'hosted_builder', timestampMs = 300) => ({ event: 'onboarding_step_completed', step: question, timestampMs, answer })
const attempt = (personId: string, events = [viewed(), selected(), completed()], attemptId = personId) => ({ personId, attemptId, events })

describe('question exposure flow', () => {
  it.concurrent('separates answered, skipped, selected without continuing, and no answer without continuing', () => {
    expect(buildDevelopmentEnvironmentFlow([
      attempt('answered'),
      attempt('skipped', [viewed(), completed('skipped')]),
      attempt('selected-only', [selected(), viewed()]),
      attempt('left', [viewed()]),
      attempt('never-reached', [selected(), completed()]),
    ])).toEqual({ reached: 4, groups: [
      { answer: 'answered', people: 2, continued: 1, did_not_continue: 1 },
      { answer: 'skipped', people: 1, continued: 1, did_not_continue: 0 },
      { answer: 'no_answer', people: 1, continued: 0, did_not_continue: 1 },
    ] })
  })

  it.concurrent('requires advancement after exposure and keeps missing answers distinct from explicit skips', () => {
    const result = buildDevelopmentEnvironmentFlow([
      attempt('too-early', [completed('skipped', 50), viewed()]),
      attempt('lost-completion', [viewed(), selected(), viewed(300, 'app_name')]),
      attempt('unknown-answer', [viewed(), completed('legacy')]),
    ])
    expect(result.groups).toEqual([
      { answer: 'answered', people: 1, continued: 1, did_not_continue: 0 },
      { answer: 'skipped', people: 0, continued: 0, did_not_continue: 0 },
      { answer: 'no_answer', people: 2, continued: 1, did_not_continue: 1 },
    ])
  })

  it.concurrent('counts repeats and resumed attempts once, using first continuation or latest uncontinued attempt', () => {
    const result = buildDevelopmentEnvironmentFlow([
      attempt('returned', [viewed(), selected()], 'a'),
      attempt('returned', [viewed(500), completed('skipped', 600)], 'b'),
      attempt('returned', [viewed(700), selected(800), completed('hand_coded', 900)], 'c'),
      attempt('returned', [viewed(), selected()], 'a'),
      attempt('still-left', [viewed(), selected()], 'd'),
      attempt('still-left', [viewed(1000)], 'e'),
    ])
    expect(result.reached).toBe(2)
    expect(result.groups).toEqual([
      { answer: 'answered', people: 0, continued: 0, did_not_continue: 0 },
      { answer: 'skipped', people: 1, continued: 1, did_not_continue: 0 },
      { answer: 'no_answer', people: 1, continued: 0, did_not_continue: 1 },
    ])
  })

  it.concurrent('uses the decision at continuation and ignores selections made on later visits', () => {
    expect(buildDevelopmentEnvironmentFlow([attempt('person', [viewed(), selected(), completed('skipped'), selected(400)])]).groups[1].people).toBe(1)
    expect(() => buildDevelopmentEnvironmentFlow([attempt('', [viewed()])])).toThrow('identity')
  })
})

describe('bounded PostHog question query', () => {
  it.concurrent('reads raw text properties, production question exposures and only direct later views within the requested range', () => {
    const query = buildDevelopmentEnvironmentFlowHogql(start, end)
    expect(query).toContain("JSONExtractString(toString(properties), 'step')")
    expect(query).toContain("JSONExtractString(toString(properties), 'previous_step') = 'publish_app_question'")
    expect(query).toContain("'$host') = 'console.capgo.app'")
    expect(query).toContain("'flow') = 'pre_org'")
    expect(query).toContain(`timestamp >= parseDateTimeBestEffort('${start}')`)
    expect(query).toContain(`timestamp < parseDateTimeBestEffort('${end}')`)
    expect(query).toContain('LIMIT 50001')
    expect(query).toContain('GROUP BY person_id, attempt_id')
    expect(query).not.toMatch(/JOIN|public\.users|abtests|properties\.step/)
  })

  it.concurrent.each(['invalid', "2026-09-01T00:00:00Z' OR 1=1", '2026-02-30T00:00:00Z', '2026-09-01T25:00:00Z'])('rejects invalid date %s before interpolation', (date) => {
    expect(() => buildDevelopmentEnvironmentFlowHogql(date, end)).toThrow()
  })

  it.concurrent('rejects reversed and excessive ranges and accepts fractional seconds', () => {
    expect(() => buildDevelopmentEnvironmentFlowHogql(end, start)).toThrow()
    expect(() => buildDevelopmentEnvironmentFlowHogql('2024-01-01T00:00:00Z', end)).toThrow()
    expect(buildDevelopmentEnvironmentFlowHogql('2026-09-01T00:00:00.1Z', end)).toContain('2026-09-01T00:00:00.100Z')
  })
})

describe('question flow reporting', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [] })
  })

  it('returns a genuine empty result and exposes no person or attempt identifiers', async () => {
    queryMock.mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [
      { person_id: 'synthetic-person', attempt_id: 'synthetic-attempt', events: [['onboarding_step_viewed', question, 100, ''], ['onboarding_step_completed', question, 200, 'skipped']], total_events: 2, total_attempts: 1 },
    ] })
    const result = await getAdminDevelopmentEnvironmentFlow({} as never, start, end)
    expect(result.reached).toBe(1)
    expect(result.groups?.[1].continued).toBe(1)
    expect(JSON.stringify(result)).not.toContain('synthetic-')
    expect((await getAdminDevelopmentEnvironmentFlow({} as never, start, end)).reached).toBe(0)
  })

  it.each(['unconfigured', 'unavailable', 'timeout', 'too_large'])('reports %s as unavailable, never as zero', async (failureReason) => {
    queryMock.mockResolvedValueOnce({ configured: true, connected: false, failureReason, rows: [] })
    expect(await getAdminDevelopmentEnvironmentFlow({} as never, start, end)).toMatchObject({ reached: null, groups: null, data_quality: { failure_reason: failureReason } })
  })

  it.each([
    { total_events: 50001, total_attempts: 1 },
    { total_events: 1, total_attempts: 2 },
    { total_events: -1, total_attempts: 1 },
    { total_events: 1, total_attempts: 'invalid' },
    { total_events: 1, total_attempts: 1, attempt_id: '' },
    { total_events: 1, total_attempts: 1, events: [['onboarding_step_viewed', question, 'invalid', '']] },
  ])('rejects incomplete or invalid analytics: %j', async (changes) => {
    queryMock.mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [
      { person_id: 'synthetic-person', attempt_id: 'synthetic-attempt', events: [['onboarding_step_viewed', question, 100, '']], ...changes },
    ] })
    expect(await getAdminDevelopmentEnvironmentFlow({} as never, start, end)).toMatchObject({ reached: null, groups: null, data_quality: { failure_reason: 'invalid_data' } })
  })
})
