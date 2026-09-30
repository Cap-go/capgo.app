import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDeviceUsageCF } from '../supabase/functions/_backend/utils/cloudflare.ts'

function createContext() {
  return {
    env: {
      CF_ANALYTICS_TOKEN: 'cf-analytics-token',
      CF_ACCOUNT_ANALYTICS_ID: 'cf-account-id',
      DEVICE_USAGE: {},
    },
    get: (key: string) => key === 'requestId' ? 'device-usage-test' : undefined,
  } as unknown as Context
}

describe('readDeviceUsageCF', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('aggregates daily MAU inside Analytics Engine instead of returning one row per device', async () => {
    const queries: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      queries.push(String(init?.body))
      return new Response(JSON.stringify({
        meta: [
          { name: 'date', type: 'String' },
          { name: 'app_id', type: 'String' },
          { name: 'org_id', type: 'String' },
          { name: 'mau', type: 'UInt64' },
        ],
        data: [
          { date: '2026-09-01', app_id: 'com.example.app', org_id: 'org-new', mau: '600000' },
          { date: '2026-09-01', app_id: 'com.example.app', org_id: 'org-old', mau: '5' },
          { date: '2026-09-02', app_id: 'com.example.app', org_id: 'org-new', mau: '328104' },
        ],
        rows: 3,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const usage = await readDeviceUsageCF(createContext(), 'com.example.app', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', { throwOnError: true })

    expect(queries).toHaveLength(1)
    // Device ids stay inside the inner GROUP BY; the result is one row per day/org.
    expect(queries[0]).toMatch(/count\(\) AS mau/)
    expect(queries[0]).toMatch(/GROUP BY date, app_id, org_id/)
    expect(queries[0]!.split('\n')[1]!.trim()).toBe('date,')
    expect(usage).toEqual([
      { date: '2026-09-01', app_id: 'com.example.app', org_id: 'org-new', mau: 600005 },
      { date: '2026-09-02', app_id: 'com.example.app', org_id: 'org-new', mau: 328104 },
    ])
  })
})
