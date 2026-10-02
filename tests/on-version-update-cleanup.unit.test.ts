import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appVersionsMetaSelectEq,
  appVersionsMetaUpdate,
  appVersionsMetaUpdateEq,
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
  persistVersionManifestEntries,
  purgeFileReadCache,
  restoreObjectFromTrash,
  sendEventToTracking,
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
    appVersionsMetaSelectEq,
    appVersionsMetaUpdate,
    appVersionsMetaUpdateEq,
    channelsUpdate,
    channelsUpdateEq,
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
    getPgClient: vi.fn(() => ({})),
    manifestSelectWhere,
    moveObjectToTrash,
    pgQuery,
    persistVersionManifestEntries: vi.fn(),
    purgeFileReadCache: vi.fn(async () => {}),
    restoreObjectFromTrash: vi.fn(async (..._args: any[]) => true),
    sendEventToTracking: vi.fn(),
    supabaseAdmin: vi.fn(() => ({ from: supabaseFrom })),
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
    restoreObjectFromTrash,
  },
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  createStatsMeta,
}))

vi.mock('../supabase/functions/_backend/utils/manifest_persist.ts', () => ({
  persistVersionManifestEntries,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking,
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

const manifestEntriesById = new Map<number, ReturnType<typeof makeEntries>[number]>()

function useManifestEntries(entries: ReturnType<typeof makeEntries>) {
  manifestEntriesById.clear()
  for (const entry of entries)
    manifestEntriesById.set(entry.id, entry)
  manifestSelectWhere.mockResolvedValue(entries)
}

/**
 * Simulates the batched cleanup SQL: the release CTE deletes rows still used by
 * another version (sharedIds) and returns the rest as last references.
 */
function mockCleanupPg(options: {
  sharedIds?: Set<number>
  remainingCount?: number
  reReferencedPaths?: string[]
  pendingRestorePaths?: string[]
  leaseHeldElsewhere?: boolean
  pendingDeleteWork?: { has_rows: boolean, has_size: boolean }
} = {}) {
  const sharedIds = options.sharedIds ?? new Set<number>()
  pgQuery.mockImplementation(async (sql: string, params?: any[]) => {
    if (sql.includes('public.version_cleanup_leases')) {
      if (sql.includes('INSERT INTO')) {
        callOrder.push('lease_acquire')
        // Params: version id, owner, lease seconds.
        return options.leaseHeldElsewhere ? { rows: [], rowCount: 0 } : { rows: [{ owner: params?.[1] }], rowCount: 1 }
      }
      callOrder.push('lease_release')
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE public.app_versions') && sql.includes('SET updated_at = now()')) {
      callOrder.push('requeue')
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('AS has_rows')) {
      const pending = options.pendingDeleteWork ?? { has_rows: false, has_size: false }
      return { rows: [pending], rowCount: 1 }
    }
    if (sql.includes('public.manifest_trash_restore_pending')) {
      if (sql.includes('INSERT INTO')) {
        for (const path of params?.[1] as string[])
          callOrder.push(`pending_insert:${path}`)
      }
      else if (sql.includes('DELETE FROM')) {
        for (const path of params?.[1] as string[])
          callOrder.push(`pending_delete:${path}`)
      }
      else {
        const rows = (options.pendingRestorePaths ?? []).map(s3_path => ({ s3_path }))
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      callOrder.push('lock')
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('WITH batch AS')) {
      const ids = params?.[0] as number[]
      const rows = []
      for (const id of ids) {
        if (sharedIds.has(id))
          callOrder.push(`db_release_row:${id}`)
        else if (manifestEntriesById.has(id))
          rows.push(manifestEntriesById.get(id)!)
      }
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('SELECT DISTINCT s3_path')) {
      callOrder.push('recheck_refs')
      const rows = (options.reReferencedPaths ?? []).map(s3_path => ({ s3_path }))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('DELETE FROM public.manifest')) {
      for (const id of params?.[0] as number[])
        callOrder.push(`db_delete_row:${id}`)
      return { rows: [], rowCount: (params?.[0] as number[]).length }
    }
    if (sql.includes('SELECT COUNT(*)'))
      return { rows: [{ count: options.remainingCount ?? 0 }], rowCount: 1 }
    if (sql.includes('WITH prev AS'))
      return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
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
    persistVersionManifestEntries.mockResolvedValue({ inserted: 2, alreadyPresent: false })
    sendEventToTracking.mockResolvedValue(undefined)
    createStatsMeta.mockResolvedValue({ error: null })
    restoreObjectFromTrash.mockResolvedValue(true)
    useManifestEntries([])
    mockCleanupPg()
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

  it('locks the batch once, trashes R2 outside the lock, then deletes the DB row', async () => {
    useManifestEntries(makeEntries(1))

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))

    expect(callOrder.filter(v => v === 'lock')).toHaveLength(1)
    // The lock transaction commits before any R2 round trip.
    expect(callOrder.indexOf('commit_entry')).toBeGreaterThan(callOrder.indexOf('lock'))
    expect(callOrder.indexOf('r2_trash')).toBeGreaterThan(callOrder.indexOf('commit_entry'))
    expect(callOrder.indexOf('db_delete_row:1000')).toBeGreaterThan(callOrder.indexOf('r2_trash'))
    expect(pgQuery).toHaveBeenCalledWith(expect.stringContaining('WITH prev AS'), expect.any(Array))
    // Same key space as the previous per-file lock, taken in sorted order.
    // Postgres rejects chr(0) with 54000 "null character not permitted".
    const lockSql = pgQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('pg_advisory_xact_lock'))?.[0] as string
    expect(lockSql).toContain('hashtext(file_hash::text) AS hash_key, hashtext(file_name::text) AS name_key')
    expect(lockSql).toContain('ORDER BY 1, 2')
    expect(lockSql).not.toContain('chr(0)')
  })

  it('does not delete DB rows when R2 trash fails', async () => {
    useManifestEntries(makeEntries(1))
    moveObjectToTrash.mockImplementation(async () => {
      callOrder.push('r2_trash')
      return false
    })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Cannot move S3 object for deleted manifest file to trash',
    )
    expect(callOrder).toContain('r2_trash')
    expect(callOrder.some(v => v.startsWith('db_delete_row:'))).toBe(false)
  })

  it('releases rows still referenced by another version without touching R2', async () => {
    useManifestEntries(makeEntries(1))
    mockCleanupPg({ sharedIds: new Set([1000]) })

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))

    expect(moveObjectToTrash).not.toHaveBeenCalled()
    expect(callOrder).toContain('db_release_row:1000')
    expect(callOrder.some(v => v.startsWith('db_delete_row:'))).toBe(false)
  })

  it('restores an object that a new upload referenced while it was being trashed', async () => {
    useManifestEntries(makeEntries(2))
    const reReferencedPath = makeEntries(2)[1]!.s3_path
    mockCleanupPg({ reReferencedPaths: [reReferencedPath] })

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 2 }))

    expect(restoreObjectFromTrash).toHaveBeenCalledTimes(1)
    expect(restoreObjectFromTrash).toHaveBeenCalledWith(expect.anything(), reReferencedPath)
    // Recheck runs after the moves and before this version's rows are dropped.
    expect(callOrder.lastIndexOf('r2_trash')).toBeLessThan(callOrder.indexOf('recheck_refs'))
    expect(callOrder.indexOf('recheck_refs')).toBeLessThan(callOrder.indexOf('db_delete_row:1000'))
    expect(callOrder).toContain('db_delete_row:1001')
  })

  it('persists a failed restore and keeps rows tracked', async () => {
    useManifestEntries(makeEntries(1))
    const path = makeEntries(1)[0]!.s3_path
    mockCleanupPg({ reReferencedPaths: [path] })
    restoreObjectFromTrash.mockResolvedValue(false)

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Cannot restore re-referenced manifest file from trash',
    )
    expect(callOrder).toContain(`pending_insert:${path}`)
    expect(callOrder.some(v => v.startsWith('db_delete_row:'))).toBe(false)
  })

  it('retries a pending restore before releasing any row, and keeps everything while it fails', async () => {
    useManifestEntries(makeEntries(1))
    const path = makeEntries(1)[0]!.s3_path
    // The retry sees the new upload's row: this row would be released as shared.
    mockCleanupPg({ pendingRestorePaths: [path], sharedIds: new Set([1000]) })
    restoreObjectFromTrash.mockResolvedValue(false)

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Cannot restore re-referenced manifest file from trash',
    )
    expect(restoreObjectFromTrash).toHaveBeenCalledWith(expect.anything(), path)
    expect(callOrder).not.toContain('lock')
    expect(callOrder).not.toContain('db_release_row:1000')
    expect(callOrder).not.toContain(`pending_delete:${path}`)
  })

  it('clears a pending restore once it succeeds, then releases the shared row', async () => {
    useManifestEntries(makeEntries(1))
    const path = makeEntries(1)[0]!.s3_path
    mockCleanupPg({ pendingRestorePaths: [path], sharedIds: new Set([1000]) })

    await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))

    expect(restoreObjectFromTrash).toHaveBeenCalledWith(expect.anything(), path)
    expect(callOrder.indexOf(`pending_delete:${path}`)).toBeLessThan(callOrder.indexOf('db_release_row:1000'))
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('still clears manifests when version meta is missing', async () => {
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: null, error: { message: 'not found' } })),
    })
    useManifestEntries(makeEntries(1))

    const response = await deleteIt(createContext(), createVersion({ manifest_count: 1 }))

    expect(response.status).toBe(200)
    expect(callOrder.indexOf('r2_trash')).toBeLessThan(callOrder.indexOf('db_delete_row:1000'))
    expect(moveObjectToTrash).toHaveBeenCalledWith(expect.anything(), 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip')
  })

  it('keeps the queue retryable when moving the bundle to trash fails after manifest cleanup', async () => {
    useManifestEntries(makeEntries(1))
    moveObjectToTrash.mockImplementation(async (_c: unknown, path: string) => {
      callOrder.push(path.includes('.zip') ? 'bundle_trash' : 'r2_trash')
      return !path.includes('.zip')
    })

    await expect(deleteIt(createContext(), createVersion({ manifest_count: 1 }))).rejects.toThrow(
      'Cannot move S3 object for deleted version to trash',
    )
    expect(callOrder).toContain('r2_trash')
    expect(callOrder).toContain('db_delete_row:1000')
    // The stored size stays set, so the sweeper finds the unfinished delete.
    expect(appVersionsMetaUpdate).not.toHaveBeenCalled()
    expect(createStatsMeta).not.toHaveBeenCalled()
  })

  it('re-queues a continuation for versions deleted through deleted_at alone', async () => {
    useManifestEntries(makeEntries(120))
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(start).mockReturnValue(start + 10 * 60 * 1000)

    try {
      await deleteIt(createContext(), createVersion({ manifest_count: 120 }))
    }
    finally {
      now.mockRestore()
    }

    const requeueSql = pgQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('SET updated_at = now()'))?.[0] as string
    expect(requeueSql).toContain('(deleted = true OR deleted_at IS NOT NULL)')
  })

  it('throws when rows remain after the trash/delete pass', async () => {
    useManifestEntries(makeEntries(1))
    mockCleanupPg({ remainingCount: 2 })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Manifest rows still present after trash/delete pass',
    )
    expect(callOrder).toContain('rollback_entry')
  })

  it('acknowledges a duplicate message without working while another pass holds the lease', async () => {
    useManifestEntries(makeEntries(3))
    mockCleanupPg({ leaseHeldElsewhere: true })

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 3 }))

    expect(response.status).toBe(200)
    expect(callOrder).toEqual(['lease_acquire'])
    expect(moveObjectToTrash).not.toHaveBeenCalled()
  })

  it('stops at the time budget, releases the lease, then re-queues without finishing the bundle', async () => {
    useManifestEntries(makeEntries(120))
    const start = Date.now()
    // First read sets the deadline; later reads are past it.
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(start).mockReturnValue(start + 10 * 60 * 1000)

    try {
      const response = await deleteIt(createContext(), createVersion({ manifest_count: 120 }))

      expect(response.status).toBe(200)
      // One 50-file batch ran, then the pass handed over.
      expect(callOrder.filter(v => v === 'lock')).toHaveLength(1)
      expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(50)
      expect(pgQuery).not.toHaveBeenCalledWith(expect.stringContaining('WITH prev AS'), expect.any(Array))
      expect(appVersionsMetaUpdate).not.toHaveBeenCalled()
      expect(moveObjectToTrash).not.toHaveBeenCalledWith(expect.anything(), 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip')
      expect(callOrder.indexOf('lease_release')).toBeLessThan(callOrder.indexOf('requeue'))
    }
    finally {
      now.mockRestore()
    }
  })

  it('releases the lease and does not re-queue when a pass fails', async () => {
    useManifestEntries(makeEntries(1))
    moveObjectToTrash.mockResolvedValue(false)

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Cannot move S3 object for deleted manifest file to trash',
    )
    expect(callOrder).toContain('lease_release')
    expect(callOrder).not.toContain('requeue')
  })

  it('does not record a zero storage delta when the bundle size was already cleared', async () => {
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: { size: 0 }, error: null })),
    })

    await deleteIt(createContext(), createVersion())

    expect(createStatsMeta).not.toHaveBeenCalled()
  })

  it('finds pending delete work for leftover rows, or for an unfinished bundle cleanup within 30 days', async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    mockCleanupPg({ pendingDeleteWork: { has_rows: true, has_size: false } })
    expect(await onVersionUpdateTestUtils.hasPendingDeleteWork(createContext(), createVersion({ deleted: true, deleted_at: old }))).toBe(true)

    mockCleanupPg({ pendingDeleteWork: { has_rows: false, has_size: true } })
    expect(await onVersionUpdateTestUtils.hasPendingDeleteWork(createContext(), createVersion({ deleted: true, deleted_at: recent }))).toBe(true)
    // Older unfinished deletes predate the current flow: left for a reviewed repair.
    expect(await onVersionUpdateTestUtils.hasPendingDeleteWork(createContext(), createVersion({ deleted: true, deleted_at: old }))).toBe(false)

    mockCleanupPg({ pendingDeleteWork: { has_rows: false, has_size: false } })
    expect(await onVersionUpdateTestUtils.hasPendingDeleteWork(createContext(), createVersion({ deleted: true, deleted_at: recent }))).toBe(false)
  })

  it('routes already-deleted versions with leftover counts to cleanup_manifest', () => {
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      createVersion({ deleted_at: '2026-01-01T00:00:00Z', manifest_count: 3 }),
      createVersion({ deleted_at: '2026-01-01T00:00:00Z', manifest_count: 3 }),
    )).toBe('cleanup_manifest')
  })
})

