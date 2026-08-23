import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
  syncBentoSubscriberTagsMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }))
  const pgReleaseMock = vi.fn<(destroy?: Error | boolean) => void>(() => undefined)
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  return {
    closeClientMock: vi.fn(async () => undefined),
    getPgClientMock: vi.fn(() => ({ connect: pgConnectMock })),
    pgConnectMock,
    pgQueryMock,
    pgReleaseMock,
    syncBentoSubscriberTagsMock: vi.fn<(
      c: unknown,
      update: { deleteSegments: string[], email: string, segments: string[] },
    ) => Promise<boolean | undefined>>(async () => true),
  }
})

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

type ABTestConfig = Record<string, {
  audience: 'all' | 'self_signup'
  branch_a_percentage: number
  branches: {
    A: { bento_tag: string }
    B: { bento_tag: string }
  }
}>

interface ABTestsModule {
  createABTestAssignments: (
    user: { created_via_invite: boolean },
    config: ABTestConfig,
    random: () => number,
    now: () => Date,
  ) => Record<string, { assigned_at: string, branch: 'A' | 'B' }>
  syncNewUserABTests: (
    c: unknown,
    email: string,
    user: { created_via_invite: boolean, id: string },
  ) => Promise<void>
  validateABTestsConfig: (value: unknown) => ABTestConfig
}

const modulePath = '../supabase/functions/_backend/utils/ab_tests.ts'
const FIXED_DATE = new Date('2026-08-23T12:34:56.000Z')
const USER_ID = '11111111-1111-4111-8111-111111111111'

async function loadABTestsModule() {
  return await import(/* @vite-ignore */ modulePath) as ABTestsModule
}

function testConfig(branchAPercentage = 50, audience: 'all' | 'self_signup' = 'self_signup') {
  return {
    new_emails: {
      audience,
      branch_a_percentage: branchAPercentage,
      branches: {
        A: { bento_tag: 'ab:new_emails' },
        B: { bento_tag: 'ab:no_new_emails' },
      },
    },
  }
}

describe('new-user A/B test assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgConnectMock.mockImplementation(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock }))
    closeClientMock.mockResolvedValue(undefined)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [0, 'A'],
    [0.4999, 'A'],
    [0.5, 'B'],
    [0.9999, 'B'],
  ] as const)('uses the configured 50%% boundary for random value %s', async (randomValue, branch) => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig())

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => randomValue,
      () => FIXED_DATE,
    )).toEqual({
      new_emails: {
        assigned_at: FIXED_DATE.toISOString(),
        branch,
      },
    })
  })

  it.each([
    [0, 'B'],
    [100, 'A'],
  ] as const)('uses %s%% branch-A allocation to always select branch %s', async (percentage, branch) => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(percentage))

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => 0.75,
      () => FIXED_DATE,
    ).new_emails?.branch).toBe(branch)
  })

  it('excludes invited users from self-signup experiments', async () => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()

    expect(createABTestAssignments(
      { created_via_invite: true },
      validateABTestsConfig(testConfig()),
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})
  })

  it('includes invited users in all-user experiments', async () => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()

    expect(createABTestAssignments(
      { created_via_invite: true },
      validateABTestsConfig(testConfig(50, 'all')),
      () => 0,
      () => FIXED_DATE,
    ).new_emails?.branch).toBe('A')
  })

  it.each([
    ['a non-object config', null],
    ['an unsupported audience', testConfig(50, 'invalid' as 'all')],
    ['a fractional percentage', testConfig(50.5)],
    ['a percentage below zero', testConfig(-1)],
    ['a percentage above 100', testConfig(101)],
    ['a blank branch tag', {
      new_emails: {
        ...testConfig().new_emails,
        branches: { A: { bento_tag: ' ' }, B: { bento_tag: 'ab:no_new_emails' } },
      },
    }],
    ['identical branch tags', {
      new_emails: {
        ...testConfig().new_emails,
        branches: { A: { bento_tag: 'ab:same' }, B: { bento_tag: 'ab:same' } },
      },
    }],
  ])('rejects %s', async (_label, config) => {
    const { validateABTestsConfig } = await loadABTestsModule()

    expect(() => validateABTestsConfig(config)).toThrow('Invalid A/B test configuration')
  })

  it('keeps a persisted branch stable and synchronizes its Bento tag', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: {
          new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' },
        },
      }],
    })
    const context = { get: vi.fn(() => 'request-id') }

    await syncNewUserABTests(context, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })

    const [query, params] = pgQueryMock.mock.calls[0]!
    const normalizedQuery = String(query).replace(/\s+/g, ' ')
    expect(normalizedQuery).toContain('$2::jsonb || CASE')
    expect(normalizedQuery).toContain("THEN onboarding->'abtests'")
    expect(params?.[0]).toBe(USER_ID)
    expect(JSON.parse(String(params?.[1]))).toMatchObject({
      new_emails: { branch: 'A' },
    })
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: ['ab:new_emails'],
      email: 'new.user@example.com',
      segments: ['ab:no_new_emails'],
    })
  })

  it('destroys the database client and closes the pool before Bento delivery', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: {
          new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'A' },
        },
      }],
    })

    await syncNewUserABTests({ get: vi.fn(() => 'request-id') }, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })

    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(pgReleaseMock.mock.invocationCallOrder[0]).toBeLessThan(syncBentoSubscriberTagsMock.mock.invocationCallOrder[0]!)
    expect(closeClientMock.mock.invocationCallOrder[0]).toBeLessThan(syncBentoSubscriberTagsMock.mock.invocationCallOrder[0]!)
  })

  it('fails when the user row is missing', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({ rows: [] })

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') }, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).rejects.toThrow('A/B test assignment failed')
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('fails for queue retry when configured Bento delivery is rejected', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: {
          new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'A' },
        },
      }],
    })
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(false)

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') }, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).rejects.toThrow('Bento A/B test delivery failed')
  })

  it('treats unconfigured Bento delivery as a successful no-op', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: {
          new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'A' },
        },
      }],
    })
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(undefined)

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') }, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).resolves.toBeUndefined()
  })

  it('does not touch persistence or Bento when no experiment matches the audience', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()

    await syncNewUserABTests({ get: vi.fn(() => 'request-id') }, 'invitee@example.com', {
      created_via_invite: true,
      id: USER_ID,
    })

    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })
})
