import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRuntimeKeyMock, PoolMock, ClientMock, poolOnMock, clientOnMock, clientConnectMock } = vi.hoisted(() => {
  const poolOnMock = vi.fn()
  const clientOnMock = vi.fn()
  const clientConnectMock = vi.fn(async () => undefined)
  const PoolMock = vi.fn(function PoolMock(
    this: { on: typeof poolOnMock, end: ReturnType<typeof vi.fn> },
    _options?: { max?: number, connectionString?: string },
  ) {
    this.on = poolOnMock
    this.end = vi.fn(async () => undefined)
    return this
  })
  const ClientMock = vi.fn(function ClientMock(
    this: { on: typeof clientOnMock, connect: typeof clientConnectMock, end: ReturnType<typeof vi.fn> },
    _options?: { connectionString?: string },
  ) {
    this.on = clientOnMock
    this.connect = clientConnectMock
    this.end = vi.fn(async () => undefined)
    return this
  })
  return {
    getRuntimeKeyMock: vi.fn(() => 'workerd'),
    PoolMock,
    ClientMock,
    poolOnMock,
    clientOnMock,
    clientConnectMock,
  }
})

vi.mock('hono/adapter', () => ({
  getRuntimeKey: getRuntimeKeyMock,
}))

vi.mock('pg', () => ({
  Pool: PoolMock,
  Client: ClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>()
  return {
    ...actual,
    cloudlog: vi.fn(),
    cloudlogErr: vi.fn(),
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn((_c: any, p: any) => p),
    getEnv: vi.fn((_c, key: string) => {
      if (key === 'ENV_NAME')
        return 'capgo_api-eu-prod-test'
      if (key === 'SB_REGION')
        return 'eu-west-3'
      if (key === 'SUPABASE_DB_URL')
        return 'postgres://supabase-direct'
      if (key === 'MAIN_SUPABASE_DB_URL')
        return 'postgres://main-pooler'
      return ''
    }),
    existInEnv: vi.fn((_c, key: string) => key === 'ENV_NAME' || key === 'SB_REGION' || key === 'MAIN_SUPABASE_DB_URL'),
  }
})

function createContext(env: Record<string, any> = {}) {
  return {
    env: {
      HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://hyperdrive-eu' },
      ...env,
    },
    get: (key: string) => {
      if (key === 'requestId')
        return 'request-id'
      return undefined
    },
    set: vi.fn(),
    req: {
      raw: {
        cf: { continent: 'EU' },
        headers: new Headers(),
      },
      url: 'http://localhost/private/latency',
      header: () => undefined,
    },
    res: {
      headers: new Headers([['X-Worker-Source', 'api']]),
    },
  } as any
}

describe('main pg.ts Hyperdrive pg Client lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    PoolMock.mockClear()
    ClientMock.mockClear()
    poolOnMock.mockClear()
    clientOnMock.mockClear()
    clientConnectMock.mockReset()
    clientConnectMock.mockImplementation(async () => undefined)
    getRuntimeKeyMock.mockReturnValue('workerd')
  })

  it('uses a fresh connected Client per Hyperdrive request and does not end() it', async () => {
    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    const c = createContext()

    const first = await getPgClient(c, true)
    const second = await getPgClient(c, true)

    expect(first).not.toBe(second)
    expect(ClientMock).toHaveBeenCalledTimes(2)
    expect(PoolMock).not.toHaveBeenCalled()
    expect(clientConnectMock).toHaveBeenCalledTimes(2)

    await closeClient(c, first)
    expect(first.end).not.toHaveBeenCalled()
  })

  it('uses Pool + end() outside workerd (non-Hyperdrive contract)', async () => {
    getRuntimeKeyMock.mockReturnValue('node')
    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    const c = createContext()

    const first = await getPgClient(c, true)
    const second = await getPgClient(c, true)

    expect(first).not.toBe(second)
    expect(PoolMock).toHaveBeenCalledTimes(2)
    expect(ClientMock).not.toHaveBeenCalled()
    expect(PoolMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ max: 4 }))

    await closeClient(c, first)
    expect(first.end).toHaveBeenCalledTimes(1)
  })

  it('ends non-Hyperdrive workerd Pools and logs end failures without throwing', async () => {
    const { cloudlogErr } = await import('../supabase/functions/_backend/utils/logging.ts')
    PoolMock.mockImplementation(function PoolMock(
      this: { on: typeof poolOnMock, end: ReturnType<typeof vi.fn> },
      _options?: { max?: number },
    ) {
      this.on = poolOnMock
      this.end = vi.fn(async () => {
        throw new Error('end unsupported')
      })
      return this
    })

    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    const c = createContext({
      HYPERDRIVE_CAPGO_READ_EU: undefined,
    })

    const client = await getPgClient(c, false)
    expect(PoolMock).toHaveBeenCalled()
    expect(PoolMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ max: 1 }))
    expect(ClientMock).not.toHaveBeenCalled()

    await expect(closeClient(c, client)).resolves.toBeUndefined()
    expect(cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({
      message: 'PG client end failed',
    }))
  })
})
