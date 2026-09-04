import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appVersionsMetaSelectEq,
  appVersionsMetaUpdate,
  appVersionsMetaUpdateEq,
  callOrder,
  closeClient,
  createStatsMeta,
  deleteObject,
  getDrizzleClient,
  getPgClient,
  manifestSelectWhere,
  moveObjectToTrash,
  pgQuery,
  purgeFileReadCache,
  supabaseAdmin,
  channelsUpdate,
} = vi.hoisted(() => {
  const callOrder: string[] = []
  const appVersionsMetaSelectEq = vi.fn()
  const appVersionsMetaSelect = vi.fn(() => ({ eq: appVersionsMetaSelectEq }))
  const appVersionsMetaUpdateEq = vi.fn()
  const appVersionsMetaUpdate = vi.fn(() => ({ eq: appVersionsMetaUpdateEq }))
  const channelsUpdateEq = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))
  const channelsUpdate = vi.fn(() => ({ eq: channelsUpdateEq }))
  const supabaseFrom = vi.fn((table: string) => {
    if (table === 'app_versions_meta') {
      return {
        select: appVersionsMetaSelect,
        update: appVersionsMetaUpdate,
      }
    }
    if (table === 'channels') {
      return {
        update: channelsUpdate,
      }
    }
    return {}
  })
  const manifestSelectWhere = vi.fn(async (): Promise<any[]> => [])
  const pgQuery = vi.fn(async (sql: string, params?: any[]) => {
    if (sql === 'BEGIN')
      callOrder.push('begin')
    if (sql.includes('pg_advisory_xact_lock'))
      callOrder.push('lock')
    if (sql.includes('SELECT 1 AS ok'))
      return { rows: [], rowCount: 0 }
    if (sql.includes('DELETE FROM public.manifest WHERE id')) {
      callOrder.push(`db_delete_row:${params?.[0]}`)
      return { rows: [], rowCount: 1 }
    }
    if (sql === 'COMMIT')
      callOrder.push('commit_entry')
    if (sql === 'ROLLBACK')
      callOrder.push('rollback_entry')
    if (sql.includes('SELECT COUNT(*)'))
      return { rows: [{ count: 0 }], rowCount: 1 }
    if (sql.includes('WITH prev AS'))
      return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const moveObjectToTrash = vi.fn(async (..._args: any[]) => {
    callOrder.push('r2_trash')
    return true
  })

  return {
    appVersionsMetaSelectEq,
    appVersionsMetaUpdate,
    appVersionsMetaUpdateEq,
    channelsUpdate,
    channelsUpdateEq,
    callOrder,
    closeClient: vi.fn(),
    createStatsMeta: vi.fn(),
    deleteObject: vi.fn(),
    getDrizzleClient: vi.fn(() => ({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: manifestSelectWhere,
        })),
      })),
    })),
    getPgClient: vi.fn(() => ({ query: pgQuery })),
    manifestSelectWhere,
    moveObjectToTrash,
    pgQuery,
    purgeFileReadCache: vi.fn(async () => {}),
    supabaseAdmin: vi.fn(() => ({ from: supabaseFrom })),
  }
})

vi.mock('../supabase/functions/_backend/files/file_read_cache.ts', () => ({
  purgeFileReadCache,
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  getPath: vi.fn(),
  s3: {
    deleteObject,
    moveObjectToTrash,
  },
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  createStatsMeta,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
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

function makeEntries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    file_hash: `hash-${i}`,
    file_name: `file-${i}.js`,
    s3_path: `orgs/org-1/apps/com.cleanup.test/delta/file-${i}.js`,
  }))
}

