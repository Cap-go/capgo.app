import { describe, it, vi } from 'vitest'

const poolConstructor = vi.hoisted(() => vi.fn())

vi.mock('pg', async (importOriginal) => ({
  ...await importOriginal<typeof import('pg')>(),
  Pool: poolConstructor.mockImplementation(function PoolMock(this: { on: ReturnType<typeof vi.fn> }) {
    this.on = vi.fn()
  }),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/geolocation.ts', () => ({
  getClientDbRegionSB: () => 'EU',
}))

function createContext(options: {
  flags?: Partial<Record<'useBackgroundHyperdrive' | 'requireReadReplica', boolean>>
  env?: Record<string, unknown>
  url?: string
} = {}) {
  const flags = options.flags ?? {}
  const env = options.env ?? {}
  return {
    env,
    get: (key: string) => {
      if (key in flags)
        return flags[key as keyof typeof flags]
      if (key === 'requestId')
        return 'request-id'
      return undefined
    },
    set: vi.fn(),
    req: {
      url: options.url ?? 'https://api.capgo.app/bundle',
      raw: { cf: {}, headers: new Headers() },
    },
    res: { headers: new Headers() },
    header: vi.fn(),
  } as any
}

describe('Hyperdrive background routing', () => {
  it.concurrent('uses BACKGROUND_EU for background work when the binding exists', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({
      flags: { useBackgroundHyperdrive: true },
      env: {
        HYPERDRIVE_CAPGO_BACKGROUND_EU: { connectionString: 'postgres://background-hyperdrive' },
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context)).toBe('postgres://background-hyperdrive')
    expect(context.set).toHaveBeenCalledWith('databaseSource', 'HYPERDRIVE_CAPGO_BACKGROUND_EU')
  })

  it.concurrent('falls back to DIRECT_EU for background work when BACKGROUND_EU is absent', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({
      flags: { useBackgroundHyperdrive: true },
      env: {
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context)).toBe('postgres://direct-hyperdrive')
  })

  it.concurrent('uses DIRECT_EU for user-facing requests even when BACKGROUND_EU exists', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({
      env: {
        HYPERDRIVE_CAPGO_BACKGROUND_EU: { connectionString: 'postgres://background-hyperdrive' },
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context)).toBe('postgres://direct-hyperdrive')
  })

  it.concurrent('detects background work from /triggers/ route prefix', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({
      url: 'https://api.capgo.app/triggers/on_version_update',
      env: {
        HYPERDRIVE_CAPGO_BACKGROUND_EU: { connectionString: 'postgres://background-hyperdrive' },
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context)).toBe('postgres://background-hyperdrive')
  })

  it.concurrent('plugin runtime pg keeps DIRECT_EU without background binding support', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const context = createContext({
      flags: { useBackgroundHyperdrive: true },
      env: {
        HYPERDRIVE_CAPGO_BACKGROUND_EU: { connectionString: 'postgres://background-hyperdrive' },
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context)).toBe('postgres://direct-hyperdrive')
  })

  it.concurrent('prefers BACKGROUND_EU over read replicas for optional background reads', async ({ expect }) => {
    const { getDatabaseURL } = await import('../supabase/functions/_backend/utils/pg.ts')
    const context = createContext({
      flags: { useBackgroundHyperdrive: true },
      env: {
        HYPERDRIVE_CAPGO_BACKGROUND_EU: { connectionString: 'postgres://background-hyperdrive' },
        HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://read-eu' },
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    })

    expect(getDatabaseURL(context, true)).toBe('postgres://background-hyperdrive')
  })

  it.concurrent('uses a smaller pg pool max for background work', async ({ expect }) => {
    poolConstructor.mockClear()
    const { getPgClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    getPgClient(createContext({
      flags: { useBackgroundHyperdrive: true },
      env: {
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    }))

    expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ max: 2 }))

    poolConstructor.mockClear()
    getPgClient(createContext({
      env: {
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://direct-hyperdrive' },
      },
    }))

    expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ max: 4 }))
  })
})
