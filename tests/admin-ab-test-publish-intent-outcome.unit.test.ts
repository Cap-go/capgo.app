import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAdminABTestPublishIntentOutcome,
  getAdminABTestPublishIntentOutcome,
} from '../supabase/functions/_backend/utils/ab_test_publish_intent_outcome.ts'

const { closeClientMock, getPgClientMock, queryMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(async () => undefined),
  getPgClientMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

describe('admin A/B test Publish intent outcome', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getPgClientMock.mockReturnValue({ query: queryMock })
    queryMock.mockResolvedValue({ rows: [] })
  })

  it('builds outcomes in stable order and fills missing buckets with zero', () => {
    expect(buildAdminABTestPublishIntentOutcome([
      { inferred_people: 12, outcome: 'selected_another_intent', people: 197 },
      { inferred_people: '2', outcome: 'selected_publish', people: '104' },
    ])).toEqual({
      inferred_from_organization: 14,
      total: 301,
      outcomes: [
        { outcome: 'selected_publish', count: 104 },
        { outcome: 'selected_another_intent', count: 197 },
        { outcome: 'no_selection_yet', count: 0 },
      ],
    })
  })

  it('ignores unknown outcomes and invalid counts', () => {
    expect(buildAdminABTestPublishIntentOutcome([
      { outcome: 'selected_publish', people: '-1' },
      { outcome: 'selected_another_intent', people: 'not-a-count' },
      { outcome: 'unknown', people: 50 },
      { outcome: null, people: 12 },
      { outcome: 'no_selection_yet', people: '5' },
    ])).toEqual({
      inferred_from_organization: 0,
      total: 5,
      outcomes: [
        { outcome: 'selected_publish', count: 0 },
        { outcome: 'selected_another_intent', count: 0 },
        { outcome: 'no_selection_yet', count: 5 },
      ],
    })
  })

  it('queries unique exposed users on the replica and closes the pool', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { outcome: 'selected_publish', people: '4' },
        { outcome: 'selected_another_intent', people: '6' },
      ],
    })
    const context = { get: vi.fn(() => 'request-id') } as never

    const result = await getAdminABTestPublishIntentOutcome(context)

    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(queryMock).toHaveBeenCalledOnce()
    const [query, parameters] = queryMock.mock.calls[0] ?? []
    expect(query).toContain(`(user_account.onboarding -> 'abtests') @> $1::jsonb`)
    expect(query).toContain(`(user_account.onboarding -> 'abtests') @> $2::jsonb`)
    expect(query).toContain(`COALESCE(exposed_user.user_intent, inferred_organization.intent)`)
    expect(query).toContain(`WHERE exposed_user.user_intent IS NULL`)
    expect(query).toContain(`organization.created_by = exposed_user.id`)
    expect(query).toContain(`HAVING count(DISTINCT organization.onboarding ->> 'intent') = 1`)
    expect(query).toContain(`resolved_user.intent = ANY($4::text[])`)
    expect(query).toContain(`count(*) FILTER (WHERE resolved_user.inferred_from_organization)`)
    expect(parameters).toEqual([
      JSON.stringify({ webnativeapp_publish_intent: { branch: 'A' } }),
      JSON.stringify({ webnativeapp_development_environment: { branch: 'C' } }),
      ['publish', 'ota', 'builder', 'both', 'exploring'],
      ['ota', 'builder', 'both', 'exploring'],
    ])
    expect(result).toMatchObject({ inferred_from_organization: 0, total: 10 })
    expect(closeClientMock).toHaveBeenCalledWith(context, expect.anything())
  })
})
