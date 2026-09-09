import type { ABTestBranch, ABTestConfig } from '../supabase/functions/_backend/utils/ab_tests.ts'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  drizzleExecuteMock,
  drizzleTransactionMock,
  getDrizzleClientMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
  syncBentoSubscriberTagsMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn<(
    query: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows: [] }))
  const pgReleaseMock = vi.fn<(destroy?: Error | boolean) => void>(() => undefined)
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  const drizzleExecuteMock = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }))
  const drizzleTransactionMock = vi.fn(async (callback: (tx: { execute: typeof drizzleExecuteMock }) => Promise<unknown>) => {
    return await callback({ execute: drizzleExecuteMock })
  })
  return {
    closeClientMock: vi.fn(async () => undefined),
    drizzleExecuteMock,
    drizzleTransactionMock,
    getDrizzleClientMock: vi.fn(() => ({ transaction: drizzleTransactionMock })),
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
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
}))

type ABTestsConfig = Record<string, ABTestConfig>
type ABTestsModule = typeof import('../supabase/functions/_backend/utils/ab_tests.ts')

const modulePath = '../supabase/functions/_backend/utils/ab_tests.ts'
const FIXED_DATE = new Date('2026-08-23T12:34:56.000Z')
const USER_ID = '11111111-1111-4111-8111-111111111111'
const INTENT_TEST_NAME = 'intent_targeted'

async function loadABTestsModule() {
  return await import(/* @vite-ignore */ modulePath) as ABTestsModule
}

function testConfig(
  treatmentPercentage = 50,
  audience: ABTestConfig['audience'] = 'self_signup',
  treatmentBranch: ABTestBranch = 'A',
  controlBranch: ABTestBranch = 'B',
  intents?: ABTestConfig['intents'],
): ABTestsConfig {
  return {
    new_emails: {
      audience,
      ...(intents ? { intents } : {}),
      control_branch: controlBranch,
      treatment_branch: treatmentBranch,
      treatment_percentage: treatmentPercentage,
      branches: {
        [treatmentBranch]: { bento_tag: 'ab:new_emails' },
        [controlBranch]: { bento_tag: 'ab:no_new_emails' },
      },
    },
  }
}

function installIntentTest(module: ABTestsModule, intents: ABTestConfig['intents'] = ['ota']) {
  const config = module.validateABTestsConfig({
    [INTENT_TEST_NAME]: {
      ...testConfig().new_emails,
      intents,
      branches: {
        A: { bento_tag: 'ab:intent_targeted' },
        B: { bento_tag: 'ab:no_intent_targeted' },
      },
    },
  })
  module.AB_TESTS_CONFIG[INTENT_TEST_NAME] = config[INTENT_TEST_NAME]
}

function intentAssignment(branch: 'A' | 'B' = 'A') {
  return { assigned_at: FIXED_DATE.toISOString(), branch }
}

function collectSqlParameterValues(chunk: unknown): unknown[] {
  if (Array.isArray(chunk))
    return chunk.flatMap(collectSqlParameterValues)
  if (!chunk || typeof chunk !== 'object')
    return [chunk]

  const sqlChunk = chunk as { queryChunks?: unknown, value?: unknown }
  const values = Array.isArray(sqlChunk.queryChunks)
    ? collectSqlParameterValues(sqlChunk.queryChunks)
    : []
  if (sqlChunk.value !== undefined && !Array.isArray(sqlChunk.value))
    values.push(sqlChunk.value)
  return values
}

function persistedAssignments(branches: { development?: 'C' | 'D', emails?: 'A' | 'B', publish?: 'A' | 'B' } = {}) {
  return {
    new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: branches.emails ?? 'A' },
    webnativeapp_publish_intent: { assigned_at: FIXED_DATE.toISOString(), branch: branches.publish ?? 'A' },
    webnativeapp_development_environment: { assigned_at: FIXED_DATE.toISOString(), branch: branches.development ?? 'C' },
  }
}