describe('on_version_update deleted version cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    deleteObject.mockResolvedValue(true)
    moveObjectToTrash.mockImplementation(async () => {
      callOrder.push('r2_trash')
      return true
    })
    createStatsMeta.mockResolvedValue({ error: null })
    manifestSelectWhere.mockResolvedValue([])
    pgQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql === 'BEGIN')
        callOrder.push('begin')
      if (sql.includes('pg_advisory_xact_lock'))
        callOrder.push('lock')
      if (sql.includes('SELECT 1 AS ok'))
        return { rows: [], rowCount: 0 }
      if (sql.includes('DELETE FROM public.manifest WHERE id')) {
        callOrder.push(`db_delete_row:${params?.[0]}`)
        return { rows: [], rowCount: 1 }
      }
      if (sql === 'COMMIT')
        callOrder.push('commit_entry')
      if (sql === 'ROLLBACK')
        callOrder.push('rollback_entry')
      if (sql.includes('SELECT COUNT(*)'))
        return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('WITH prev AS'))
        return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: { size: 1234 }, error: null })),
    })
    appVersionsMetaUpdateEq.mockResolvedValue({ error: null })
  })

  it('moves the bundle to trash and clears stored size for soft-deleted versions', async () => {
    const response = await deleteIt(createContext(), createVersion())
    expect(response.status).toBe(200)
    expect(channelsUpdate).toHaveBeenCalledTimes(2)
    expect(purgeFileReadCache).toHaveBeenCalledWith(
      'orgs/org-1/apps/com.cleanup.test/1.0.0.zip',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(moveObjectToTrash).toHaveBeenCalledWith(expect.anything(), 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip')
    expect(appVersionsMetaUpdate).toHaveBeenCalledWith({ size: 0 })
  })

  it('skips bundle trash when r2_path does not match the canonical version path', async () => {
    const response = await deleteIt(createContext(), createVersion({
      r2_path: 'orgs/org-1/apps/com.cleanup.test/9.9.9.zip',
    }))

    expect(response.status).toBe(200)
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('moves retained source-org bundle path to trash after owner_org transfer', async () => {
    const response = await deleteIt(createContext(), createVersion({
      owner_org: 'org-2',
      r2_path: 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip',
    }))

    expect(response.status).toBe(200)
    expect(moveObjectToTrash).toHaveBeenCalledWith(
      expect.anything(),
      'orgs/org-1/apps/com.cleanup.test/1.0.0.zip',
    )
  })

  it('locks, trashes R2, then deletes each manifest DB row', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(1))

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))

    expect(callOrder).toContain('lock')
    expect(callOrder.indexOf('r2_trash')).toBeGreaterThan(callOrder.indexOf('lock'))
    expect(callOrder.indexOf('db_delete_row:1000')).toBeGreaterThan(callOrder.indexOf('r2_trash'))
    expect(pgQuery).toHaveBeenCalledWith(expect.stringContaining('WITH prev AS'), expect.any(Array))
    // Postgres rejects chr(0) with 54000 "null character not permitted".
    const lockSql = pgQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('pg_advisory_xact_lock'))?.[0] as string
    expect(lockSql).toContain('hashtext($1::text), hashtext($2::text)')
    expect(lockSql).not.toContain('chr(0)')
  })

  it('does not delete DB rows when R2 trash fails', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(1))
    moveObjectToTrash.mockImplementation(async () => {
      callOrder.push('r2_trash')
      return false
    })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Cannot move S3 object for deleted manifest file to trash',
    )
    expect(callOrder).toContain('r2_trash')
    expect(callOrder.some(v => v.startsWith('db_delete_row:'))).toBe(false)
    expect(callOrder).toContain('rollback_entry')
  })

  it('skips R2 trash when another version still references the file, then deletes the row', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(1))
    pgQuery.mockImplementation((async (sql: string, params?: any[]) => {
      if (sql === 'BEGIN')
        callOrder.push('begin')
      if (sql.includes('pg_advisory_xact_lock'))
        callOrder.push('lock')
      if (sql.includes('SELECT 1 AS ok'))
        return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes('DELETE FROM public.manifest WHERE id')) {
        callOrder.push(`db_delete_row:${params?.[0]}`)
        return { rows: [], rowCount: 1 }
      }
      if (sql === 'COMMIT')
        callOrder.push('commit_entry')
      if (sql.includes('SELECT COUNT(*)'))
        return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('WITH prev AS'))
        return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }) as any)

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))

    expect(moveObjectToTrash).not.toHaveBeenCalled()
    expect(callOrder).toContain('db_delete_row:1000')
  })

  it('still clears manifests when version meta is missing', async () => {
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: null, error: { message: 'not found' } })),
    })
    manifestSelectWhere.mockResolvedValue(makeEntries(1))

    const response = await deleteIt(createContext(), createVersion({ manifest_count: 1 }))

    expect(response.status).toBe(200)
    expect(callOrder.indexOf('r2_trash')).toBeLessThan(callOrder.indexOf('db_delete_row:1000'))
    expect(moveObjectToTrash).toHaveBeenCalledWith(expect.anything(), 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip')
  })

  it('keeps the queue retryable when moving the bundle to trash fails after manifest cleanup', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(1))
    moveObjectToTrash.mockImplementation(async (_c: unknown, path: string) => {
      callOrder.push(path.includes('.zip') ? 'bundle_trash' : 'r2_trash')
      return !path.includes('.zip')
    })

    await expect(deleteIt(createContext(), createVersion({ manifest_count: 1 }))).rejects.toThrow(
      'Cannot move S3 object for deleted version to trash',
    )
    expect(callOrder).toContain('r2_trash')
    expect(callOrder).toContain('db_delete_row:1000')
  })

  it('throws when rows remain after the trash/delete pass', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(1))
    pgQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql === 'BEGIN')
        callOrder.push('begin')
      if (sql.includes('pg_advisory_xact_lock'))
        callOrder.push('lock')
      if (sql.includes('SELECT 1 AS ok'))
        return { rows: [], rowCount: 0 }
      if (sql.includes('DELETE FROM public.manifest WHERE id')) {
        callOrder.push(`db_delete_row:${params?.[0]}`)
        return { rows: [], rowCount: 1 }
      }
      if (sql === 'COMMIT')
        callOrder.push('commit_entry')
      if (sql === 'ROLLBACK')
        callOrder.push('rollback_entry')
      if (sql.includes('SELECT COUNT(*)'))
        return { rows: [{ count: 2 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Manifest rows still present after trash/delete pass',
    )
    expect(callOrder).toContain('rollback_entry')
  })

  it('routes already-deleted versions with leftover counts to cleanup_manifest', () => {
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      createVersion({ deleted_at: '2026-01-01T00:00:00Z', manifest_count: 3 }),
      createVersion({ deleted_at: '2026-01-01T00:00:00Z', manifest_count: 3 }),
    )).toBe('cleanup_manifest')
  })
})

