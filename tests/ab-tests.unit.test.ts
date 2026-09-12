import type { ABTestBranch, ABTestConfig } from '../supabase/functions/_backend/utils/ab_tests.ts'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  backgroundTaskMock,
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
  const drizzleExecuteMock = vi.fn<(query: unknown) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows: [] }))
  const drizzleTransactionMock = vi.fn(async (callback: (tx: { execute: typeof drizzleExecuteMock }) => Promise<unknown>) => {
    return await callback({ execute: drizzleExecuteMock })
  })
  return {
    backgroundTaskMock: vi.fn(async (_c: unknown, task: Promise<unknown>) => await task),
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
      signal?: AbortSignal,
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

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

type ABTestsConfig = Record<string, ABTestConfig>
type ABTestsModule = typeof import('../supabase/functions/_backend/utils/ab_tests.ts')

const modulePath = '../supabase/functions/_backend/utils/ab_tests.ts'
const FIXED_DATE = new Date('2026-08-23T12:34:56.000Z')
const USER_ID = '11111111-1111-4111-8111-111111111111'
const INTENT_TEST_NAME = 'intent_targeted'
const BUILDER_INTENT_TEST_NAME = 'builder_intent_targeted'
const NEW_CHANNEL_TEST_NAME = 'new_channel'

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
      label: 'Email template',
      ...(intents ? { intents } : {}),
      control_branch: controlBranch,
      treatment_branch: treatmentBranch,
      treatment_percentage: treatmentPercentage,
      branches: {
        [treatmentBranch]: { bento_tag: 'ab:new_emails', label: 'New emails' },
        [controlBranch]: { bento_tag: 'ab:no_new_emails', label: 'Old emails' },
      },
    },
  }
}

function installIntentTest(
  module: ABTestsModule,
  intents: ABTestConfig['intents'] = ['ota'],
  testName = INTENT_TEST_NAME,
) {
  const config = module.validateABTestsConfig({
    [testName]: {
      ...testConfig().new_emails,
      intents,
      branches: {
        A: { bento_tag: `ab:${testName}`, label: 'Treatment' },
        B: { bento_tag: `ab:no_${testName}`, label: 'Control' },
      },
    },
  })
  module.AB_TESTS_CONFIG[testName] = config[testName]
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

function persistedAssignments(branches: { channel?: 'A' | 'B' | null, development?: 'C' | 'D', emails?: 'A' | 'B', publish?: 'A' | 'B' } = {}) {
  const assignments = {
    new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: branches.emails ?? 'A' },
    webnativeapp_publish_intent: { assigned_at: FIXED_DATE.toISOString(), branch: branches.publish ?? 'A' },
    webnativeapp_development_environment: { assigned_at: FIXED_DATE.toISOString(), branch: branches.development ?? 'C' },
  }
  if (branches.channel === null)
    return assignments
  return {
    ...assignments,
    new_channel: { assigned_at: FIXED_DATE.toISOString(), branch: branches.channel ?? 'A' },
  }
}

