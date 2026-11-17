import { describe, expect, it, vi } from 'vitest'

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => ({
  ...(await vi.importActual<typeof import('../supabase/functions/_backend/utils/utils.ts')>('../supabase/functions/_backend/utils/utils.ts')),
  isStripeConfigured: () => true,
}))

const { statisticsTestUtils } = await import('../supabase/functions/_backend/public/statistics/index.ts')

const ORG_1 = '00000000-0000-4000-8000-000000000001'
const ORG_2 = '00000000-0000-4000-8000-000000000002'
const ORG_3 = '00000000-0000-4000-8000-000000000003'

function fakeDb(status: Record<string, boolean | null> | Error) {
  const calls: unknown[][] = []
  const db = async (_text: string, values: unknown[]) => {
    calls.push(values)
    if (status instanceof Error)
      throw status
    // Like PostgreSQL: WITH ORDINALITY yields a bigint (string from pg), uuids come back lowercased.
    return (values[0] as string[]).map((orgId, index) => ({ ord: String(index + 1), is_paying_and_good_plan_org: status[orgId.toLowerCase()] ?? null })) as any[]
  }
  return { db: db as any, calls }
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise
  }
  catch (error) {
    const httpError = error as { status: number, cause?: { error?: string, moreInfo?: Record<string, unknown> } }
    return { status: httpError.status, code: httpError.cause?.error, moreInfo: httpError.cause?.moreInfo }
  }
  return null
}

describe('statistics organization access batch', () => {
  const c = { get: () => undefined } as any

  it.concurrent('checks every organization in one read', async () => {
    const { db, calls } = fakeDb({ [ORG_1]: true, [ORG_2]: true, [ORG_3]: true })
    await expect(statisticsTestUtils.checkOrganizationsAccess(c, [ORG_1, ORG_2, ORG_3], db)).resolves.toBeUndefined()
    expect(calls).toEqual([[[ORG_1, ORG_2, ORG_3]]])
  })

  it.concurrent('fails with 402 on the first organization that is not paying, in order', async () => {
    const { db } = fakeDb({ [ORG_1]: true, [ORG_2]: false, [ORG_3]: null })
    expect(await errorOf(statisticsTestUtils.checkOrganizationsAccess(c, [ORG_1, ORG_2, ORG_3], db))).toMatchObject({
      status: 402,
      code: 'subscription_required',
      moreInfo: { orgId: ORG_2, isPayingAndGoodPlan: false },
    })

    const { db: nullDb } = fakeDb({ [ORG_1]: true, [ORG_3]: null })
    expect(await errorOf(statisticsTestUtils.checkOrganizationsAccess(c, [ORG_3, ORG_1], nullDb))).toMatchObject({
      status: 402,
      moreInfo: { orgId: ORG_3, isPayingAndGoodPlan: null },
    })
  })

  it.concurrent('accepts an uppercase organization id', async () => {
    const upper = 'ABCDEF00-0000-4000-8000-000000000001'
    const { db } = fakeDb({ [upper.toLowerCase()]: true })
    await expect(statisticsTestUtils.checkOrganizationsAccess(c, [upper], db)).resolves.toBeUndefined()
  })

  it.concurrent('fails with 404 when the status read fails', async () => {
    const { db } = fakeDb(new Error('boom'))
    expect(await errorOf(statisticsTestUtils.checkOrganizationsAccess(c, [ORG_1, ORG_2], db))).toMatchObject({
      status: 404,
      code: 'organization_not_found',
    })
  })

  it.concurrent('skips the read when there is no organization', async () => {
    const { db, calls } = fakeDb({})
    await statisticsTestUtils.checkOrganizationsAccess(c, [], db)
    expect(calls).toHaveLength(0)
  })
})
