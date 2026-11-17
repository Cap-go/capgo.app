import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory app_versions for one app: id -> deleted, plus the ids a channel targets.
const db = vi.hoisted(() => ({
  versions: new Map<number, boolean>(),
  linked: new Set<number>(),
  transactions: [] as { statements: string[], lockedIds: number[], updatedIds: number[] }[],
  failUpdate: null as null | (() => Error | null),
  pageQueries: 0,
}))

function makeTx() {
  const tx = { statements: [] as string[], lockedIds: [] as number[], updatedIds: [] as number[] }
  db.transactions.push(tx)
  let pending: number[] = []
  return {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      tx.statements.push(text)
      if (text.includes('lock_channel_bundle_lifecycle')) {
        tx.lockedIds.push(...(params[0] as number[]))
        return { rows: [] }
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

const pool = {
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes('SELECT id FROM public.app_versions')) {
      db.pageQueries++
      const [, afterId, limit] = params as [string, number, number]
      const ids = [...db.versions.entries()]
        .filter(([id, deleted]) => !deleted && id > afterId)
        .map(([id]) => id)
        .sort((a, b) => a - b)
        .slice(0, limit)
      return { rows: ids.map(id => ({ id: String(id) })) }
    }
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
const { DELETE_ALL_PAGE_SIZE, deleteBundle } = await import('../supabase/functions/_backend/public/bundle/delete.ts')

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
    db.pageQueries = 0
  })

  it('soft-deletes every unlinked bundle in bounded, locked batches', async () => {
    const total = DELETE_ALL_PAGE_SIZE + 250
    seed(total, [7, DELETE_ALL_PAGE_SIZE + 3], [9])

    const response = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    // Same result as the old single UPDATE: everything but the channel-linked bundles is deleted.
    const remaining = [...db.versions.entries()].filter(([, deleted]) => !deleted).map(([id]) => id)
    expect(remaining).toEqual([7, DELETE_ALL_PAGE_SIZE + 3])

    // No single transaction touches more than one batch, and each locks before it updates.
    expect(db.transactions.length).toBe(Math.ceil((DELETE_ALL_PAGE_SIZE - 1) / BUNDLE_DELETE_BATCH_SIZE) + Math.ceil(251 / BUNDLE_DELETE_BATCH_SIZE))
    for (const tx of db.transactions) {
      expect(tx.lockedIds.length).toBeGreaterThan(0)
      expect(tx.lockedIds.length).toBeLessThanOrEqual(BUNDLE_DELETE_BATCH_SIZE)
      const lockIndex = tx.statements.findIndex(sql => sql.includes('lock_channel_bundle_lifecycle'))
      const updateIndex = tx.statements.findIndex(sql => sql.includes('UPDATE public.app_versions'))
      expect(lockIndex).toBeGreaterThan(-1)
      expect(lockIndex).toBeLessThan(updateIndex)
      expect(tx.statements.at(-1)).toBe('COMMIT')
    }
    // Keyset pages: the ids query never re-reads from the start.
    expect(db.pageQueries).toBe(2)
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
    expect(db.transactions.map(tx => tx.statements.at(-1))).toEqual(['ROLLBACK', 'COMMIT'])
  })

  it('keeps the cannot_delete_all_version error when a batch fails', async () => {
    seed(10)
    db.failUpdate = () => new Error('boom')

    await expect(deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any))
      .rejects
      .toMatchObject({ cause: expect.objectContaining({ error: 'cannot_delete_all_version' }) })
  })

  it('returns ok for an app without active bundles', async () => {
    seed(0)

    const response = await deleteBundle(createContext(), { app_id: APP_ID }, { key: 'key-1' } as any)

    expect(response.status).toBe(200)
    expect(db.transactions).toHaveLength(0)
  })
})
