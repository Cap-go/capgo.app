import type { ABTestConfig } from '../supabase/functions/_backend/utils/ab_tests.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAdminABTestDistribution,
  getAdminABTestDistribution,
} from '../supabase/functions/_backend/utils/ab_test_distribution.ts'

const { closeClientMock, getPgClientMock, queryMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(async () => undefined),
  getPgClientMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const config: Record<string, ABTestConfig> = {
  email_template: {
    audience: 'self_signup',
    label: 'Email template',
    treatment_percentage: 50,
    treatment_branch: 'A',
    control_branch: 'B',
    branches: {
      A: { bento_tag: 'ab:new_emails', label: 'New emails' },
      B: { bento_tag: 'ab:no_new_emails', label: 'Old emails' },
    },
  },
  empty_test: {
    audience: 'all',
    label: 'Empty test',
    treatment_percentage: 25,
    treatment_branch: 'C',
    control_branch: 'D',
    branches: {
      C: { bento_tag: 'ab:empty_treatment', label: 'Treatment' },
      D: { bento_tag: 'ab:empty_control', label: 'Control' },
    },
  },
}

describe('admin A/B test distribution', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getPgClientMock.mockReturnValue({ query: queryMock })
    queryMock.mockResolvedValue({ rows: [] })
  })

  it('builds configured tests in order with counts and percentages', () => {
    expect(buildAdminABTestDistribution([
      { test_name: 'email_template', branch: 'B', assignments: 403 },
      { test_name: 'email_template', branch: 'A', assignments: '400' },
    ], config)).toEqual([
      {
        test_name: 'email_template',
        label: 'Email template',
        total: 803,
        branches: [
          { branch: 'A', label: 'New emails', count: 400, percentage: 49.8 },
          { branch: 'B', label: 'Old emails', count: 403, percentage: 50.2 },
        ],
      },
      {
        test_name: 'empty_test',
        label: 'Empty test',
        total: 0,
        branches: [
          { branch: 'C', label: 'Treatment', count: 0, percentage: 0 },
          { branch: 'D', label: 'Control', count: 0, percentage: 0 },
        ],
      },
    ])
  })

  it('ignores unconfigured tests, invalid branches, and invalid counts', () => {
    expect(buildAdminABTestDistribution([
      { test_name: 'retired_test', branch: 'A', assignments: '200' },
      { test_name: 'email_template', branch: 'Z', assignments: '100' },
      { test_name: 'email_template', branch: 'A', assignments: '-1' },
      { test_name: 'email_template', branch: 'B', assignments: 'not-a-count' },
    ], config)[0]).toEqual({
      test_name: 'email_template',
      label: 'Email template',
      total: 0,
      branches: [
        { branch: 'A', label: 'New emails', count: 0, percentage: 0 },
        { branch: 'B', label: 'Old emails', count: 0, percentage: 0 },
      ],
    })
  })

  it('queries the replica once and closes the pool', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { test_name: 'new_emails', branch: 'A', assignments: '4' },
        { test_name: 'new_emails', branch: 'B', assignments: '6' },
      ],
    })
    const context = { get: vi.fn(() => 'request-id') } as never

    const result = await getAdminABTestDistribution(context)

    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock.mock.calls[0]?.[0]).toContain(`(user_account.onboarding -> 'abtests') ?| $1::text[]`)
    expect(queryMock.mock.calls[0]?.[1]).toEqual([expect.arrayContaining(['new_emails', 'new_channel'])])
    expect(result.find(test => test.test_name === 'new_emails')).toMatchObject({ total: 10 })
    expect(closeClientMock).toHaveBeenCalledWith(context, expect.anything())
  })
})
