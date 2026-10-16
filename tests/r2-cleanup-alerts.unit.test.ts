import type { ClientBase } from 'pg'
import type { AlertCounts, CleanupDatabase } from '../cloudflare_workers/r2_inventory/cleanup_alerts.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupAlertContent, sendCleanupAlert } from '../cloudflare_workers/r2_inventory/cleanup_alerts.ts'

const secret = 'https://discord.com/api/webhooks/123456789/synthetic-token'
function database(allowed = true) {
  let claimed = false
  const query = vi.fn(async (statement: string | { text: string }) => {
    const text = typeof statement === 'string' ? statement : statement.text
    if (text.startsWith('SELECT checkpoint,'))
      return { rows: [{ checkpoint: {}, allowed: allowed && !claimed }] }
    if (text.includes('\'schemaVersion\',1,\'token\''))
      claimed = true
    return { rows: [] }
  })
  const run: CleanupDatabase = async work => work({ query } as unknown as ClientBase)
  return { query, run }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cleanup Discord aggregation', () => {
  it('limits counts/length and ignores unknown or private fields', () => {
    const counts = { storage: Number.POSITIVE_INFINITY, referenced: 3, completion: 1, leased: -4, private: 'synthetic-object-key/receipt/secret@example.com' } as AlertCounts
    const content = cleanupAlertContent(counts)
    expect(content.length).toBeLessThanOrEqual(1800)
    expect(content).toContain('storage workflows failed (1000000)')
    expect(content).toContain('referenced objects skipped (3)')
    expect(content).not.toContain('private')
    expect(content).not.toContain('synthetic-object-key')
    expect(content).not.toContain('secret@example.com')
  })

  it('commits a durable claim before a single concise, mention-disabled send', async () => {
    const db = database()
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(db.query.mock.calls.some(([sql]) => sql === 'commit')).toBe(true)
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({ content: 'R2 cleanup encountered a problem: referenced objects skipped (3), database completion updates failed (1)', allowed_mentions: { parse: [] } })
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetcher)
    await sendCleanupAlert(db.run, 'capgo', secret, { referenced: 3, completion: 1 })
    await sendCleanupAlert(db.run, 'capgo', secret, { storage: 1 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('skips sending without a secret or durable claim, or with unsafe configuration', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const db = database(false)
    await sendCleanupAlert(db.run, 'capgo', undefined, { storage: 1 })
    expect(db.query).not.toHaveBeenCalled()
    await sendCleanupAlert(db.run, 'capgo', 'https://example.com/untrusted', { storage: 1 })
    expect(db.query).not.toHaveBeenCalled()
    await sendCleanupAlert(db.run, 'capgo', secret, { storage: 1 })
    const unavailable: CleanupDatabase = async () => {
      throw new Error('Synthetic DB unavailable')
    }
    await sendCleanupAlert(unavailable, 'capgo', secret, { storage: 1 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'ambiguous', 'server-error', 'rate-limit'])('never retries cleanup or immediately resends after %s', async (failure) => {
    const db = database()
    const fetcher = vi.fn(async () => {
      if (failure === 'timeout' || failure === 'ambiguous')
        throw new Error('Synthetic private transport detail')
      return new Response(null, { status: failure === 'rate-limit' ? 429 : 500, headers: { 'Retry-After': '1200' } })
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetcher)
    await expect(sendCleanupAlert(db.run, 'capgo', secret, { storage: 2 })).resolves.toBeUndefined()
    await sendCleanupAlert(db.run, 'capgo', secret, { storage: 2 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private transport detail')
    if (failure === 'rate-limit')
      expect(db.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('greatest('))).toBe(true)
  })
})