describe('on_version_update legacy manifest tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistVersionManifestEntries.mockResolvedValue({ inserted: 2, alreadyPresent: false })
    sendEventToTracking.mockResolvedValue(undefined)
  })

  it('tracks a migrated legacy manifest against the uploading user and organization', async () => {
    const manifestEntries = [
      { file_name: 'index.html', file_hash: 'hash-1', s3_path: 'orgs/org-1/apps/com.cleanup.test/delta/index.html' },
      { file_name: 'main.js', file_hash: 'hash-2', s3_path: 'orgs/org-1/apps/com.cleanup.test/delta/main.js' },
      { file_name: '', file_hash: '', s3_path: '' },
    ]
    const record = createVersion({
      cli_version: '8.29.3',
      manifest: manifestEntries,
      user_id: 'user-1',
    })

    await onVersionUpdateTestUtils.handleManifest(createContext(), record)

    expect(persistVersionManifestEntries).toHaveBeenCalledWith(
      expect.anything(),
      { id: 123, app_id: 'com.cleanup.test' },
      manifestEntries,
      {
        clearAppVersionsManifest: true,
        s3PathPrefix: 'orgs/org-1/apps/com.cleanup.test/',
      },
    )
    expect(sendEventToTracking).toHaveBeenCalledWith(expect.anything(), {
      channel: 'bundle',
      event: 'Legacy Bundle Manifest Migrated',
      user_id: 'user-1',
      groups: { organization: 'org-1' },
      nonPersonTags: {
        $insert_id: 'legacy-manifest:123',
        app_id: 'com.cleanup.test',
        cli_version: '8.29.3',
        entry_count: 2,
        version_id: 123,
      },
    })
  })

  it('does not use the organization as the PostHog user identity', async () => {
    const record = createVersion({
      manifest: [{ file_name: 'index.html', file_hash: 'hash-1', s3_path: 'orgs/org-1/apps/com.cleanup.test/delta/index.html' }],
      user_id: null,
    })

    await onVersionUpdateTestUtils.handleManifest(createContext(), record)

    expect(sendEventToTracking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      user_id: undefined,
      groups: { organization: 'org-1' },
    }))
  })

  it('does not track a legacy manifest when every entry is filtered out', async () => {
    persistVersionManifestEntries.mockResolvedValue({ inserted: 0, alreadyPresent: false })

    await onVersionUpdateTestUtils.handleManifest(createContext(), createVersion({
      manifest: [{ file_name: '', file_hash: '', s3_path: '' }],
      user_id: 'user-1',
    }))

    expect(sendEventToTracking).not.toHaveBeenCalled()
  })

  it('does not track an already-migrated legacy manifest retry', async () => {
    persistVersionManifestEntries.mockResolvedValue({ inserted: 0, alreadyPresent: true })

    await onVersionUpdateTestUtils.handleManifest(createContext(), createVersion({
      manifest: [{ file_name: 'index.html', file_hash: 'hash-1', s3_path: 'orgs/org-1/apps/com.cleanup.test/delta/index.html' }],
      user_id: 'user-1',
    }))

    expect(sendEventToTracking).not.toHaveBeenCalled()
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
    restoreObjectFromTrash.mockResolvedValue(true)
    mockCleanupPg()
  })

  it('handles 5000-file manifests with R2 before every DB delete', async () => {
    useManifestEntries(makeEntries(5000))

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 5000 }))

    expect(response.status).toBe(200)
    expect(moveObjectToTrash).toHaveBeenCalledTimes(5000)
    expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(5000)
    expect(pgQuery).toHaveBeenCalledWith(expect.stringContaining('WITH prev AS'), expect.any(Array))
  }, 60_000)

  it('takes one batched lock statement per 50 files instead of one lock transaction per file', async () => {
    useManifestEntries(makeEntries(5000))
    // Most files of a bundle are shared with the previous version.
    mockCleanupPg({ sharedIds: new Set(makeEntries(5000).filter((_, i) => i % 10 !== 0).map(entry => entry.id)) })

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 5000 }))

    expect(response.status).toBe(200)
    expect(callOrder.filter(v => v === 'lock')).toHaveLength(100)
    // Below max_locks_per_transaction (64) so batches cannot exhaust the shared lock table.
    const lockBatchSizes = pgQuery.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('pg_advisory_xact_lock'))
      .map(([, params]) => (params?.[0] as number[]).length)
    expect(Math.max(...lockBatchSizes)).toBe(50)
    expect(moveObjectToTrash).toHaveBeenCalledTimes(500)
    expect(callOrder.filter(v => v.startsWith('db_release_row:'))).toHaveLength(4500)
    expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(500)
  }, 60_000)

  it('uses one bounded cleanup pool and one Drizzle transaction per 50-file batch', async () => {
    useManifestEntries(makeEntries(500))

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 500 }))

    expect(response.status).toBe(200)
    // lease + read + cleanup + final write + lease release, not one pool per manifest file
    expect(getPgClient).toHaveBeenCalledTimes(5)
    // Ten release batches plus the final metadata transaction.
    expect(drizzleTransaction).toHaveBeenCalledTimes(11)
    expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(500)
  }, 30_000)

  it('keeps the failed row retryable and commits the rest of the batch', async () => {
    useManifestEntries(makeEntries(200))
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
    expect(deletedIds).toHaveLength(199)
  }, 30_000)

  it('keeps a row whose R2 move throws and still deletes the trashed rows', async () => {
    useManifestEntries(makeEntries(3))
    moveObjectToTrash.mockImplementation(async (_c: unknown, path: string) => {
      if (path.endsWith('file-1.js'))
        throw new Error('r2 unavailable')
      return true
    })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 3 }))).rejects.toThrow(
      'Cannot move S3 object for deleted manifest file to trash',
    )

    expect(callOrder).toContain('db_delete_row:1000')
    expect(callOrder).not.toContain('db_delete_row:1001')
    expect(callOrder).toContain('db_delete_row:1002')
  })
})

