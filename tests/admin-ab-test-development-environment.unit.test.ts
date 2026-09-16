import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAdminABTestDevelopmentEnvironment,
  getAdminABTestDevelopmentEnvironment,
} from '../supabase/functions/_backend/utils/ab_test_development_environment.ts'
import { AB_TESTS_CONFIG } from '../supabase/functions/_backend/utils/ab_tests.ts'

const { closeClientMock, getPgClientMock, queryMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(async () => undefined),
  getPgClientMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

describe('admin A/B test development environment aggregation', () => {
  it.concurrent('normalizes SQL counts and returns all five outcomes in stable order', () => {
    expect(buildAdminABTestDevelopmentEnvironment([
      { outcome: 'other', people: '2' },
      { outcome: 'ai_assistant', people: 3 },
      { outcome: 'no_selection_yet', people: '1' },
    ])).toEqual({
      total: 6,
      outcomes: [
        { outcome: 'ai_assistant', count: 3 },
        { outcome: 'hosted_builder', count: 0 },
        { outcome: 'other', count: 2 },
        { outcome: 'hand_coded', count: 0 },
        { outcome: 'no_selection_yet', count: 1 },
      ],
    })
    expect(buildAdminABTestDevelopmentEnvironment([]).outcomes).toHaveLength(5)
    expect(buildAdminABTestDevelopmentEnvironment([]).total).toBe(0)
  })

  it.concurrent.each(['', ' ', '-1', '1.5', 'invalid', 'Infinity', '9007199254740992', '0x10', '1e2', Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('throws for malformed or unsafe SQL count %s', (people) => {
    expect(() => buildAdminABTestDevelopmentEnvironment([{ outcome: 'ai_assistant', people }])).toThrow()
  })

  it.concurrent('rejects unknown outcomes and bucket or total overflow', () => {
    expect(() => buildAdminABTestDevelopmentEnvironment([{ outcome: 'legacy', people: 1 }])).toThrow()
    expect(() => buildAdminABTestDevelopmentEnvironment([{ outcome: null, people: 1 }])).toThrow()
    for (const outcome of ['ai_assistant', 'hosted_builder']) {
      expect(() => buildAdminABTestDevelopmentEnvironment([
        { outcome: 'ai_assistant', people: Number.MAX_SAFE_INTEGER },
        { outcome, people: 1 },
      ])).toThrow()
    }
  })
})

describe('admin A/B test development environment replica query', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getPgClientMock.mockReturnValue({ query: queryMock })
    queryMock.mockResolvedValue({ rows: [] })
  })

  it('counts one user row in the C assignment cohort using only their saved answer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ outcome: 'hand_coded', people: '4' }, { outcome: 'no_selection_yet', people: '2' }] })
    const context = {} as never
    expect(await getAdminABTestDevelopmentEnvironment(context)).toMatchObject({ total: 6 })
    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(queryMock).toHaveBeenCalledOnce()
    const [query, parameters] = queryMock.mock.calls[0]
    expect(query).toContain(`FROM public.users AS user_account`)
    expect(query).toContain(`WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb`)
    expect(query).toContain(`WHEN user_account.onboarding ->> 'development_environment' = ANY($2::text[])`)
    expect(query).toContain(`THEN user_account.onboarding ->> 'development_environment'`)
    expect(query).toContain(`ELSE 'no_selection_yet'`)
    expect(query).toContain('count(*)::bigint AS people')
    expect(query).toContain('GROUP BY 1')
    expect(query).not.toMatch(/\b(?:JOIN|UNION|OR)\b|public\.orgs|posthog|5\.C/i)
    expect(parameters).toEqual([
      JSON.stringify({ webnativeapp_development_environment: { branch: 'C' } }),
      ['ai_assistant', 'hosted_builder', 'other', 'hand_coded'],
    ])
    expect(closeClientMock).toHaveBeenCalledWith(context, getPgClientMock.mock.results[0].value)
  })

  it('closes the client after query failure and malformed result failure', async () => {
    const context = {} as never
    queryMock.mockRejectedValueOnce(new Error('replica unavailable'))
    await expect(getAdminABTestDevelopmentEnvironment(context)).rejects.toThrow('replica unavailable')
    queryMock.mockResolvedValueOnce({ rows: [{ outcome: 'ai_assistant', people: 'bad' }] })
    await expect(getAdminABTestDevelopmentEnvironment(context)).rejects.toThrow()
    expect(closeClientMock).toHaveBeenCalledTimes(2)
  })

  it('throws for missing test configuration and still closes the client', async () => {
    const test = AB_TESTS_CONFIG.webnativeapp_development_environment
    delete AB_TESTS_CONFIG.webnativeapp_development_environment
    try {
      await expect(getAdminABTestDevelopmentEnvironment({} as never)).rejects.toThrow('Missing A/B test configuration')
      expect(queryMock).not.toHaveBeenCalled()
      expect(closeClientMock).toHaveBeenCalledOnce()
    }
    finally {
      AB_TESTS_CONFIG.webnativeapp_development_environment = test
    }
  })
})
