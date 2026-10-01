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
  persistVersionManifestEntries,
  purgeFileReadCache,
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
    getPgClient: vi.fn(() => ({
      query: pgQuery,
      connect: vi.fn(async () => ({ query: pgQuery, release: vi.fn() })),
    })),
    manifestSelectWhere,
    moveObjectToTrash,
    pgQuery,
    persistVersionManifestEntries: vi.fn(),
    purgeFileReadCache: vi.fn(async () => {}),
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
function mockCleanupPg(options: { sharedIds?: Set<number>, remainingCount?: number } = {}) {
  const sharedIds = options.sharedIds ?? new Set<number>()
  pgQuery.mockImplementation(async (sql: string, params?: any[]) => {
    if (sql === 'BEGIN')
      callOrder.push('begin')
    if (sql.includes('pg_advisory_xact_lock'))
      callOrder.push('lock')
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
    if (sql.includes('DELETE FROM public.manifest WHERE id = ANY')) {
      for (const id of params?.[0] as number[])
        callOrder.push(`db_delete_row:${id}`)
      return { rows: [], rowCount: (params?.[0] as number[]).length }
    }
    if (sql === 'COMMIT')
      callOrder.push('commit')
    if (sql === 'ROLLBACK')
      callOrder.push('rollback')
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
    expect(callOrder.indexOf('commit')).toBeGreaterThan(callOrder.indexOf('lock'))
    expect(callOrder.indexOf('r2_trash')).toBeGreaterThan(callOrder.indexOf('commit'))
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
  })

  it('throws when rows remain after the trash/delete pass', async () => {
    useManifestEntries(makeEntries(1))
    mockCleanupPg({ remainingCount: 2 })

    await expect(deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 1 }))).rejects.toThrow(
      'Manifest rows still present after trash/delete pass',
    )
    expect(callOrder).toContain('rollback')
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

  it('takes one batched lock per 200 files instead of one lock transaction per file', async () => {
    useManifestEntries(makeEntries(5000))
    // Most files of a bundle are shared with the previous version.
    mockCleanupPg({ sharedIds: new Set(makeEntries(5000).filter((_, i) => i % 10 !== 0).map(entry => entry.id)) })

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 5000 }))

    expect(response.status).toBe(200)
    expect(callOrder.filter(v => v === 'lock')).toHaveLength(25)
    expect(moveObjectToTrash).toHaveBeenCalledTimes(500)
    expect(callOrder.filter(v => v.startsWith('db_release_row:'))).toHaveLength(4500)
    expect(callOrder.filter(v => v.startsWith('db_delete_row:'))).toHaveLength(500)
  }, 60_000)

  it('reuses one pg pool and releases every checked-out client', async () => {
    useManifestEntries(makeEntries(500))
    getPgClient.mockClear()

    const response = await deleteIt(createContext(), createVersion({ r2_path: null, manifest_count: 500 }))

    expect(response.status).toBe(200)
    // read + cleanup + final write, not one pool per manifest file
    expect(getPgClient.mock.calls.length).toBeLessThanOrEqual(3)
    const pools = getPgClient.mock.results.map(result => result.value as { query: ReturnType<typeof vi.fn>, connect: ReturnType<typeof vi.fn> })
    const checkouts = pools.reduce((total, pool) => total + pool.connect.mock.calls.length, 0)
    // One checked-out client per 200-file batch.
    expect(checkouts).toBe(3)
    // A leaked client would exhaust the bounded pool and stall cleanup.
    const clients = await Promise.all(pools.flatMap(pool => pool.connect.mock.results.map(result => result.value as Promise<{ release: ReturnType<typeof vi.fn> }>)))
    for (const client of clients)
      expect(client.release).toHaveBeenCalledTimes(1)
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
})