describe('on_version_update concurrent cleanup of versions sharing files', () => {
  interface StoredManifestRow {
    id: number
    app_version_id: number
    file_hash: string
    file_name: string
    s3_path: string
  }

  const defaultDrizzleClient = getDrizzleClient.getMockImplementation()!

  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    createStatsMeta.mockResolvedValue({ error: null })
    appVersionsMetaSelectEq.mockReturnValue({
      single: vi.fn(async () => ({ data: { size: 0 }, error: null })),
    })
    appVersionsMetaUpdateEq.mockResolvedValue({ error: null })
    restoreObjectFromTrash.mockResolvedValue(true)
  })

  afterEach(() => {
    getDrizzleClient.mockImplementation(defaultDrizzleClient)
  })

  it('trashes every object exactly once, before its last row, and leaves no rows', async () => {
    const store = new Map<number, StoredManifestRow>()
    const file = (i: number) => ({
      file_hash: `hash-${i}`,
      file_name: `file-${i}.js`,
      s3_path: `orgs/org-1/apps/com.cleanup.test/delta/file-${i}.js`,
    })
    // Files 0-119 are shared by both versions; each version also owns 30 files.
    for (let i = 0; i < 150; i++) {
      store.set(1000 + i, { id: 1000 + i, app_version_id: 1, ...file(i) })
      store.set(2000 + i, { id: 2000 + i, app_version_id: 2, ...file(i < 120 ? i : i + 1000) })
    }
    const yieldToOtherCleanup = () => new Promise(resolve => setTimeout(resolve, 0))

    // Mirrors the cleanup statements against the store.
    const leases = new Map<number, string>()
    const runSql = async (sql: string, params: any[] = []) => {
      await yieldToOtherCleanup()
      if (sql.includes('public.version_cleanup_leases')) {
        const [versionId, owner] = params as [number, string]
        if (sql.includes('INSERT INTO')) {
          if (leases.has(versionId))
            return { rows: [], rowCount: 0 }
          leases.set(versionId, owner)
          return { rows: [{ owner }], rowCount: 1 }
        }
        if (leases.get(versionId) === owner)
          leases.delete(versionId)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('WITH batch AS')) {
        const [ids, versionId] = params as [number[], number]
        const batch = ids.map(id => store.get(id)).filter((row): row is StoredManifestRow => row?.app_version_id === versionId)
        const releasable = batch.filter(row => row.s3_path === '' || [...store.values()].some(other =>
          other.file_hash === row.file_hash && other.file_name === row.file_name && other.app_version_id !== row.app_version_id))
        // The reference check reads a snapshot: the other cleanup can run
        // before this delete lands unless the advisory lock serializes them.
        await yieldToOtherCleanup()
        for (const row of releasable)
          store.delete(row.id)
        const rows = batch.filter(row => !releasable.includes(row))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('SELECT DISTINCT s3_path')) {
        const [, paths, ids] = params as [string[], string[], number[]]
        const rows = [...new Set([...store.values()].filter(row => paths.includes(row.s3_path) && !ids.includes(row.id)).map(row => row.s3_path))]
          .map(s3_path => ({ s3_path }))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('DELETE FROM public.manifest')) {
        const [ids, versionId] = params as [number[], number]
        for (const id of ids) {
          if (store.get(id)?.app_version_id === versionId)
            store.delete(id)
        }
        return { rows: [], rowCount: ids.length }
      }
      if (sql.includes('SELECT COUNT(*)'))
        return { rows: [{ count: [...store.values()].filter(row => row.app_version_id === params[0]).length }], rowCount: 1 }
      if (sql.includes('WITH prev AS'))
        return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }

    const dialect = new PgDialect()
    // The advisory lock statement blocks until the other batch transaction ends.
    let lockTail = Promise.resolve()
    getDrizzleClient.mockImplementation((() => ({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: async (condition: { queryChunks: { constructor: { name: string }, value?: unknown }[] }) => {
            const versionId = condition.queryChunks.find(chunk => chunk?.constructor?.name === 'Param')?.value
            return [...store.values()].filter(row => row.app_version_id === versionId).map(row => ({ ...row }))
          },
        })),
      })),
      execute: async (query: any) => {
        const { sql, params } = dialect.sqlToQuery(query)
        return runSql(sql, params)
      },
      transaction: async (operation: (tx: { execute: (query: any) => Promise<any> }) => Promise<unknown>) => {
        let unlock: (() => void) | undefined
        try {
          return await operation({
            execute: async (query: any) => {
              const { sql, params } = dialect.sqlToQuery(query)
              if (sql.includes('pg_advisory_xact_lock')) {
                const previous = lockTail
                lockTail = new Promise<void>((resolve) => {
                  unlock = resolve
                })
                await previous
                return { rows: [], rowCount: 0 }
              }
              return runSql(sql, params)
            },
          })
        }
        finally {
          unlock?.()
        }
      },
    })) as any)

    const trashCounts = new Map<string, number>()
    const trashedWithoutTracking: string[] = []
    moveObjectToTrash.mockImplementation(async (_c: unknown, path: string) => {
      if (![...store.values()].some(row => row.s3_path === path))
        trashedWithoutTracking.push(path)
      await yieldToOtherCleanup()
      trashCounts.set(path, (trashCounts.get(path) ?? 0) + 1)
      return true
    })

    const responses = await Promise.all([
      deleteIt(createContext(), createVersion({ id: 1, r2_path: null, manifest_count: 150 })),
      deleteIt(createContext(), createVersion({ id: 2, r2_path: null, manifest_count: 150 })),
    ])

    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(store.size).toBe(0)
    // 120 shared + 2 x 30 owned objects, each moved once and only while still tracked.
    expect(trashCounts.size).toBe(180)
    expect([...trashCounts.values()].every(count => count === 1)).toBe(true)
    expect(trashedWithoutTracking).toEqual([])
    expect(restoreObjectFromTrash).not.toHaveBeenCalled()
  }, 30_000)
})
