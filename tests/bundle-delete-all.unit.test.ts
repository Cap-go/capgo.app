import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory app_versions for one app: id -> deleted, plus the ids a channel targets.
const db = vi.hoisted(() => ({
  versions: new Map<number, boolean>(),
  linked: new Set<number>(),
  transactions: [] as { statements: string[], lockedIds: number[], updatedIds: number[] }[],
  failUpdate: null as null | (() => Error | null),
}))

function makeTx() {
  const tx = { statements: [] as string[], lockedIds: [] as number[], updatedIds: [] as number[] }
  db.transactions.push(tx)
  let pending: number[] = []
  return {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      tx.statements.push(text)
      if (text.includes('lock_channel_bundle_lifecycle')) {
        // Candidates are selected inside the write transaction, then locked in id order.
        const [, afterId, limit] = params as [string, number, number]
        const ids = [...db.versions.entries()]
          .filter(([id, deleted]) => !deleted && id > afterId)
          .map(([id]) => id)
          .sort((a, b) => a - b)
          .slice(0, limit)
        tx.lockedIds.push(...ids)
        return { rows: ids.map(id => ({ id: String(id) })) }
      }
      if (text.includes('UPDATE public.app_versions')) {
        const error = db.failUpdate?.()
        if (error)
          throw error
        const ids = params[1] as number[]
        const ignoreChannel = params[2] as boolean
        pending = ids.filter(id => db.versions.get(id) === false && (ignoreChannel || !db.linked.has(id)))
        tx.updatedIds.push(...pending)
        return { rows: pending.map(id => ({ id: String(id) })) }
      }
      if (text === 'COMMIT') {
        for (const id of pending)
          db.versions.set(id, true)
        pending = []
      }
      if (text === 'ROLLBACK')
        pending = []
      return { rows: [] }
    }),
  }
}

// Any standalone read on the pool could be served stale by the query cache: none is allowed.
const pool = {
  query: vi.fn(async (text: string) => {
    throw new Error(`unexpected pool query: ${text}`)
  }),
}

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => pool),
  closeClient: vi.fn(async () => {}),
  checkoutPgClient: vi.fn(async () => makeTx()),
  releasePgClient: vi.fn(),
  beginWriteTransaction: async (client: { query: (text: string) => Promise<unknown> }) => {
    await client.query('BEGIN READ WRITE')
  },
  logPgError: vi.fn(),
}))

const withRlsContext = vi.fn()
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: vi.fn(() => ({ kind: 'apikey' })),
  setRequestApikeyHeader: vi.fn(async (client: { query: (text: string) => Promise<unknown> }) => {
    await client.query('SET request.headers')
  }),
  withRlsContext: (...args: unknown[]) => withRlsContext(...args),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: vi.fn(async () => true),
}))

const { BUNDLE_DELETE_BATCH_SIZE } = await import('../supabase/functions/_backend/utils/bundle_soft_delete.ts')
const { deleteBundle } = await import('../supabase/functions/_backend/public/bundle/delete.ts')

const APP_ID = 'com.example.deleteall'

function createContext() {
  return {
    get: vi.fn(() => undefined),
    json: (body: unknown) => Response.json(body),
    req: { header: vi.fn(() => undefined) },
  } as any
}

function seed(count: number, linked: number[] = [], alreadyDeleted: number[] = []) {
  db.versions = new Map(Array.from({ length: count }, (_, i) => [i + 1, false]))
  for (const id of alreadyDeleted)
    db.versions.set(id, true)
  db.linked = new Set(linked)
}

describe('DELETE /bundle without a version', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.transactions = []
    db.failUpdate = null
  })

  it('soft-deletes every unlinked bundle in bounded, locked batches', async () => {
    seed(1_250, [7, 1_003], [9])

    const response = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    // Same result as the old single UPDATE: everything but the channel-linked bundles is deleted.
    const remaining = [...db.versions.entries()].filter(([, deleted]) => !deleted).map(([id]) => id)
    expect(remaining).toEqual([7, 1_003])

    // 1,249 active bundles: 7 full batches, then one empty transaction that ends the scan.
    const batches = db.transactions.filter(tx => tx.lockedIds.length > 0)
    expect(batches).toHaveLength(Math.ceil(1_249 / BUNDLE_DELETE_BATCH_SIZE))
    expect(db.transactions).toHaveLength(batches.length + 1)
    for (const tx of batches) {
      expect(tx.lockedIds.length).toBeLessThanOrEqual(BUNDLE_DELETE_BATCH_SIZE)
      const lockIndex = tx.statements.findIndex(sql => sql.includes('lock_channel_bundle_lifecycle'))
      const updateIndex = tx.statements.findIndex(sql => sql.includes('UPDATE public.app_versions'))
      expect(lockIndex).toBeGreaterThan(-1)
      expect(lockIndex).toBeLessThan(updateIndex)
      expect(tx.statements.at(-1)).toBe('COMMIT')
    }
    // Keyset scan: every candidate is locked once, linked ones included, never re-read.
    const locked = batches.flatMap(tx => tx.lockedIds)
    expect(new Set(locked).size).toBe(locked.length)
    expect(locked).toContain(7)
    expect(pool.query).not.toHaveBeenCalled()
    expect(withRlsContext).not.toHaveBeenCalled()
  })

  it('retries a batch that lost a deadlock', async () => {
    seed(10)
    let first = true
    db.failUpdate = () => {
      if (!first)
        return null
      first = false
      return Object.assign(new Error('deadlock detected'), { code: '40P01' })
    }

    const response = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any)

    expect(response.status).toBe(200)
    expect([...db.versions.values()].every(Boolean)).toBe(true)
    expect(db.transactions.map(tx => tx.statements.at(-1))).toEqual(['ROLLBACK', 'COMMIT', 'COMMIT'])
  })

  it('keeps the cannot_delete_all_version error when a batch fails', async () => {
    seed(10)
    db.failUpdate = () => new Error('boom')

    await expect(deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any))
      .rejects
      .toMatchObject({ cause: expect.objectContaining({ error: 'cannot_delete_all_version' }) })
  })

  it('keeps earlier committed batches and reports them when a later batch fails', async () => {
    seed(BUNDLE_DELETE_BATCH_SIZE + 50)
    let updates = 0
    db.failUpdate = () => (++updates === 2 ? new Error('boom') : null)

    const error = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any).catch(e => e)

    expect(error).toMatchObject({ cause: expect.objectContaining({ error: 'cannot_delete_all_version', moreInfo: expect.objectContaining({ deleted: BUNDLE_DELETE_BATCH_SIZE }) }) })
    const deleted = [...db.versions.entries()].filter(([, isDeleted]) => isDeleted).map(([id]) => id)
    expect(deleted).toEqual(Array.from({ length: BUNDLE_DELETE_BATCH_SIZE }, (_, i) => i + 1))
    expect(db.transactions.map(tx => tx.statements.at(-1))).toEqual(['COMMIT', 'ROLLBACK'])
  })

  it('returns ok for an app without active bundles', async () => {
    seed(0)

    const response = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any)

    expect(response.status).toBe(200)
    expect(db.transactions).toHaveLength(1)
    expect(db.transactions[0].updatedIds).toEqual([])
  })
})
