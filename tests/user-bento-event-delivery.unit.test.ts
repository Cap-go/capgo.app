import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deliverPendingUserBentoEvents,
  recordUserBentoEvent,
} from '../supabase/functions/_backend/utils/user_bento_events.ts'

const mocks = vi.hoisted(() => ({
  backgroundTask: vi.fn(),
  closeClient: vi.fn(),
  cloudlogErr: vi.fn(),
  getPgClient: vi.fn(),
  serializeError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
  trackBentoEvents: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  trackBentoEvents: mocks.trackBentoEvents,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: mocks.cloudlogErr,
  serializeError: mocks.serializeError,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: mocks.closeClient,
  getPgClient: mocks.getPgClient,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: mocks.backgroundTask,
}))

const USER_ID = '8e0931de-11ea-4b93-9061-00f0a06ca744'
const OBSERVED_AT = '2026-08-22T10:00:00.000Z'

interface QueryResult {
  rows: Array<Record<string, unknown>>
}

function createContext(): Context {
  return {
    get: vi.fn((key: string) => key === 'requestId' ? 'user-bento-request' : undefined),
  } as unknown as Context
}

function normalizeSql(sql: unknown): string {
  return String(sql)
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .trim()
}

function pendingLoginOnboarding() {
  return {
    bento_events: {
      'cli:login_successful': {
        occurrence_count: 1,
        details: [{
          observed_at: OBSERVED_AT,
          source_event: 'User CLI login',
        }],
      },
    },
  }
}

function sentCommandOnboarding(extraEvents: Record<string, unknown> = {}) {
  return {
    bento_events: {
      'cli:command_invoked': {
        occurrence_count: 1,
        details: [{
          observed_at: OBSERVED_AT,
          source_event: 'CLI Command Invoked',
          command_path: 'app list',
        }],
        sent_at: '2026-08-22T10:00:01.000Z',
      },
      ...extraEvents,
    },
  }
}

function createFastPool(result: QueryResult | Error) {
  const query = vi.fn(async (_sql: unknown, _params?: unknown[]) => {
    if (result instanceof Error)
      throw result
    return result
  })
  return {
    connect: vi.fn(),
    query,
  }
}

function createTransactionPool(options: {
  email?: string
  lockOnboarding?: unknown
  lockRows?: Array<Record<string, unknown>>
  query?: (sql: string, params: unknown[] | undefined) => Promise<QueryResult>
} = {}) {
  const statements: string[] = []
  const query = vi.fn(async (rawSql: unknown, params?: unknown[]) => {
    const sql = normalizeSql(rawSql)
    statements.push(sql)
    if (options.query)
      return options.query(sql, params)
    if (sql.startsWith('SELECT email, onboarding FROM public.users')) {
      return {
        rows: options.lockRows ?? [{
          email: options.email ?? 'bento.user@example.com',
          onboarding: options.lockOnboarding ?? {},
        }],
      }
    }
    return { rows: [] }
  })
  const client = {
    query,
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  }
  return { client, pool, statements }
}

function expectAdditiveBentoPatch(queryCall: unknown[] | undefined) {
  expect(queryCall).toBeDefined()
  const sql = normalizeSql(queryCall?.[0])
  expect(sql).toContain('SET onboarding = jsonb_set(onboarding, \'{bento_events}\'')
  expect(sql).toContain('CASE WHEN jsonb_typeof(onboarding -> \'bento_events\') = \'object\' THEN onboarding -> \'bento_events\' ELSE \'{}\'::jsonb END || $2::jsonb')
  expect(sql).not.toContain('SET onboarding = $2')
}

function patchCall(client: ReturnType<typeof createTransactionPool>['client']) {
  return client.query.mock.calls.find(([sql]) => normalizeSql(sql).startsWith('UPDATE public.users'))
}

function expectSanitizedLogs(...privateValues: string[]) {
  const logs = JSON.stringify(mocks.cloudlogErr.mock.calls)
  for (const value of privateValues)
    expect(logs).not.toContain(value)
}