describe('on_version_update manifest cleanup load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    createStatsMeta.mockResolvedValue({ error: null })
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: { size: 0 }, error: null })),
    })
    appVersionsMetaUpdateEq.mockResolvedValue({ error: null })
    moveObjectToTrash.mockImplementation(async () => {
      callOrder.push('r2_trash')
      return true
    })
    pgQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT 1 AS ok'))
        return { rows: [], rowCount: 0 }
      if (sql.includes('DELETE FROM public.manifest WHERE id')) {
        callOrder.push(`db_delete_row:${params?.[0]}`)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SELECT COUNT(*)'))
        return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('WITH prev AS'))
        return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
  })

  it('handles 5000-file manifests with R2 before every DB delete', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(5000))

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 5000 }))

    expect(response.status).toBe(200)
    expect(moveObjectToTrash).toHaveBeenCalledTimes(5000)
    expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(5000)
    expect(pgQuery).toHaveBeenCalledWith(expect.stringContaining('WITH prev AS'), expect.any(Array))
  }, 60_000)

  it('keeps remaining rows retryable when one file in a large batch fails trash', async () => {
    manifestSelectWhere.mockResolvedValue(makeEntries(200))
    moveObjectToTrash.mockImplementation(async (_c: unknown, path: string) => {
      callOrder.push('r2_trash')
      if (path.endsWith('file-150.js'))
        return false
      return true
    })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 200 }))).rejects.toThrow(
      'Cannot move S3 object for deleted manifest file to trash',
    )

    const deletedIds = callOrder.filter(v => v.startsWith('db_delete_row:')).map(v => Number(v.split(':')[1]))
    expect(deletedIds).not.toContain(1150)
  }, 30_000)
})
