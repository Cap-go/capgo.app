import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  versionMeta,
  callOrder,
  closeClient,
  createStatsMeta,
  deleteObject,
  drizzleTransaction,
  getDrizzleClient,
  getPgClient,
  manifestSelectWhere,
  moveObjectToTrash,
  pgQuery,
  purgeFileReadCache,
} = vi.hoisted(() => {
  const callOrder: string[] = []
  const versionMeta: { value: { size: number } | null } = { value: null }
  const manifestSelectWhere = vi.fn(async (): Promise<any[]> => [])
  // Every suite installs its SQL behavior through mockCleanupPg().
  const pgQuery = vi.fn(async (_sql: string, _params?: any[]): Promise<any> => ({ rows: [], rowCount: 0 }))
  let dialectPromise: Promise<any> | undefined
  const compileDrizzleQuery = async (query: any) => {
    dialectPromise ??= import('drizzle-orm/pg-core').then(({ PgDialect }) => new PgDialect())
    const dialect = await dialectPromise
    return dialect.sqlToQuery(query)
  }
  const drizzleExecute = async (query: any) => {
    const { sql: queryText, params } = await compileDrizzleQuery(query)
    return pgQuery(queryText, params)
  }
  const drizzleDelete = (_table: unknown) => ({
    where: async (condition: any) => {
      const { sql: whereSql, params } = await compileDrizzleQuery(condition)
      return pgQuery(`DELETE FROM public.manifest WHERE ${whereSql}`, params)
    },
  })
  const drizzleTransaction = vi.fn(async (operation: (tx: { delete: typeof drizzleDelete, execute: typeof drizzleExecute }) => Promise<unknown>) => {
    callOrder.push('begin')
    try {
      const result = await operation({ delete: drizzleDelete, execute: drizzleExecute })
      callOrder.push('commit_entry')
      return result
    }
    catch (error) {
      callOrder.push('rollback_entry')
      throw error
    }
  })
  const moveObjectToTrash = vi.fn(async (..._args: any[]) => {
    callOrder.push('r2_trash')
    return true
  })
  return {
    versionMeta,
    callOrder,
    closeClient: vi.fn(),
    createStatsMeta: vi.fn(),
    deleteObject: vi.fn(),
    drizzleTransaction,
    getDrizzleClient: vi.fn(() => ({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: manifestSelectWhere,
        })),
      })),
      execute: drizzleExecute,
      transaction: drizzleTransaction,
    })),
    getPgClient: vi.fn(async () => ({ query: pgQuery })),
    manifestSelectWhere,
    moveObjectToTrash,
    pgQuery,
    purgeFileReadCache: vi.fn(async () => {}),
  }
})

