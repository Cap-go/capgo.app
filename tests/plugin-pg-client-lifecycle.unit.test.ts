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

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn((_c, p) => p),
    getEnv: vi.fn((_c, key: string) => {
      if (key === 'ENV_NAME')
        return 'capgo_plugin-eu-prod-test'
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
      if (key === 'requireReadReplica')
        return true
      if (key === 'skipSupabaseStatsFallback')
        return true
      if (key === 'skipSupabaseNotificationWrites')
        return true
      if (key === 'queuePluginNotifications')
        return true
      if (key === 'skipChannelSelfPostgresFallback')
        return true
      return undefined
    },
    set: vi.fn(),
    req: {
      raw: {
        cf: { continent: 'EU' },
        headers: new Headers(),
      },
      url: 'http://localhost/updates',
      header: () => undefined,
    },
    res: {
      headers: new Headers([['X-Worker-Source', 'plugin']]),
    },
  } as any
}

describe('plugin_runtime Hyperdrive pg Client lifecycle', () => {
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
    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()

    const first = await getPgClient(c, true)
    const second = await getPgClient(c, true)

    expect(first).not.toBe(second)
    expect(ClientMock).toHaveBeenCalledTimes(2)
    expect(PoolMock).not.toHaveBeenCalled()
    expect(clientConnectMock).toHaveBeenCalledTimes(2)
    expect(ClientMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      connectionString: 'postgres://hyperdrive-eu',
    }))

    await closeClient(c, first)
    expect(first.end).not.toHaveBeenCalled()
  })

  it('does not return the Hyperdrive Client until connect() resolves', async () => {
    let releaseConnect!: () => void
    clientConnectMock.mockImplementation(() => new Promise<undefined>((resolve) => {
      releaseConnect = () => resolve(undefined)
    }))

    const { getPgClient } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()

    let settled: 'pending' | 'done' = 'pending'
    const pending = getPgClient(c, true).then((client) => {
      settled = 'done'
      return client
    })

    // Yield so connect() is reached, but do not release it yet.
    await Promise.resolve()
    expect(clientConnectMock).toHaveBeenCalledTimes(1)
    expect(settled).toBe('pending')

    releaseConnect()
    const client = await pending
    expect(settled).toBe('done')
    expect(client).toBeTruthy()
  })

  it('isolates Clients across different Hyperdrive connection strings', async () => {
    const { getPgClient } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const a = createContext({
      HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://hyperdrive-a' },
    })
    const b = createContext({
      HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://hyperdrive-b' },
    })

    const clientA = await getPgClient(a, true)
    const clientB = await getPgClient(b, true)

    expect(clientA).not.toBe(clientB)
    expect(ClientMock).toHaveBeenCalledTimes(2)
    expect(ClientMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      connectionString: 'postgres://hyperdrive-a',
    }))
    expect(ClientMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      connectionString: 'postgres://hyperdrive-b',
    }))
  })

  it('uses Pool + end() outside workerd (non-Hyperdrive contract)', async () => {
    getRuntimeKeyMock.mockReturnValue('node')
    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
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
    const { cloudlogErr } = await import('../supabase/functions/_backend/plugin_runtime/utils/logging.ts')
    // No Hyperdrive binding → falls through to MAIN_SUPABASE_DB_URL / Pool path
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

    const { getPgClient, closeClient } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext({
      HYPERDRIVE_CAPGO_READ_EU: undefined,
    })
    // Allow fallback when replica is missing
    c.get = (key: string) => {
      if (key === 'requestId')
        return 'request-id'
      return undefined
    }

    const client = await getPgClient(c, false)
    expect(PoolMock).toHaveBeenCalled()
    expect(ClientMock).not.toHaveBeenCalled()

    await expect(closeClient(c, client)).resolves.toBeUndefined()
    expect(cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({
      message: 'PG client end failed',
    }))
  })
})
