import type { ABTestBranch, ABTestConfig } from '../supabase/functions/_backend/utils/ab_tests.ts'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import rawConfig from '../supabase/functions/_backend/utils/ab_tests.json'

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

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => ({
  ...(await import('./helpers/pg-checkout-release-mocks.ts')),
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
const BUILDER_TODO_TEST_NAME = 'builder_todo_list_v4'
const NEW_CHANNEL_TEST_NAME = 'new_channel'
const PAUSED_FIXTURE_TEST_NAMES = ['fixture_publish_intent', 'fixture_development_environment'] as const

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

function enableNewChannelTest(module: ABTestsModule) {
  module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME] = {
    ...module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME]!,
    treatment_percentage: 50,
  }
}

// Two paused self-signup tests (one using C/D branches) stand in for real
// experiments so assignment and Bento tag sync stay covered whatever ships.
function installPausedFixtureTests(module: ABTestsModule) {
  const config = module.validateABTestsConfig({
    fixture_publish_intent: {
      audience: 'self_signup',
      label: 'Publish intent fixture',
      treatment_percentage: 0,
      treatment_branch: 'A',
      control_branch: 'B',
      branches: {
        A: { bento_tag: 'ab:fixture_publish_intent', label: 'Treatment' },
        B: { bento_tag: 'ab:no_fixture_publish_intent', label: 'Control' },
      },
    },
    fixture_development_environment: {
      audience: 'self_signup',
      label: 'Development environment fixture',
      treatment_percentage: 0,
      treatment_branch: 'C',
      control_branch: 'D',
      branches: {
        C: { bento_tag: 'ab:fixture_development_environment', label: 'Treatment' },
        D: { bento_tag: 'ab:no_fixture_development_environment', label: 'Control' },
      },
    },
  })
  for (const testName of PAUSED_FIXTURE_TEST_NAMES)
    module.AB_TESTS_CONFIG[testName] = config[testName]
}