vi.mock('../supabase/functions/_backend/files/file_read_cache.ts', () => ({
  isVersionDeleted: (row: { deleted?: boolean | null, deleted_at?: string | Date | null } | null | undefined) => {
    if (!row)
      return false
    return row.deleted === true || row.deleted_at != null
  },
  purgeFileReadCache,
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  getPath: vi.fn(),
  s3: {
    deleteObject,
    moveObjectToTrash,
    getSizeDiagnostics: vi.fn(async () => ({ size: 4321, selectedCandidateKey: 'bundle.zip' })),
  },
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  createStatsMeta,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient,
  getDrizzleClient,
  getPgClient,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

const { deleteIt, onVersionUpdateTestUtils } = await import('../supabase/functions/_backend/triggers/on_version_update.ts')

function createContext() {
  return {
    get: vi.fn(() => undefined),
    json: vi.fn((body: unknown, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any
}

function createVersion(overrides: Record<string, unknown> = {}) {
  return {
    deleted: true,
    deleted_at: '2026-01-01T00:00:00Z',
    app_id: 'com.cleanup.test',
    id: 123,
    manifest: null,
    manifest_count: 0,
    name: '1.0.0',
    owner_org: 'org-1',
    r2_path: 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip',
    checksum: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    storage_provider: 'r2',
    ...overrides,
  } as any
}

function mockCleanupPg() {
  pgQuery.mockImplementation(async (query: string) => {
    if (query.includes('SELECT deleted'))
      return { rows: [{ deleted: true, deleted_at: null }] }
    if (query.includes('WITH prev AS'))
      callOrder.push('finalize')
    if (query.includes('SELECT size FROM public.app_versions_meta'))
      return { rows: versionMeta.value ? [{ row: versionMeta.value }] : [] }
    return { rows: [], rowCount: 0 }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  mockCleanupPg()
  moveObjectToTrash.mockResolvedValue(true)
  createStatsMeta.mockResolvedValue({ error: null })
  versionMeta.value = { size: 1234 }
})

describe('deleted version storage boundaries', () => {
  it('leaves shared and unreferenced delta objects intact and trashes only the canonical ZIP', async () => {
    const response = await deleteIt(createContext(), createVersion({ manifest_count: 2 }))
    expect(response.status).toBe(200)
    expect(callOrder).toContain('finalize')
    expect(moveObjectToTrash.mock.calls.map(args => args[1])).toEqual([createVersion().r2_path])
    expect(deleteObject).not.toHaveBeenCalled()
    const statements = pgQuery.mock.calls.map(([sql]) => sql)
    expect(statements.filter(sql => sql.startsWith('UPDATE public.channels'))).toHaveLength(2)
    expect(purgeFileReadCache).toHaveBeenCalledWith(createVersion().r2_path, createVersion().checksum)
    expect(pgQuery).toHaveBeenCalledWith('UPDATE public.app_versions_meta SET size = 0 WHERE id = $1', [123])
    // Removed at the bundle's deletion, not when the job runs.
    expect(createStatsMeta).toHaveBeenCalledWith(expect.anything(), 'com.cleanup.test', 123, -1234, '2026-01-01T00:00:00Z')
  })

  it('fails without zeroing the size when the removal storage event is not recorded', async () => {
    // Storage is billed from version_meta: the retry must still find the size to record it.
    createStatsMeta.mockResolvedValue({ error: new Error('connection reset') })
    await expect(deleteIt(createContext(), createVersion())).rejects.toThrow()
    expect(pgQuery).not.toHaveBeenCalledWith('UPDATE public.app_versions_meta SET size = 0 WHERE id = $1', [123])
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('fails the job when the version metadata cannot be read', async () => {
    pgQuery.mockImplementation(async (query: string) => {
      if (query.includes('SELECT deleted'))
        return { rows: [{ deleted: true, deleted_at: null }] }
      if (query.includes('SELECT size FROM public.app_versions_meta'))
        throw new Error('connection reset')
      return { rows: [], rowCount: 0 }
    })
    await expect(deleteIt(createContext(), createVersion())).rejects.toThrow()
    expect(createStatsMeta).not.toHaveBeenCalled()
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('closes the storage lifetime from the upload event when the size is missing', async () => {
    versionMeta.value = null
    const response = await deleteIt(createContext(), createVersion())
    expect(response.status).toBe(200)
    const statements = pgQuery.mock.calls.map(([sql]) => sql as string)
    const close = pgQuery.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO public.version_meta') && (sql as string).includes('-added.size'))
    expect(close).toBeDefined()
    // Closed at the bundle's deletion, never before its upload event.
    expect(close?.[1]).toEqual(['com.cleanup.test', 123, '2026-01-01T00:00:00Z'])
    expect(close?.[0]).toContain('GREATEST(added.timestamp')
    expect(statements.length).toBeGreaterThan(0)
    expect(createStatsMeta).not.toHaveBeenCalled()
  })

  it('fails the upload job when the bundle size cannot be saved', async () => {
    pgQuery.mockImplementation(async (query: string) => {
      if (query.includes('INSERT INTO public.app_versions_meta'))
        throw new Error('connection reset')
      return { rows: [], rowCount: 0 }
    })
    const { onVersionUpdateTestUtils } = await import('../supabase/functions/_backend/triggers/on_version_update.ts')
    await expect(onVersionUpdateTestUtils.v2PathSize(createContext(), { query: pgQuery } as any, createVersion(), createVersion().r2_path)).rejects.toThrow()
    // No storage event without the size the removal will need.
    expect(createStatsMeta).not.toHaveBeenCalled()
  })

  it('treats an already zero size as recorded', async () => {
    createStatsMeta.mockResolvedValue({ error: 'size is 0' })
    const response = await deleteIt(createContext(), createVersion())
    expect(response.status).toBe(200)
  })

  it('skips a noncanonical ZIP path', async () => {
    await deleteIt(createContext(), createVersion({ r2_path: 'orgs/org-1/apps/com.cleanup.test/9.9.9.zip' }))
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('trashes a retained source-org ZIP after ownership transfer', async () => {
    await deleteIt(createContext(), createVersion({ owner_org: 'org-2' }))
    expect(moveObjectToTrash).toHaveBeenCalledWith(expect.anything(), createVersion().r2_path)
  })

  it('finalizes manifest counters even when metadata is missing', async () => {
    versionMeta.value = null
    await deleteIt(createContext(), createVersion({ manifest_count: 1 }))
    expect(callOrder).toContain('finalize')
    expect(moveObjectToTrash).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'throw'])('keeps ZIP failure retryable after database cleanup (%s)', async (failure) => {
    moveObjectToTrash.mockImplementation(async () => {
      if (failure === 'throw')
        throw new Error('storage unavailable')
      return false
    })
    await expect(deleteIt(createContext(), createVersion())).rejects.toThrow('Cannot move S3 object for deleted version to trash')
    expect(callOrder).toContain('finalize')
    expect(closeClient).toHaveBeenCalledTimes(1)
  })

  it('cleans legacy database rows for zero-count deleted versions on repeated updates', () => {
    const version = createVersion({ manifest_count: 0 })
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(version, version)).toBe('cleanup_manifest')
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(version, { ...version, deleted: false })).toBe('delete')
    expect(onVersionUpdateTestUtils.getDeletedVersionAction({ ...version, deleted: false, deleted_at: null }, version)).toBe('continue')
  })
})

describe('manifest finalization', () => {
  it('finalizes a deleted version in one transaction and one pool, making zero per-file R2 calls', async () => {
    await onVersionUpdateTestUtils.deleteManifest(createContext(), createVersion({ manifest_count: 5000 }))
    expect(drizzleTransaction).toHaveBeenCalledTimes(1)
    expect(callOrder.filter(value => value === 'finalize')).toHaveLength(1)
    expect(getPgClient).toHaveBeenCalledExactlyOnceWith(expect.anything(), false)
    expect(closeClient).toHaveBeenCalledTimes(1)
    expect(manifestSelectWhere).not.toHaveBeenCalled()
    expect(moveObjectToTrash).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })
})