describe('new-user A/B test assignment', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    pgConnectMock.mockImplementation(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock }))
    getDrizzleClientMock.mockImplementation(() => ({ transaction: drizzleTransactionMock }))
    drizzleTransactionMock.mockImplementation(async callback => await callback({ execute: drizzleExecuteMock }))
    drizzleExecuteMock.mockResolvedValue({ rows: [] })
    closeClientMock.mockResolvedValue(undefined)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
  })

  afterEach(async () => {
    const module = await loadABTestsModule()
    delete module.AB_TESTS_CONFIG[INTENT_TEST_NAME]
    vi.restoreAllMocks()
  })

  it('declares the JSON import type required by the Supabase Deno runtime', async () => {
    const source = await readFile(new URL('../supabase/functions/_backend/utils/ab_tests.ts', import.meta.url), 'utf8')

    expect(source).toContain('from \'./ab_tests.json\' with { type: \'json\' }')
  })

  it('uses a replica fast path and a locked Drizzle transaction for missing assignments', async () => {
    const source = await readFile(new URL('../supabase/functions/_backend/utils/ab_tests.ts', import.meta.url), 'utf8')

    expect(source).toContain('getPgClient(c, true)')
    expect(source).toContain('getPgClient(c, false)')
    expect(source).toContain('drizzle.transaction(async (tx) =>')
    expect(source).toContain('FOR UPDATE')
  })

  it.each([
    [0, 'A'],
    [0.4999, 'A'],
    [0.5, 'B'],
    [0.9999, 'B'],
  ] as const)('uses the configured 50%% treatment boundary for random value %s', async (randomValue, branch) => {
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
  ] as const)('uses %s%% treatment allocation to always select branch %s', async (percentage, branch) => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(percentage))

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => 0.75,
      () => FIXED_DATE,
    ).new_emails?.branch).toBe(branch)
  })

  it.each([
    [0, 'C'],
    [0.2499, 'C'],
    [0.25, 'D'],
    [0.9999, 'D'],
  ] as const)('supports a 25/75 C/D experiment for random value %s', async (randomValue, branch) => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(25, 'self_signup', 'C', 'D'))

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => randomValue,
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

  it('accepts unique supported intent targeting', async () => {
    const { validateABTestsConfig } = await loadABTestsModule()

    expect(validateABTestsConfig(testConfig(50, 'self_signup', 'A', 'B', ['ota', 'both'])).new_emails?.intents)
      .toEqual(['ota', 'both'])
  })

  it.each([
    ['an empty list', []],
    ['duplicate values', ['ota', 'ota']],
    ['an unsupported value', ['unsupported']],
  ])('rejects intent targeting with %s', async (_label, intents) => {
    const { validateABTestsConfig } = await loadABTestsModule()

    expect(() => validateABTestsConfig(testConfig(50, 'self_signup', 'A', 'B', intents as never)))
      .toThrow('Invalid A/B test configuration')
  })

  it('requires an exact persisted intent before assigning an intent-gated test', async () => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(50, 'self_signup', 'A', 'B', ['ota']))

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})
    expect(createABTestAssignments(
      { created_via_invite: false, intent: 'both' },
      config,
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})
    expect(createABTestAssignments(
      { created_via_invite: false, intent: 'ota' },
      config,
      () => 0,
      () => FIXED_DATE,
    ).new_emails).toEqual({
      assigned_at: FIXED_DATE.toISOString(),
      branch: 'A',
    })
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
    ['identical treatment and control branches', {
      new_emails: {
        ...testConfig().new_emails,
        control_branch: 'A',
      },
    }],
    ['an unconfigured treatment branch', {
      new_emails: {
        ...testConfig().new_emails,
        treatment_branch: 'C',
      },
    }],
  ])('rejects %s', async (_label, config) => {
    const { validateABTestsConfig } = await loadABTestsModule()

    expect(() => validateABTestsConfig(config)).toThrow('Invalid A/B test configuration')
  })

  it('rejects a tag used by branch A in one experiment and branch B in another', async () => {
    const { validateABTestsConfig } = await loadABTestsModule()
    const firstTest = testConfig().new_emails

    expect(() => validateABTestsConfig({
      first_test: {
        ...firstTest,
        branches: {
          A: { bento_tag: 'ab:shared' },
          B: { bento_tag: 'ab:first_control' },
        },
      },
      second_test: {
        ...firstTest,
        branches: {
          A: { bento_tag: 'ab:second_treatment' },
          B: { bento_tag: 'ab:shared' },
        },
      },
    })).toThrow('Invalid A/B test configuration')
  })

  it.each(['A', 'B'] as const)('rejects a tag reused by branch %s across experiments', async (branch) => {
    const { validateABTestsConfig } = await loadABTestsModule()
    const firstTest = testConfig().new_emails
    const secondBranches = {
      A: { bento_tag: 'ab:second_treatment' },
      B: { bento_tag: 'ab:second_control' },
    }
    secondBranches[branch].bento_tag = firstTest.branches[branch].bento_tag

    expect(() => validateABTestsConfig({
      first_test: firstTest,
      second_test: {
        ...firstTest,
        branches: secondBranches,
      },
    })).toThrow('Invalid A/B test configuration')
  })

  it('keeps a persisted branch stable and synchronizes its Bento tag', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: persistedAssignments({ development: 'D', emails: 'B', publish: 'B' }),
      }],
    })
    const context = { get: vi.fn(() => 'request-id') } as never

    await syncNewUserABTests(context, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })

    const [query, params] = pgQueryMock.mock.calls[0]!
    const normalizedQuery = String(query).replace(/\s+/g, ' ')
    expect(normalizedQuery).toContain('$2::jsonb || CASE')
    expect(normalizedQuery).toContain('THEN onboarding->\'abtests\'')
    expect(params?.[0]).toBe(USER_ID)
    expect(JSON.parse(String(params?.[1]))).toMatchObject({
      new_emails: { branch: 'A' },
      webnativeapp_development_environment: { branch: 'C' },
      webnativeapp_publish_intent: { branch: 'A' },
    })
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: ['ab:new_emails', 'ab:webnativeapp_publish_intent', 'ab:webnativeapp_development_environment'],
      email: 'new.user@example.com',
      segments: ['ab:no_new_emails', 'ab:no_webnativeapp_publish_intent', 'ab:no_webnativeapp_development_environment'],
    })
  })

  it('destroys the database client and closes the pool before Bento delivery', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: persistedAssignments(),
      }],
    })

    await syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'new.user@example.com', {
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

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).rejects.toThrow('A/B test assignment failed')
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('fails for queue retry when configured Bento delivery is rejected', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: persistedAssignments(),
      }],
    })
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(false)

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).rejects.toThrow('Bento A/B test delivery failed')
  })

  it('treats unconfigured Bento delivery as a successful no-op', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        abtests: persistedAssignments(),
      }],
    })
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(undefined)

    await expect(syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })).resolves.toBeUndefined()
  })

  it('returns complete assignments from the replica without touching the primary database', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const persisted = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    pgQueryMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false }] })

    await expect(getOrCreateUserABTests(
      context,
      USER_ID,
    )).resolves.toEqual(persisted)

    expect(pgQueryMock).toHaveBeenCalledOnce()
    const [selectQuery, selectParams] = pgQueryMock.mock.calls[0]!
    expect(String(selectQuery).replace(/\s+/g, ' ')).toContain("onboarding->>'intent' AS intent")
    expect(selectParams).toEqual([USER_ID])
    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(getDrizzleClientMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('returns a complete intent-gated assignment from the replica for an exact intent match', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const persisted = {
      ...persistedAssignments({ development: 'D', emails: 'B', publish: 'B' }),
      [INTENT_TEST_NAME]: intentAssignment('B'),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    pgQueryMock.mockResolvedValueOnce({
      rows: [{ abtests: persisted, created_via_invite: false, intent: 'ota' }],
    })

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(getPgClientMock).toHaveBeenCalledWith(context, true)
    expect(getDrizzleClientMock).not.toHaveBeenCalled()
  })

  it('does not assign an intent-gated test before intent is persisted', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const persisted = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    pgQueryMock.mockResolvedValueOnce({
      rows: [{ abtests: persisted, created_via_invite: false, intent: null }],
    })

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(getDrizzleClientMock).not.toHaveBeenCalled()
  })

  it('creates an intent-gated assignment after an exact intent match is persisted', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const existing = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const persisted = {
      ...existing,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    pgQueryMock.mockResolvedValueOnce({
      rows: [{ abtests: existing, created_via_invite: false, intent: 'ota' }],
    })
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
    expect(random).toHaveBeenCalledOnce()
  })

  it.each([
    ['a changed intent', 'builder'],
    ['a cleared intent', null],
  ])('revokes a stale intent-gated assignment after %s', async (_label, intent) => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const retiredAssignment = { assigned_at: FIXED_DATE.toISOString(), branch: 'A' }
    const existing = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: intentAssignment(),
      retired_experiment: retiredAssignment,
    }
    const persisted = {
      ...standardAssignments,
      retired_experiment: retiredAssignment,
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    pgQueryMock.mockResolvedValueOnce({
      rows: [{ abtests: existing, created_via_invite: false, intent }],
    })
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(standardAssignments)

    expect(getPgClientMock.mock.calls).toEqual([[context, true], [context, false]])
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    const assignmentsJson = updateParameters.find(value => typeof value === 'string' && value.startsWith('{'))
    expect(JSON.parse(String(assignmentsJson))).toEqual(persisted)
  })

  it('falls back to the primary database when the replica lookup fails', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const persisted = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    pgConnectMock.mockRejectedValueOnce(new Error('replica unavailable'))
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false, email: 'user@example.com' }] })

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, true], [context, false]])
    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('locks the primary user row and assigns only missing tests inside one transaction', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const existing = {
      new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' },
    }
    const persisted = persistedAssignments({ development: 'C', emails: 'B', publish: 'A' })
    const context = { get: vi.fn(() => 'request-id') } as never
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    pgQueryMock.mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false }] })
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, true], [context, false]])
    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
    expect(random).toHaveBeenCalledTimes(2)
    expect(closeClientMock).toHaveBeenCalledTimes(2)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: expect.arrayContaining([
        'ab:no_webnativeapp_development_environment',
        'ab:no_webnativeapp_publish_intent',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:webnativeapp_development_environment',
        'ab:webnativeapp_publish_intent',
      ]),
    })
  })

  it('rechecks the locked primary row and never regenerates completed assignments', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const partial = {
      new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' },
    }
    const persisted = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    const random = vi.spyOn(Math, 'random')
    pgQueryMock.mockResolvedValueOnce({ rows: [{ abtests: partial, created_via_invite: false }] })
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false }] })

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(random).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledTimes(2)
  })

  it('rejects on-demand assignment when the authenticated profile is missing', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const context = { get: vi.fn(() => 'request-id') } as never
    pgQueryMock.mockResolvedValueOnce({ rows: [] })
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [] })

    await expect(getOrCreateUserABTests(
      context,
      USER_ID,
    )).rejects.toThrow('User not found')
    expect(pgQueryMock).toHaveBeenCalledOnce()
    expect(getPgClientMock.mock.calls).toEqual([[context, true], [context, false]])
    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(closeClientMock).toHaveBeenCalledTimes(2)
  })

  it('does not touch persistence or Bento when no experiment matches the audience', async () => {
    const { syncNewUserABTests } = await loadABTestsModule()

    await syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'invitee@example.com', {
      created_via_invite: true,
      id: USER_ID,
    })

    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })
})