function enablePausedFixtureTests(module: ABTestsModule) {
  for (const testName of PAUSED_FIXTURE_TEST_NAMES)
    module.AB_TESTS_CONFIG[testName].treatment_percentage = 10
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
    fixture_publish_intent: { assigned_at: FIXED_DATE.toISOString(), branch: branches.publish ?? 'A' },
    fixture_development_environment: { assigned_at: FIXED_DATE.toISOString(), branch: branches.development ?? 'C' },
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
  beforeEach(async () => {
    const module = await loadABTestsModule()
    module.AB_TESTS_CONFIG.new_emails = testConfig().new_emails
    delete module.AB_TESTS_CONFIG.new_emails_v2
    installPausedFixtureTests(module)
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
    const productionConfig = module.validateABTestsConfig(rawConfig)
    module.AB_TESTS_CONFIG.new_emails = productionConfig.new_emails
    module.AB_TESTS_CONFIG.new_emails_v2 = productionConfig.new_emails_v2
    delete module.AB_TESTS_CONFIG[INTENT_TEST_NAME]
    delete module.AB_TESTS_CONFIG[BUILDER_INTENT_TEST_NAME]
    module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME] = {
      ...module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME]!,
      treatment_percentage: 0,
    }
    for (const testName of PAUSED_FIXTURE_TEST_NAMES)
      delete module.AB_TESTS_CONFIG[testName]
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('declares the JSON import type required by the Supabase Deno runtime', async () => {
    const source = await readFile(new URL('../supabase/functions/_backend/utils/ab_tests.ts', import.meta.url), 'utf8')

    expect(source).toContain('from \'./ab_tests.json\' with { type: \'json\' }')
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

  it('leaves both branches unassigned at 0% treatment', async () => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(0))
    const random = vi.fn(() => 0)

    expect(createABTestAssignments({ created_via_invite: false }, config, random, () => FIXED_DATE)).toEqual({})
    expect(random).not.toHaveBeenCalled()
  })

  it('leaves a disabled all-user test unassigned at creation', async () => {
    const module = await loadABTestsModule()
    const configured = module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME]
    expect(configured).toMatchObject({ audience: 'all', intents: ['builder'], treatment_percentage: 100 })
    const disabled = { ...configured, intents: undefined, treatment_percentage: 0 }
    expect(module.createABTestAssignments(
      { created_via_invite: false, intent: 'builder' },
      { [BUILDER_TODO_TEST_NAME]: disabled },
      () => 0,
      () => FIXED_DATE,
    )).toEqual({})

    module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME] = disabled
    try {
      const result = module.createABTestAssignments({ created_via_invite: true }, module.AB_TESTS_CONFIG)
      expect(result).toEqual({})
    }
    finally {
      module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME] = configured
    }
  })

  it('uses 100% treatment allocation to always select branch A', async () => {
    const { createABTestAssignments, validateABTestsConfig } = await loadABTestsModule()
    const config = validateABTestsConfig(testConfig(100))

    expect(createABTestAssignments(
      { created_via_invite: false },
      config,
      () => 0.75,
      () => FIXED_DATE,
    ).new_emails?.branch).toBe('A')
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
    const config = {
      [NEW_CHANNEL_TEST_NAME]: {
        ...AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME]!,
        treatment_percentage: 50,
      },
    }

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
    const persisted = {
      ...persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' }),
      [BUILDER_TODO_TEST_NAME]: intentAssignment('B'),
    }
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

  it('leaves an eligible 0% test unassigned during on-demand lookup', async () => {
    const module = await loadABTestsModule()
    const configured = module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME]
    module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME] = { ...configured, treatment_percentage: 0 }
    const persisted = persistedAssignments({ channel: null })
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({
      rows: [{ abtests: persisted, created_via_invite: false, email: 'user@example.com', intent: 'builder' }],
    })

    try {
      await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)
      expect(drizzleExecuteMock).toHaveBeenCalledOnce()
      expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    }
    finally {
      module.AB_TESTS_CONFIG[BUILDER_TODO_TEST_NAME] = configured
    }
  })

  it('preserves an existing assignment after a test is set to 0%', async () => {
    const module = await loadABTestsModule()
    const configured = module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME]
    module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME] = { ...configured, treatment_percentage: 0 }
    const persisted = persistedAssignments({ channel: 'A' })
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({
      rows: [{ abtests: persisted, created_via_invite: false, email: 'user@example.com', intent: 'ota' }],
    })

    try {
      await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)
      expect(drizzleExecuteMock).toHaveBeenCalledOnce()
      expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    }
    finally {
      module.AB_TESTS_CONFIG[NEW_CHANNEL_TEST_NAME] = configured
    }
  })

  it('preserves a manual branch A assignment while filling other missing tests', async () => {
    const module = await loadABTestsModule()
    enablePausedFixtureTests(module)
    const { getOrCreateUserABTests } = module
    const manualAssignment = intentAssignment('A')
    const existing = {
      new_emails: intentAssignment('B'),
      [BUILDER_TODO_TEST_NAME]: manualAssignment,
    }
    const persisted = {
      ...persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' }),
      [BUILDER_TODO_TEST_NAME]: manualAssignment,
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'user@example.com', intent: 'builder' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'user@example.com', intent: 'builder' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(persisted)

    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    const assignmentsJson = updateParameters.find(value => typeof value === 'string' && value.startsWith('{'))
    expect(JSON.parse(String(assignmentsJson))[BUILDER_TODO_TEST_NAME]).toEqual(manualAssignment)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      segments: expect.arrayContaining(['ab:builder_todo_list_v4']),
    }), expect.any(AbortSignal))
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

  it('deletes the Bento tags of retired experiments the user was assigned to', async () => {
    const module = await loadABTestsModule()
    installIntentTest(module)
    const existing = {
      ...persistedAssignments({ development: 'D', emails: 'B', publish: 'B' }),
      webnativeapp_publish_intent: { assigned_at: FIXED_DATE.toISOString(), branch: 'A' },
    }
    const persisted = {
      ...existing,
      [INTENT_TEST_NAME]: intentAssignment(),
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent: 'ota' }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await module.getOrCreateUserABTests(context, USER_ID)

    const [, update] = syncBentoSubscriberTagsMock.mock.calls[0]!
    expect(update.deleteSegments).toEqual(expect.arrayContaining([
      'ab:webnativeapp_publish_intent',
      'ab:no_webnativeapp_publish_intent',
    ]))
    expect(update.deleteSegments).not.toContain('ab:webnativeapp_development_environment')
    expect(update.segments).not.toContain('ab:webnativeapp_publish_intent')
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
    const standardAssignments = {
      ...persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' }),
      [BUILDER_TODO_TEST_NAME]: intentAssignment(),
    }
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
    enableNewChannelTest(module)
    installIntentTest(module)
    const standardAssignments = persistedAssignments({ channel: null, development: 'D', emails: 'B', publish: 'B' })
    const expectedAssignments = intent === 'builder'
      ? { ...standardAssignments, [BUILDER_TODO_TEST_NAME]: intentAssignment() }
      : standardAssignments
    const retiredAssignment = { assigned_at: FIXED_DATE.toISOString(), branch: 'A' }
    const existing = {
      ...standardAssignments,
      [NEW_CHANNEL_TEST_NAME]: intentAssignment(),
      [INTENT_TEST_NAME]: intentAssignment(),
      retired_experiment: retiredAssignment,
    }
    const persisted = {
      ...expectedAssignments,
      retired_experiment: retiredAssignment,
    }
    const context = { get: vi.fn(() => 'request-id') } as never
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ abtests: existing, created_via_invite: false, email: 'User@Example.com', intent }] })
      .mockResolvedValueOnce({ rows: [{ abtests: persisted }] })
    const currentUser = { abtests: persisted, created_via_invite: false, email: 'User@Example.com', intent }
    queueBentoSnapshot(currentUser)
    queueBentoSnapshot(currentUser, true)

    await expect(module.getOrCreateUserABTests(context, USER_ID)).resolves.toEqual(expectedAssignments)

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
        'ab:fixture_publish_intent',
        'ab:fixture_development_environment',
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:no_new_emails',
        'ab:no_fixture_publish_intent',
        'ab:no_fixture_development_environment',
      ]),
    }, expect.any(AbortSignal))
  })

  it('revokes the old intent assignment and creates the new intent assignment atomically', async () => {
    const module = await loadABTestsModule()
    enableNewChannelTest(module)
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
      [BUILDER_TODO_TEST_NAME]: intentAssignment(),
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

    expect(random).toHaveBeenCalledTimes(2)
    const updateParameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    const assignmentsJson = updateParameters.find(value => typeof value === 'string' && value.startsWith('{'))
    expect(JSON.parse(String(assignmentsJson))).toEqual(persisted)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, {
      deleteSegments: expect.arrayContaining([
        'ab:new_channel',
        'ab:no_new_channel',
        'ab:new_emails',
        'ab:fixture_publish_intent',
        'ab:fixture_development_environment',
        'ab:no_builder_intent_targeted',
        'ab:intent_targeted',
        'ab:no_intent_targeted',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:no_new_emails',
        'ab:no_fixture_publish_intent',
        'ab:no_fixture_development_environment',
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
    const module = await loadABTestsModule()
    enablePausedFixtureTests(module)
    const { getOrCreateUserABTests } = module
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
        'ab:no_fixture_development_environment',
        'ab:no_fixture_publish_intent',
      ]),
      email: 'user@example.com',
      segments: expect.arrayContaining([
        'ab:fixture_development_environment',
        'ab:fixture_publish_intent',
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

  it.each(['both', 'exploring'])('reconciles existing apps for persisted double-intent A / %s even without an assignment update', async (intent) => {
    const { getOrCreateUserABTests } = await loadABTestsModule()
    const abtests = { ...persistedAssignments({ channel: null }), todo_list_v4_double_intent: intentAssignment() }
    const context = { get: vi.fn(() => 'request-id') } as never
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ abtests, intent, created_via_invite: false }] })

    expect(await getOrCreateUserABTests(context, USER_ID)).toEqual(abtests)
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
    expect(collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])).toContain(USER_ID)
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
})