describe('user Bento event delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.backgroundTask.mockImplementation((_c: Context, task: Promise<unknown>) => task)
    mocks.closeClient.mockResolvedValue(undefined)
    mocks.trackBentoEvents.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits an additive observation transaction before scheduling delivery', async () => {
    const fastPool = createFastPool({ rows: [{ onboarding: {} }] })
    const observationTx = createTransactionPool({ lockOnboarding: {} })
    const deliveryTx = createTransactionPool({ lockRows: [] })
    mocks.getPgClient
      .mockReturnValueOnce(fastPool)
      .mockReturnValueOnce(observationTx.pool)
      .mockReturnValueOnce(deliveryTx.pool)

    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'CLI Command Invoked',
      observedAt: OBSERVED_AT,
      tags: { command_path: 'app list' },
      userId: USER_ID,
    })).resolves.toBeUndefined()

    expect(observationTx.statements).toEqual([
      'BEGIN',
      'SELECT email, onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE',
      expect.stringMatching(/^UPDATE public\.users SET onboarding = jsonb_set/),
      'COMMIT',
    ])
    const update = patchCall(observationTx.client)
    expectAdditiveBentoPatch(update)
    expect(update?.[1]).toEqual([
      USER_ID,
      JSON.stringify({
        'cli:command_invoked': {
          details: [{
            observed_at: OBSERVED_AT,
            source_event: 'CLI Command Invoked',
            command_path: 'app list',
          }],
          occurrence_count: 1,
        },
      }),
    ])
    expect(observationTx.client.query.mock.invocationCallOrder[3])
      .toBeLessThan(mocks.backgroundTask.mock.invocationCallOrder[0]!)
    expect(observationTx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), observationTx.pool)
  })

  it('uses one indexed primary read and stops when all mapped events are sent', async () => {
    const fastPool = createFastPool({
      rows: [{ onboarding: sentCommandOnboarding() }],
    })
    mocks.getPgClient.mockReturnValueOnce(fastPool)

    await recordUserBentoEvent(createContext(), {
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:02.000Z',
      userId: USER_ID,
    })

    expect(mocks.getPgClient).toHaveBeenCalledOnce()
    expect(mocks.getPgClient).toHaveBeenCalledWith(expect.anything())
    expect(fastPool.query).toHaveBeenCalledOnce()
    expect(normalizeSql(fastPool.query.mock.calls[0]?.[0])).toBe(
      'SELECT onboarding FROM public.users WHERE id = $1::uuid',
    )
    expect(fastPool.query.mock.calls[0]?.[1]).toEqual([USER_ID])
    expect(fastPool.connect).not.toHaveBeenCalled()
    expect(mocks.backgroundTask).not.toHaveBeenCalled()
    expect(mocks.trackBentoEvents).not.toHaveBeenCalled()
    expect(mocks.closeClient).toHaveBeenCalledTimes(1)
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), fastPool)
  })

  it('holds the user lock through Bento and commits an additive sent_at patch', async () => {
    const order: string[] = []
    const onboarding = pendingLoginOnboarding()
    const tx = createTransactionPool({
      query: async (sql) => {
        if (sql === 'BEGIN')
          order.push('BEGIN')
        else if (sql.startsWith('SELECT email, onboarding'))
          order.push('LOCK')
        else if (sql.startsWith('UPDATE public.users'))
          order.push('UPDATE')
        else if (sql === 'COMMIT')
          order.push('COMMIT')
        return sql.startsWith('SELECT email, onboarding')
          ? { rows: [{ email: 'bento.user@example.com', onboarding }] }
          : { rows: [] }
      },
    })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)
    mocks.trackBentoEvents.mockImplementation(async () => {
      order.push('BENTO')
      return true
    })

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(true)

    expect(order).toEqual(['BEGIN', 'LOCK', 'BENTO', 'UPDATE', 'COMMIT'])
    expect(mocks.trackBentoEvents).toHaveBeenCalledWith(
      expect.anything(),
      'bento.user@example.com',
      [{
        event: 'cli:login_successful',
        data: {
          occurrence_count: 1,
          observations: onboarding.bento_events['cli:login_successful'].details,
        },
      }],
      expect.any(AbortSignal),
    )
    const update = patchCall(tx.client)
    expectAdditiveBentoPatch(update)
    expect(update?.[1]?.[0]).toBe(USER_ID)
    expect(JSON.parse(String(update?.[1]?.[1]))).toEqual({
      'cli:login_successful': {
        ...onboarding.bento_events['cli:login_successful'],
        sent_at: expect.any(String),
      },
    })
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
  })

  it.each([false, undefined])('rolls back without writing when Bento returns %s', async (accepted) => {
    const tx = createTransactionPool({ lockOnboarding: pendingLoginOnboarding() })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)
    mocks.trackBentoEvents.mockResolvedValueOnce(accepted)

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)

    expect(tx.statements).toEqual([
      'BEGIN',
      'SELECT email, onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE',
      'ROLLBACK',
    ])
    expect(patchCall(tx.client)).toBeUndefined()
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
  })

  it('retries after Bento acceptance when the first sent_at update fails', async () => {
    const onboarding = pendingLoginOnboarding()
    const firstTx = createTransactionPool({
      query: async (sql) => {
        if (sql.startsWith('SELECT email, onboarding'))
          return { rows: [{ email: 'bento.user@example.com', onboarding }] }
        if (sql.startsWith('UPDATE public.users'))
          throw new Error('sent_at write failed')
        return { rows: [] }
      },
    })
    const secondTx = createTransactionPool({ lockOnboarding: onboarding })
    mocks.getPgClient
      .mockReturnValueOnce(firstTx.pool)
      .mockReturnValueOnce(secondTx.pool)

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)
    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(true)

    expect(mocks.trackBentoEvents).toHaveBeenCalledTimes(2)
    expect(firstTx.statements.at(-1)).toBe('ROLLBACK')
    expect(secondTx.statements.at(-1)).toBe('COMMIT')
    expectAdditiveBentoPatch(patchCall(firstTx.client))
    expectAdditiveBentoPatch(patchCall(secondTx.client))
  })

  it('schedules all existing pending entries even when the observed event is already sent', async () => {
    const login = pendingLoginOnboarding().bento_events['cli:login_successful']
    const onboardingRun = {
      occurrence_count: 2,
      details: [{
        observed_at: '2026-08-22T10:00:03.000Z',
        source_event: 'onboarding-run-started',
        onboarding_event_version: 1,
      }],
    }
    const storedOnboarding = sentCommandOnboarding({
      'cli:login_successful': login,
      'cli:onboarding_run_started': onboardingRun,
    })
    const fastPool = createFastPool({ rows: [{ onboarding: storedOnboarding }] })
    const deliveryTx = createTransactionPool({ lockOnboarding: storedOnboarding })
    mocks.getPgClient
      .mockReturnValueOnce(fastPool)
      .mockReturnValueOnce(deliveryTx.pool)

    await recordUserBentoEvent(createContext(), {
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:04.000Z',
      tags: { command_path: 'app list' },
      userId: USER_ID,
    })

    expect(mocks.backgroundTask).toHaveBeenCalledOnce()
    expect(mocks.getPgClient).toHaveBeenCalledTimes(2)
    expect(deliveryTx.client.query.mock.calls.filter(([sql]) => normalizeSql(sql).startsWith('UPDATE public.users')))
      .toHaveLength(1)
    expect(mocks.trackBentoEvents).toHaveBeenCalledWith(
      expect.anything(),
      'bento.user@example.com',
      [
        { event: 'cli:login_successful', data: { occurrence_count: 1, observations: login.details } },
        { event: 'cli:onboarding_run_started', data: { occurrence_count: 2, observations: onboardingRun.details } },
      ],
      expect.any(AbortSignal),
    )
  })

  it('swallows a fast primary read error without scheduling delivery or leaking stored data to logs', async () => {
    const fastPool = createFastPool(new Error('primary unavailable'))
    mocks.getPgClient.mockReturnValueOnce(fastPool)

    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'User CLI login',
      observedAt: OBSERVED_AT,
      userId: USER_ID,
    })).resolves.toBeUndefined()

    expect(mocks.backgroundTask).not.toHaveBeenCalled()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), fastPool)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith({
      requestId: 'user-bento-request',
      message: 'user Bento event delivery failed',
      phase: 'observe',
      userId: USER_ID,
      event: 'cli:login_successful',
      error: { message: 'primary unavailable' },
    })
    const logged = mocks.cloudlogErr.mock.calls[0]?.[0]
    expect(logged).not.toHaveProperty('email')
    expect(logged).not.toHaveProperty('details')
  })

  it('serializes concurrent delivery calls with the user row lock', async () => {
    let releaseSecondLock: (value: QueryResult) => void = () => {}
    const secondLock = new Promise<QueryResult>((resolve) => {
      releaseSecondLock = resolve
    })
    const firstTx = createTransactionPool({
      query: async (sql) => {
        if (sql.startsWith('SELECT email, onboarding')) {
          return {
            rows: [{ email: 'bento.user@example.com', onboarding: pendingLoginOnboarding() }],
          }
        }
        if (sql === 'COMMIT') {
          releaseSecondLock({
            rows: [{
              email: 'bento.user@example.com',
              onboarding: {
                bento_events: {
                  'cli:login_successful': {
                    ...pendingLoginOnboarding().bento_events['cli:login_successful'],
                    sent_at: '2026-08-22T10:00:05.000Z',
                  },
                },
              },
            }],
          })
        }
        return { rows: [] }
      },
    })
    const secondTx = createTransactionPool({
      query: async (sql) => {
        if (sql.startsWith('SELECT email, onboarding'))
          return secondLock
        return { rows: [] }
      },
    })
    mocks.getPgClient
      .mockReturnValueOnce(firstTx.pool)
      .mockReturnValueOnce(secondTx.pool)

    await expect(Promise.all([
      deliverPendingUserBentoEvents(createContext(), USER_ID),
      deliverPendingUserBentoEvents(createContext(), USER_ID),
    ])).resolves.toEqual([true, true])

    expect(mocks.trackBentoEvents).toHaveBeenCalledTimes(1)
    expect(firstTx.statements).toEqual([
      'BEGIN',
      'SELECT email, onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE',
      expect.stringMatching(/^UPDATE public\.users/),
      'COMMIT',
    ])
    expect(secondTx.statements).toEqual([
      'BEGIN',
      'SELECT email, onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE',
      'COMMIT',
    ])
  })

  it('aborts Bento after five seconds and rolls back without leaking a timer', async () => {
    vi.useFakeTimers()
    const tx = createTransactionPool({ lockOnboarding: pendingLoginOnboarding() })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)
    mocks.trackBentoEvents.mockImplementation(async (
      _c: Context,
      _email: string,
      _events: unknown[],
      signal: AbortSignal,
    ) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }))

    const delivery = deliverPendingUserBentoEvents(createContext(), USER_ID)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(delivery).resolves.toBe(false)
    expect(tx.statements.at(-1)).toBe('ROLLBACK')
    expect(patchCall(tx.client)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['missing user', []],
    ['no pending events', [{ email: 'bento.user@example.com', onboarding: sentCommandOnboarding() }]],
  ])('commits and cleans up without Bento for %s', async (_name, lockRows) => {
    const tx = createTransactionPool({ lockRows })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(true)

    expect(tx.statements).toEqual([
      'BEGIN',
      'SELECT email, onboarding FROM public.users WHERE id = $1::uuid FOR UPDATE',
      'COMMIT',
    ])
    expect(mocks.trackBentoEvents).not.toHaveBeenCalled()
    expect(patchCall(tx.client)).toBeUndefined()
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
  })

  it('rolls back a failed commit and still releases the client and closes the pool', async () => {
    const tx = createTransactionPool({
      query: async (sql) => {
        if (sql.startsWith('SELECT email, onboarding')) {
          return {
            rows: [{ email: 'bento.user@example.com', onboarding: pendingLoginOnboarding() }],
          }
        }
        if (sql === 'COMMIT')
          throw new Error('commit failed')
        return { rows: [] }
      },
    })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)

    expect(tx.statements.at(-1)).toBe('ROLLBACK')
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'deliver',
      userId: USER_ID,
      event: undefined,
      error: { message: 'commit failed' },
    }))
  })

  it.each([
    ['BEGIN', 'BEGIN', false],
    ['lock', 'SELECT', true],
    ['update', 'UPDATE', true],
    ['commit', 'COMMIT', true],
  ])('contains a TX1 %s failure and rolls back only after BEGIN', async (_label, failure, shouldRollback) => {
    const failureError = new Error(`TX1 ${failure} failed`)
    const fastPool = createFastPool({ rows: [{ onboarding: {} }] })
    const tx = createTransactionPool({
      query: async (sql) => {
        if (
          sql === failure
          || (failure === 'SELECT' && sql.startsWith('SELECT email, onboarding'))
          || (failure === 'UPDATE' && sql.startsWith('UPDATE public.users'))
        ) {
          throw failureError
        }
        if (sql.startsWith('SELECT email, onboarding'))
          return { rows: [{ email: 'private.user@example.com', onboarding: {} }] }
        return { rows: [] }
      },
    })
    mocks.getPgClient
      .mockReturnValueOnce(fastPool)
      .mockReturnValueOnce(tx.pool)

    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'User CLI login',
      observedAt: OBSERVED_AT,
      userId: USER_ID,
    })).resolves.toBeUndefined()

    expect(tx.statements.includes('ROLLBACK')).toBe(shouldRollback)
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
    expect(mocks.backgroundTask).not.toHaveBeenCalled()
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it.each(['observe', 'deliver'] as const)('evicts the %s client and logs safely when rollback fails', async (phase) => {
    vi.useFakeTimers()
    const transactionError = new Error(`${phase} transaction failed`)
    const rollbackError = new Error(`${phase} rollback failed`)
    const tx = createTransactionPool({
      email: 'private.user@example.com',
      query: async (sql) => {
        if (sql === 'ROLLBACK')
          throw rollbackError
        if (sql.startsWith('SELECT email, onboarding')) {
          return {
            rows: [{
              email: 'private.user@example.com',
              onboarding: phase === 'deliver' ? pendingLoginOnboarding() : {},
            }],
          }
        }
        if (phase === 'observe' && sql.startsWith('UPDATE public.users'))
          throw transactionError
        return { rows: [] }
      },
    })
    if (phase === 'observe') {
      const fastPool = createFastPool({ rows: [{ onboarding: {} }] })
      mocks.getPgClient
        .mockReturnValueOnce(fastPool)
        .mockReturnValueOnce(tx.pool)
      await expect(recordUserBentoEvent(createContext(), {
        sourceEvent: 'User CLI login',
        observedAt: OBSERVED_AT,
        userId: USER_ID,
      })).resolves.toBeUndefined()
    }
    else {
      mocks.getPgClient.mockReturnValueOnce(tx.pool)
      mocks.trackBentoEvents.mockRejectedValueOnce(transactionError)
      await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }

    expect(tx.statements.at(-1)).toBe('ROLLBACK')
    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(tx.client.release).toHaveBeenCalledWith(rollbackError)
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
    expect(JSON.stringify(mocks.cloudlogErr.mock.calls)).toContain(`${phase} rollback failed`)
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it('contains pool creation and connection failures for both public functions', async () => {
    const poolError = new Error('pool creation failed')
    mocks.getPgClient.mockImplementationOnce(() => {
      throw poolError
    })
    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'User CLI login',
      observedAt: OBSERVED_AT,
      userId: USER_ID,
    })).resolves.toBeUndefined()
    expect(mocks.closeClient).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const connectError = new Error('connect failed')
    const fastPool = createFastPool({ rows: [{ onboarding: {} }] })
    const observationPool = { connect: vi.fn().mockRejectedValue(connectError) }
    mocks.getPgClient
      .mockReturnValueOnce(fastPool)
      .mockReturnValueOnce(observationPool)
    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'User CLI login',
      observedAt: OBSERVED_AT,
      userId: USER_ID,
    })).resolves.toBeUndefined()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), fastPool)
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), observationPool)

    vi.clearAllMocks()
    mocks.getPgClient.mockImplementationOnce(() => {
      throw poolError
    })
    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)
    expect(mocks.closeClient).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const deliveryPool = { connect: vi.fn().mockRejectedValue(connectError) }
    mocks.getPgClient.mockReturnValueOnce(deliveryPool)
    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), deliveryPool)
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it.each(['observe', 'deliver'] as const)('contains and logs a %s client release failure', async (phase) => {
    const transactionError = new Error(`${phase} transaction failed`)
    const releaseError = new Error(`${phase} release failed`)
    const tx = createTransactionPool({
      query: async (sql) => {
        if (sql.startsWith('SELECT email, onboarding')) {
          return {
            rows: [{
              email: 'private.user@example.com',
              onboarding: phase === 'deliver' ? pendingLoginOnboarding() : {},
            }],
          }
        }
        if (phase === 'observe' && sql.startsWith('UPDATE public.users'))
          throw transactionError
        return { rows: [] }
      },
    })
    tx.client.release.mockImplementation(() => {
      throw releaseError
    })
    if (phase === 'observe') {
      const fastPool = createFastPool({ rows: [{ onboarding: {} }] })
      mocks.getPgClient
        .mockReturnValueOnce(fastPool)
        .mockReturnValueOnce(tx.pool)
      await expect(recordUserBentoEvent(createContext(), {
        sourceEvent: 'User CLI login',
        observedAt: OBSERVED_AT,
        userId: USER_ID,
      })).resolves.toBeUndefined()
    }
    else {
      mocks.getPgClient.mockReturnValueOnce(tx.pool)
      mocks.trackBentoEvents.mockRejectedValueOnce(transactionError)
      await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)
    }

    expect(tx.client.release).toHaveBeenCalledOnce()
    expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
    expect(JSON.stringify(mocks.cloudlogErr.mock.calls)).toContain(`${phase} release failed`)
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it.each(['observe', 'deliver'] as const)('contains and logs a %s pool close failure', async (phase) => {
    const closeError = new Error(`${phase} close failed`)
    if (phase === 'observe') {
      const fastPool = createFastPool(new Error('fast read failed'))
      mocks.getPgClient.mockReturnValueOnce(fastPool)
      mocks.closeClient.mockRejectedValueOnce(closeError)
      await expect(recordUserBentoEvent(createContext(), {
        sourceEvent: 'User CLI login',
        observedAt: OBSERVED_AT,
        userId: USER_ID,
      })).resolves.toBeUndefined()
      expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), fastPool)
    }
    else {
      const tx = createTransactionPool({ lockRows: [] })
      mocks.getPgClient.mockReturnValueOnce(tx.pool)
      mocks.closeClient.mockRejectedValueOnce(closeError)
      await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(true)
      expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), tx.pool)
    }

    expect(JSON.stringify(mocks.cloudlogErr.mock.calls)).toContain(`${phase} close failed`)
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it('clears the timeout and rolls back when Bento throws', async () => {
    vi.useFakeTimers()
    const tx = createTransactionPool({
      email: 'private.user@example.com',
      lockOnboarding: pendingLoginOnboarding(),
    })
    mocks.getPgClient.mockReturnValueOnce(tx.pool)
    mocks.trackBentoEvents.mockRejectedValueOnce(new Error('Bento transport failed'))

    await expect(deliverPendingUserBentoEvents(createContext(), USER_ID)).resolves.toBe(false)

    expect(tx.statements.at(-1)).toBe('ROLLBACK')
    expect(vi.getTimerCount()).toBe(0)
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })

  it('contains a backgroundTask rejection after scheduling delivery', async () => {
    const pendingLogin = pendingLoginOnboarding().bento_events['cli:login_successful']
    const storedOnboarding = sentCommandOnboarding({ 'cli:login_successful': pendingLogin })
    const fastPool = createFastPool({ rows: [{ onboarding: storedOnboarding }] })
    const deliveryTx = createTransactionPool({ lockRows: [] })
    const backgroundError = new Error('background scheduling failed')
    mocks.getPgClient
      .mockReturnValueOnce(fastPool)
      .mockReturnValueOnce(deliveryTx.pool)
    mocks.backgroundTask.mockRejectedValueOnce(backgroundError)

    await expect(recordUserBentoEvent(createContext(), {
      sourceEvent: 'CLI Command Invoked',
      observedAt: '2026-08-22T10:00:04.000Z',
      userId: USER_ID,
    })).resolves.toBeUndefined()
    await vi.waitFor(() => expect(mocks.closeClient).toHaveBeenCalledWith(expect.anything(), deliveryTx.pool))

    expect(JSON.stringify(mocks.cloudlogErr.mock.calls)).toContain('background scheduling failed')
    expectSanitizedLogs('private.user@example.com', 'observations', 'secret-token')
  })
})