function queueBentoSnapshot(user: Record<string, unknown>, writesState = false) {
  drizzleExecuteMock
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [user] })
  if (writesState)
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [] })
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
    backgroundTaskMock.mockImplementation(async (_c, task) => await task)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
  })

  afterEach(async () => {
    const module = await loadABTestsModule()
    delete module.AB_TESTS_CONFIG[INTENT_TEST_NAME]
    delete module.AB_TESTS_CONFIG[BUILDER_INTENT_TEST_NAME]
    vi.useRealTimers()
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
    expect(source).toContain("SET LOCAL lock_timeout = '2s'")
    expect(source).toContain('AbortSignal.timeout(BENTO_AB_TEST_SYNC_TIMEOUT_MS)')
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

  it('preserves display labels for the admin dashboard', async () => {
    const { validateABTestsConfig } = await loadABTestsModule()

    const config = validateABTestsConfig(testConfig())

    expect(config.new_emails?.label).toBe('Email template')
    expect(config.new_emails?.branches.A.label).toBe('New emails')
    expect(config.new_emails?.branches.B.label).toBe('Old emails')
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

  it('assigns the configured channel experiment only after an exact eligible persisted intent', async () => {
    const { AB_TESTS_CONFIG, createABTestAssignments } = await loadABTestsModule()
    const config = { [NEW_CHANNEL_TEST_NAME]: AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME]! }

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})
    expect(createABTestAssignments(
      { created_via_invite: false, intent: 'builder' },
      config,
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})
    expect(createABTestAssignments(
      { created_via_invite: false, intent: 'ota' },
      config,
      () => 0,
      () => FIXED_DATE,
    )).toEqual({
      [NEW_CHANNEL_TEST_NAME]: intentAssignment('A'),
    })
    expect(createABTestAssignments(
      { created_via_invite: false, intent: 'both' },
      config,
      () => 0.5,
      () => FIXED_DATE,
    )).toEqual({
      [NEW_CHANNEL_TEST_NAME]: intentAssignment('B'),
    })
  })

  it.each([
    ['a non-object config', null],
    ['an unsupported audience', testConfig(50, 'invalid' as 'all')],
    ['a blank test label', {
      new_emails: {
        ...testConfig().new_emails,
        label: ' ',
      },
    }],
    ['a blank branch label', {
      new_emails: {
        ...testConfig().new_emails,
        branches: {
          ...testConfig().new_emails.branches,
          A: { bento_tag: 'ab:new_emails', label: ' ' },
        },
      },
    }],
    ['a fractional percentage', testConfig(50.5)],
    ['a percentage below zero', testConfig(-1)],
    ['a percentage above 100', testConfig(101)],
    ['a blank branch tag', {
      new_emails: {
        ...testConfig().new_emails,
        branches: {
          A: { bento_tag: ' ', label: 'New emails' },
          B: { bento_tag: 'ab:no_new_emails', label: 'Old emails' },
        },
      },
    }],
    ['identical branch tags', {
      new_emails: {
        ...testConfig().new_emails,
        branches: {
          A: { bento_tag: 'ab:same', label: 'New emails' },
          B: { bento_tag: 'ab:same', label: 'Old emails' },
        },
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
          A: { bento_tag: 'ab:shared', label: 'First treatment' },
          B: { bento_tag: 'ab:first_control', label: 'First control' },
        },
      },
      second_test: {
        ...firstTest,
        branches: {
          A: { bento_tag: 'ab:second_treatment', label: 'Second treatment' },
          B: { bento_tag: 'ab:shared', label: 'Second control' },
        },
      },
    })).toThrow('Invalid A/B test configuration')
  })

  it.each(['A', 'B'] as const)('rejects a tag reused by branch %s across experiments', async (branch) => {
    const { validateABTestsConfig } = await loadABTestsModule()
    const firstTest = testConfig().new_emails
    const secondBranches = {
      A: { bento_tag: 'ab:second_treatment', label: 'Second treatment' },
      B: { bento_tag: 'ab:second_control', label: 'Second control' },
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

  it('skips intent-gated tests when the creation trigger runs before intent selection', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    pgQueryMock.mockResolvedValueOnce({
      rows: [{ abtests: persistedAssignments() }],
    })

    await module.syncNewUserABTests({ get: vi.fn(() => 'request-id') } as never, 'new.user@example.com', {
      created_via_invite: false,
      id: USER_ID,
    })

    const [, params] = pgQueryMock.mock.calls[0]!
    expect(JSON.parse(String(params?.[1]))).not.toHaveProperty(INTENT_TEST_NAME)
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

  it('reads complete assignments from the primary when configured tests are intent-gated', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const persisted = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false, intent: 'ota' }] })

    await expect(getOrCreateUserABTests(
      context,
      USER_ID,
    )).resolves.toEqual(persisted)

    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(getPgClientMock).toHaveBeenCalledWith(context, false)
    expect(getDrizzleClientMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('bypasses the replica when intent-gated tests require authoritative intent', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const persisted = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const replicaAssignments = {
      ...persisted,
      [INTENT_TEST_NAME]: intentAssignment('B'),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: replicaAssignments, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(7)
  })

  it('does not assign an intent-gated test before intent is persisted', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const persisted = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({
      rows: [{ abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: null }],
    })

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('clears a pending Bento sync when the user has no deliverable email', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const persisted = {
      ...persistedAssignments({ development: 'D', emails: 'B', publish: 'B' }),
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const pendingSync = { cleanup_emails: [], pending: true }
    const user = {
      abtests: persisted,
      abtests_bento_sync: pendingSync,
      created_via_invite: false,
      email: null,
      intent: 'ota',
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [user] })
    queueBentoSnapshot(user, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(4)
    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[3]?.[0])
    const stateJson = updateParameters.find(value => typeof value === 'string' && value.includes('"pending"'))
    expect(JSON.parse(String(stateJson))).toEqual({ cleanup_emails: [], pending: false })
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
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(7)
    expect(random).toHaveBeenCalledOnce()
  })

  it('returns assignments before background Bento reconciliation finishes', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const existing = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const persisted = {
      ...existing,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const user = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }
    const context = { get: vi.fn(() => 'request-id') } as never
    let resolveBento: ((value: boolean) => void) | undefined
    const bentoPending = new Promise<boolean>((resolve) => {
      resolveBento = resolve
    })
    let scheduledTask: Promise<unknown> | undefined
    backgroundTaskMock.mockImplementationOnce(async (_c, task) => {
      scheduledTask = task
    })
    syncBentoSubscriberTagsMock.mockImplementationOnce(async () => await bentoPending)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    queueBentoSnapshot(user)
    queueBentoSnapshot(user, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)
    await vi.waitFor(() => expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce())

    expect(backgroundTaskMock).toHaveBeenCalledOnce()
    expect(closeClientMock).not.toHaveBeenCalled()
    expect(scheduledTask).toBeDefined()

    resolveBento?.(true)
    await scheduledTask

    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('keeps Bento reconciliation pending when delivery is not configured', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const existing = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const persisted = {
      ...existing,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const pendingSync = {
      cleanup_emails: [],
      email: 'user@example.com',
      pending: true,
    }
    const user = {
      abtests: persisted,
      abtests_bento_sync: pendingSync,
      created_via_invite: false,
      email: 'User@Example.com',
      intent: 'ota',
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    queueBentoSnapshot(user)
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [user] })
    queueBentoSnapshot(user)
    syncBentoSubscriberTagsMock.mockResolvedValue(undefined)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)
    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(2)
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(7)
    expect(drizzleTransactionMock).toHaveBeenCalledTimes(4)
  })

  it('reconciles Bento after the bounded snapshot transaction commits', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const existing = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const persisted = {
      ...existing,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    const events: string[] = []
    let transactionNumber = 0
    drizzleTransactionMock.mockImplementation(async (callback) => {
      transactionNumber += 1
      const transactionName = ['assignment', 'snapshot', 'verification'][transactionNumber - 1]
      events.push(`${transactionName}-started`)
      const result = await callback({ execute: drizzleExecuteMock })
      events.push(`${transactionName}-committed`)
      return result
    })
    syncBentoSubscriberTagsMock.mockImplementationOnce(async () => {
      events.push('bento-synced')
      return true
    })
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await module.getOrCreateUserABTests(context, USER_ID)

    expect(events).toEqual([
      'assignment-started',
      'assignment-committed',
      'snapshot-started',
      'snapshot-committed',
      'bento-synced',
      'verification-started',
      'verification-committed',
    ])
  })

  it('retries Bento when a newer reconciliation commits during synchronization', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    installIntentTest(module, ['builder'], BUILDER_INTENT_TEST_NAME)
    const standardAssignments = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const firstCommit = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const latestCommit = {
      ...standardAssignments,
      [BUILDER_INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: standardAssignments, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: firstCommit }] })
    const firstUser = { abtests: firstCommit, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }
    const latestUser = { abtests: latestCommit, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }
    queueBentoSnapshot(firstUser)
    queueBentoSnapshot(latestUser, true)
    queueBentoSnapshot(latestUser)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(firstCommit)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(2)
    const [, firstUpdate] = syncBentoSubscriberTagsMock.mock.calls[0]!
    const [, latestUpdate, signal] = syncBentoSubscriberTagsMock.mock.calls[1]!
    expect(firstUpdate.segments).toContain('ab:intent_targeted')
    expect(latestUpdate.segments).toContain('ab:builder_intent_targeted')
    expect(latestUpdate.segments).not.toContain('ab:intent_targeted')
    expect(latestUpdate.deleteSegments).toEqual(expect.arrayContaining([
      'ab:intent_targeted',
      'ab:no_intent_targeted',
      'ab:no_builder_intent_targeted',
    ]))
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('caps Bento reconciliation attempts when the desired state keeps changing', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const assigned = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: standardAssignments, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: assigned }] })

    for (const branch of ['A', 'B', 'A', 'B'] as const) {
      queueBentoSnapshot({
        abtests: {
          ...standardAssignments,
          [INTENT_TEST_NAME]: intentAssignment(branch),
        },
        created_via_invite: false,
        email: 'User@Example.com',
        intent: 'ota',
      })
    }

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(assigned)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(3)
    expect(drizzleTransactionMock).toHaveBeenCalledTimes(5)
  })

  it('clears experiment tags from the previous email before syncing a changed email', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const assigned = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: standardAssignments, created_via_invite: false, email: 'Old@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: assigned }] })

    const oldEmailUser = { abtests: assigned, created_via_invite: false, email: 'Old@Example.com', intent: 'ota' }
    const newEmailUser = { abtests: assigned, created_via_invite: false, email: 'New@Example.com', intent: 'ota' }
    queueBentoSnapshot(oldEmailUser)
    queueBentoSnapshot(newEmailUser, true)
    queueBentoSnapshot(newEmailUser)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(assigned)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(3)
    const [, oldEmailUpdate] = syncBentoSubscriberTagsMock.mock.calls[0]!
    const [, oldEmailCleanup] = syncBentoSubscriberTagsMock.mock.calls[1]!
    const [, newEmailUpdate] = syncBentoSubscriberTagsMock.mock.calls[2]!
    expect(oldEmailUpdate).toEqual(expect.objectContaining({
      email: 'old@example.com',
      segments: expect.arrayContaining(['ab:intent_targeted']),
    }))
    expect(oldEmailCleanup).toEqual({
      deleteSegments: expect.arrayContaining([
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'old@example.com',
      segments: [],
    })
    expect(newEmailUpdate).toEqual(expect.objectContaining({
      email: 'new@example.com',
      segments: expect.arrayContaining(['ab:intent_targeted']),
    }))
  })

  it('retries a durably pending email cleanup when assignments are already complete', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ development: 'D', emails: 'B', publish: 'B' })
    const assigned = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    const oldEmailUser = { abtests: assigned, created_via_invite: false, email: 'Old@Example.com', intent: 'ota' }
    const pendingSync = {
      cleanup_emails: ['old@example.com'],
      email: 'new@example.com',
      pending: true,
    }
    const newEmailUser = {
      abtests: assigned,
      abtests_bento_sync: pendingSync,
      created_via_invite: false,
      email: 'New@Example.com',
      intent: 'ota',
    }
    const changedEmailUser = {
      abtests: assigned,
      created_via_invite: false,
      email: 'New@Example.com',
      intent: 'ota',
    }
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: standardAssignments, created_via_invite: false, email: 'Old@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: assigned }] })
    queueBentoSnapshot(oldEmailUser)
    queueBentoSnapshot(changedEmailUser)
    syncBentoSubscriberTagsMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(assigned)

    drizzleExecuteMock.mockResolvedValueOnce({ rows: [newEmailUser] })
    queueBentoSnapshot(newEmailUser)
    queueBentoSnapshot(newEmailUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(assigned)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(4)
    expect(syncBentoSubscriberTagsMock.mock.calls[2]?.[1]).toEqual({
      deleteSegments: expect.arrayContaining([
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'old@example.com',
      segments: [],
    })
    expect(syncBentoSubscriberTagsMock.mock.calls[3]?.[1]).toEqual(expect.objectContaining({
      email: 'new@example.com',
      segments: expect.arrayContaining(['ab:intent_targeted']),
    }))
  })

  it('treats a malformed current branch as unassigned during Bento reconciliation', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const existing = {
      ...standardAssignments,
      [NEW_CHANNEL_TEST_NAME]: intentAssignment(),
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const malformedCurrent = {
      ...standardAssignments,
      [INTENT_TEST_NAME]: { assigned_at: FIXED_DATE.toISOString(), branch: 'legacy' },
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: standardAssignments }] })
    const currentUser = { abtests: malformedCurrent, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(standardAssignments)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      deleteSegments: expect.arrayContaining(['ab:intent_targeted', 'ab:no_intent_targeted']),
      email: 'user@example.com',
    }), expect.any(AbortSignal))
  })

  it.each([
    ['a changed intent', 'builder'],
    ['a cleared intent', null],
  ])('revokes a stale intent-gated assignment after %s', async (_label, intent) => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const retiredAssignment = { assigned_at: FIXED_DATE.toISOString(), branch: 'A' }
    const existing = {
      ...standardAssignments,
      [NEW_CHANNEL_TEST_NAME]: intentAssignment(),
      [INTENT_TEST_NAME]: intentAssignment(),
      retired_experiment: retiredAssignment,
    }
    const persisted = {
      ...standardAssignments,
      retired_experiment: retiredAssignment,
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(standardAssignments)

    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(7)
    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    const assignmentsJson = updateParameters.find(value => typeof value === 'string' && value.startsWith('{'))
    expect(JSON.parse(String(assignmentsJson))).toEqual(persisted)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: expect.arrayContaining([
        'ab:new_channel',
        'ab:no_new_channel',
        'ab:new_emails',
        'ab:webnativeapp_publish_intent',
        'ab:webnativeapp_development_environment',
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:no_new_emails',
        'ab:no_webnativeapp_publish_intent',
        'ab:no_webnativeapp_development_environment',
      ]),
    }, expect.any(AbortSignal))
  })

  it('revokes the old intent assignment and creates the new intent assignment atomically', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    installIntentTest(module, ['builder'], BUILDER_INTENT_TEST_NAME)
    const standardAssignments = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const existing = {
      ...standardAssignments,
      [NEW_CHANNEL_TEST_NAME]: intentAssignment(),
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const persisted = {
      ...standardAssignments,
      [BUILDER_INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'builder' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(random).toHaveBeenCalledOnce()
    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    const assignmentsJson = updateParameters.find(value => typeof value === 'string' && value.startsWith('{'))
    expect(JSON.parse(String(assignmentsJson))).toEqual(persisted)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: expect.arrayContaining([
        'ab:new_channel',
        'ab:no_new_channel',
        'ab:new_emails',
        'ab:webnativeapp_publish_intent',
        'ab:webnativeapp_development_environment',
        'ab:no_builder_intent_targeted',
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:no_new_emails',
        'ab:no_webnativeapp_publish_intent',
        'ab:no_webnativeapp_development_environment',
        'ab:builder_intent_targeted',
      ]),
    }, expect.any(AbortSignal))
  })

  it('uses the primary database directly when an intent-gated test is configured', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const persisted = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false, email: 'user@example.com' }] })

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('locks the primary user row and assigns only missing tests inside one transaction', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const existing = {
      new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' },
    }
    const persisted = persistedAssignments({ channel: null, development: 'C', emails: 'B', publish: 'A' })
    const context = { get: vi.fn(() => 'request-id') } as never
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    pgQueryMock.mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false }] })
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(drizzleTransactionMock).toHaveBeenCalledTimes(3)
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(7)
    expect(random).toHaveBeenCalledTimes(2)
    expect(closeClientMock).toHaveBeenCalledOnce()
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
    }, expect.any(AbortSignal))
  })

  it('rechecks the locked primary row and never regenerates completed assignments', async () => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const partial = {
      new_emails: { assigned_at: FIXED_DATE.toISOString(), branch: 'B' },
    }
    const persisted = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const context = { get: vi.fn(() => 'request-id') } as never
    const random = vi.spyOn(Math, 'random')
    pgQueryMock.mockResolvedValueOnce({ rows: [{ abtests: partial, created_via_invite: false }] })
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests: persisted, created_via_invite: false }] })

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(random).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledOnce()
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
    expect(pgQueryMock).not.toHaveBeenCalled()
    expect(getPgClientMock.mock.calls).toEqual([[context, false]])
    expect(drizzleTransactionMock).toHaveBeenCalledOnce()
    expect(closeClientMock).toHaveBeenCalledOnce()
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