describe('prospective email cohort persistence', () => {
  const context = { get: vi.fn(() => 'request-id') } as never
  const createdAt = '2026-10-18T00:00:00.000Z'
  beforeEach(() => {
    vi.resetAllMocks()
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock }))
    getDrizzleClientMock.mockImplementation(() => ({ transaction: drizzleTransactionMock }))
    drizzleTransactionMock.mockImplementation(async callback => await callback({ execute: drizzleExecuteMock }))
    drizzleExecuteMock.mockResolvedValue({ rows: [] })
    closeClientMock.mockResolvedValue(undefined)
    backgroundTaskMock.mockImplementation(async (_c, task) => await task)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('marks signup enrollment before intent is known without inventing a control assignment', async () => {
    const module = await loadABTestsModule()
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ id: USER_ID, created_at: createdAt, created_via_invite: false, abtests: {} }] })
      .mockResolvedValueOnce({ rows: [{ abtests: {} }] })
    await module.syncNewUserABTests(context, 'signup@example.com', { id: USER_ID, created_via_invite: false })
    const parameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    expect(parameters).toContain('["new_emails_v2"]')
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, '2026-10-01T00:00:00.000Z'])('never enrolls a queued old signup with created_at=%s', async (created_at) => {
    const module = await loadABTestsModule()
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ id: USER_ID, created_at, created_via_invite: false, abtests: {} }] })
    await module.syncNewUserABTests(context, 'signup@example.com', { id: USER_ID, created_via_invite: false })
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it.each(['ota', 'builder'])('never enrolls an invited %s signup in v2', async (intent) => {
    const module = await loadABTestsModule()
    const abtests = intent === 'builder' ? { builder_todo_list_v4: intentAssignment() } : {}
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ id: USER_ID, created_at: createdAt, created_via_invite: true, intent, abtests }] })
    await module.syncNewUserABTests(context, 'signup@example.com', { id: USER_ID, created_via_invite: true })
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('does not mark enrollment from an on-demand lookup of a new account', async () => {
    const module = await loadABTestsModule()
    const abtests = { builder_todo_list_v4: intentAssignment() }
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ id: USER_ID, created_at: createdAt, created_via_invite: false, intent: 'builder', abtests }] })
    expect(await module.getOrCreateUserABTests(context, USER_ID)).toEqual(abtests)
    expect(drizzleExecuteMock).toHaveBeenCalledOnce()
  })

  it('assigns the prerequisite and v2 together using locked current intent when signup arrives late', async () => {
    const module = await loadABTestsModule()
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const abtests = { builder_todo_list_v4: intentAssignment(), new_emails_v2: intentAssignment() }
    const current = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: 'signup@example.com', intent: 'builder', abtests, abtests_enrolled: ['new_emails_v2'] }
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ ...current, abtests: {}, abtests_enrolled: undefined }] })
      .mockResolvedValueOnce({ rows: [{ abtests }] })
    queueBentoSnapshot(current)
    queueBentoSnapshot(current, true)
    await module.syncNewUserABTests(context, 'stale-address@example.com', { id: USER_ID, created_via_invite: false })
    const parameters = collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])
    expect(parameters).toContain(JSON.stringify(abtests))
    expect(parameters).toContain('["new_emails_v2"]')
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      email: 'signup@example.com',
      segments: ['ab:builder_todo_list_v4', 'ab:new_emails_v2'],
    }), expect.any(AbortSignal))
    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(pgQueryMock).not.toHaveBeenCalled()
  })

  it.each(['ota', 'builder'])('removes persisted v2 assignments and both provider tags for invited %s users', async (intent) => {
    const module = await loadABTestsModule()
    const abtests = intent === 'builder' ? { builder_todo_list_v4: intentAssignment() } : {}
    const current = { id: USER_ID, created_at: createdAt, created_via_invite: true, email: 'signup@example.com', intent, abtests, abtests_enrolled: ['new_emails_v2'] }
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ ...current, abtests: { ...abtests, new_emails_v2: intentAssignment() } }] })
      .mockResolvedValueOnce({ rows: [{ abtests }] })
    queueBentoSnapshot(current)
    queueBentoSnapshot(current, true)
    expect(await module.getOrCreateUserABTests(context, USER_ID)).toEqual(abtests)
    expect(collectSqlParameterValues(drizzleExecuteMock.mock.calls[1]?.[0])).toContain(JSON.stringify(abtests))
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      segments: intent === 'builder' ? ['ab:builder_todo_list_v4'] : [],
      deleteSegments: expect.arrayContaining(['ab:new_emails_v2', 'ab:no_new_emails_v2']),
    }), expect.any(AbortSignal))
  })

  it('reconciles both v2 tags away when the builder prerequisite becomes control', async () => {
    const module = await loadABTestsModule()
    const abtests = { builder_todo_list_v4: intentAssignment('B') }
    const current = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: 'signup@example.com', intent: 'builder', abtests, abtests_enrolled: ['new_emails_v2'] }
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ ...current, abtests: { ...abtests, new_emails_v2: intentAssignment() } }] })
      .mockResolvedValueOnce({ rows: [{ abtests }] })
    queueBentoSnapshot(current)
    queueBentoSnapshot(current, true)
    expect(await module.getOrCreateUserABTests(context, USER_ID)).toEqual(abtests)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(context, expect.objectContaining({
      segments: ['ab:no_builder_todo_list_v4'],
      deleteSegments: expect.arrayContaining(['ab:new_emails_v2', 'ab:no_new_emails_v2']),
    }), expect.any(AbortSignal))
  })

  it('retries a rejected signup tag delivery with the persisted decision', async () => {
    const module = await loadABTestsModule()
    const current = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: 'signup@example.com', intent: 'builder', abtests: { builder_todo_list_v4: intentAssignment(), new_emails_v2: intentAssignment() }, abtests_enrolled: ['new_emails_v2'], abtests_bento_sync: { pending: true } }
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [current] })
    queueBentoSnapshot(current)
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(false)
    await expect(module.syncNewUserABTests(context, current.email, current)).rejects.toThrow('Bento A/B test delivery failed')
    expect(closeClientMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    const retry = { ...current, abtests_bento_sync: { pending: true } }
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [retry] })
    queueBentoSnapshot(retry)
    queueBentoSnapshot(retry, true)
    await expect(module.syncNewUserABTests(context, current.email, current)).resolves.toBeUndefined()
    expect(syncBentoSubscriberTagsMock.mock.calls[0]?.[1]).toEqual(syncBentoSubscriberTagsMock.mock.calls[1]?.[1])
  })

  it('leaves a rapidly changing signup pending for queue retry after the bounded sync budget', async () => {
    const module = await loadABTestsModule()
    const current = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: 'signup@example.com', intent: 'builder', abtests: { builder_todo_list_v4: intentAssignment(), new_emails_v2: intentAssignment() }, abtests_enrolled: ['new_emails_v2'], abtests_bento_sync: { pending: true, email: 'signup@example.com', cleanup_emails: [] } }
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [current] })
    queueBentoSnapshot(current)
    queueBentoSnapshot({ ...current, intent: 'exploring' })
    queueBentoSnapshot(current)
    queueBentoSnapshot({ ...current, intent: 'exploring' })
    await expect(module.syncNewUserABTests(context, current.email, current)).rejects.toThrow('Bento A/B test delivery failed')
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(3)
  })

  it('commits accepted alias cleanup progress before a bounded signup retry', async () => {
    const module = await loadABTestsModule()
    const row: Record<string, unknown> = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: 'signup@example.com', intent: 'builder', abtests: { builder_todo_list_v4: intentAssignment(), new_emails_v2: intentAssignment() }, abtests_enrolled: ['new_emails_v2'], abtests_bento_sync: { pending: true, email: 'signup@example.com', cleanup_emails: ['old1@example.com', 'old2@example.com', 'old3@example.com'] } }
    drizzleExecuteMock.mockImplementation(async (query) => {
      const state = collectSqlParameterValues(query).find(value => typeof value === 'string' && value.startsWith('{') && value.includes('cleanup_emails'))
      if (state)
        row.abtests_bento_sync = JSON.parse(String(state))
      return { rows: [structuredClone(row)] }
    })
    await expect(module.syncNewUserABTests(context, 'signup@example.com', { id: USER_ID, created_via_invite: false })).rejects.toThrow('Bento A/B test delivery failed')
    expect(row.abtests_bento_sync).toMatchObject({ pending: true, cleanup_emails: [] })
    await module.syncNewUserABTests(context, 'signup@example.com', { id: USER_ID, created_via_invite: false })
    expect(syncBentoSubscriberTagsMock.mock.calls.map(call => call[1].email)).toEqual([
      'old1@example.com',
      'old2@example.com',
      'old3@example.com',
      'signup@example.com',
    ])
    expect(row.abtests_bento_sync).toMatchObject({ pending: false, cleanup_emails: [] })
  })

  it('serializes concurrent intent resolution and preserves one prerequisite decision', async () => {
    const module = await loadABTestsModule()
    const row: Record<string, unknown> = { id: USER_ID, created_at: createdAt, created_via_invite: false, email: null, intent: 'builder', abtests: {}, abtests_enrolled: ['new_emails_v2'] }
    let lock = Promise.resolve()
    drizzleTransactionMock.mockImplementation(async (callback) => {
      const previous = lock
      let unlock!: () => void
      lock = new Promise(resolve => unlock = resolve)
      await previous
      try {
        return await callback({ execute: drizzleExecuteMock })
      }
      finally { unlock() }
    })
    drizzleExecuteMock.mockImplementation(async (query) => {
      const values = collectSqlParameterValues(query)
      const assignments = values.find(value => typeof value === 'string' && value.startsWith('{') && value.includes('branch'))
      if (assignments) {
        row.abtests = JSON.parse(String(assignments))
        return { rows: [{ abtests: row.abtests }] }
      }
      return { rows: [{ ...row }] }
    })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const results = await Promise.all([module.getOrCreateUserABTests(context, USER_ID), module.getOrCreateUserABTests(context, USER_ID)])
    expect(results[0]).toEqual(results[1])
    expect(results[0].new_emails_v2?.branch).toBe('A')
    expect(random).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })
})
