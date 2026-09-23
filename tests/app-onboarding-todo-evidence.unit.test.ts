import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { buildTodoDeviceQuery, buildTodoSetQuery, gatherTodoEvidence, getTodoEvidenceNeeds, loadTodoEvidenceCandidates } from '../supabase/functions/_backend/utils/app_onboarding_todo_evidence.ts'

const dialect = new PgDialect()

function candidate(appId: string, onboarding: unknown, createdAt = '2026-09-01T00:00:00.000Z') {
  return { appId, onboarding, createdAt, ownerOrg: 'org-1' }
}

function setup(version: number, steps: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    setup: {
      todo_list_version: version,
      ...(version === 4 ? { ota_todo_list_version: '1' } : {}),
      steps: version === 4 ? { ota: steps } : steps,
      ...extra,
    },
  }
}

function databaseWithRows(rows: Array<{ app_id: string, version_name?: string, published?: boolean }>) {
  const execute = vi.fn(async (statement: any) => {
    const compiled = dialect.sqlToQuery(statement)
    const query = compiled.sql
    if (query.includes('FROM public.channels'))
      return { rows: rows.filter(row => row.version_name === undefined) }
    if (query.includes('FROM pg_catalog.unnest'))
      return { rows: [...new Set(rows.filter(row => row.published).map(row => row.app_id))].map(app_id => ({ app_id })) }
    return { rows: [] }
  })
  return { execute }
}

describe('pending todo evidence selection', () => {
  it('checks only the channel for v1 and v2, and all pending evidence steps for v3 and v4 OTA', () => {
    for (const version of [1, 2])
      expect(getTodoEvidenceNeeds(setup(version))).toEqual({ channel: true, device: false, bundle: false, update: false })
    for (const version of [3, 4])
      expect(getTodoEvidenceNeeds(setup(version))).toEqual({ channel: true, device: true, bundle: true, update: true })
  })

  it('omits completed steps and skipped setups', () => {
    const done = { status: 'done', at: '2026-09-01T00:00:00.000Z' }
    expect(getTodoEvidenceNeeds(setup(4, { add_channel: done, run_device: done, upload_bundle: done, test_update: done })))
      .toEqual({ channel: false, device: false, bundle: false, update: false })
    expect(getTodoEvidenceNeeds(setup(3, {}, { outcome: 'skipped' })))
      .toEqual({ channel: false, device: false, bundle: false, update: false })
    // CLI/AI can complete setup without reporting every checklist step. An
    // evidence patch must never derive that terminal outcome back to progress.
    for (const version of [1, 2, 3, 4]) {
      expect(getTodoEvidenceNeeds(setup(version, {}, { outcome: 'completed' })))
        .toEqual({ channel: false, device: false, bundle: false, update: false })
    }
    expect(getTodoEvidenceNeeds({ setup: { todo_list_version: 4, ota_todo_list_version: '2' } }))
      .toEqual({ channel: false, device: false, bundle: false, update: false })
  })
})

describe('batched todo evidence lookup', () => {
  const c = { get: () => 'request-id' } as any

  it('loads candidate app rows in one indexed lookup', async () => {
    const execute = vi.fn(async (_statement: any) => ({ rows: [{ app_id: 'app-a', created_at: new Date('2026-09-01T00:00:00Z'), onboarding: setup(3), owner_org: 'org-1' }] }))
    const loaded = await loadTodoEvidenceCandidates({ execute } as any, ['app-a'])
    expect(loaded).toEqual([candidate('app-a', setup(3))])
    expect(execute).toHaveBeenCalledTimes(1)
    const compiled = dialect.sqlToQuery(execute.mock.calls[0][0] as any)
    expect(compiled.sql).toContain('FROM public.apps')
    expect(compiled.sql).toContain('app_id = ANY(')
  })

  it('makes no Cloudflare request if only channels and bundles are pending', async () => {
    const database = databaseWithRows([
      { app_id: 'app-a' },
      { app_id: 'app-a', version_name: '1.0.0', published: true },
    ])
    const runQuery = vi.fn(async () => [])
    const onboarding = setup(3, { run_device: { status: 'done' }, test_update: { status: 'done' } })
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', onboarding)], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(runQuery).not.toHaveBeenCalled()
    expect(found.channel.has('app-a')).toBe(true)
    expect(found.bundle.has('app-a')).toBe(true)
    expect(found.device.size).toBe(0)
    expect(found.update.size).toBe(0)
  })

  it('checks all 25 apps with one device query and one set query', async () => {
    const database = databaseWithRows(Array.from({ length: 25 }, (_, i) => ({ app_id: `app-${i}`, version_name: '1.0.0', published: false })))
    const queries: string[] = []
    const runQuery = vi.fn(async (query: string) => {
      queries.push(query)
      return []
    })
    const candidates = Array.from({ length: 25 }, (_, i) => candidate(`app-${i}`, setup(3)))
    await gatherTodoEvidence(c, database as any, candidates, { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(queries).toHaveLength(2)
    expect(queries.filter(query => query.includes('FROM device_info'))).toHaveLength(1)
    expect(queries.filter(query => query.includes('FROM app_log'))).toHaveLength(1)
    for (const query of queries) {
      expect((query.match(/'app-\d+'/g) ?? []).length).toBe(25)
      expect(query).toContain('GROUP BY index1 LIMIT 25')
    }
    expect(queries.find(query => query.includes('FROM app_log'))).not.toContain('blob3 AS version_name')
  })

  it('runs the two batched Analytics Engine queries concurrently', async () => {
    const database = databaseWithRows([])
    let active = 0
    let peak = 0
    const runQuery = vi.fn(async (_query: string, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return []
    })
    const candidates = Array.from({ length: 25 }, (_, i) => candidate(`app-${i}`, setup(3)))
    await gatherTodoEvidence(c, database as any, candidates, { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(peak).toBe(2)
  })

  it('escapes app IDs and bounds device and set scans by Analytics Engine retention', () => {
    const app = candidate('com.example.o\'brien', setup(3), '2026-08-01T00:00:00Z')
    const deviceQuery = buildTodoDeviceQuery([app], Date.parse('2026-06-24T00:00:00Z'))
    const setQuery = buildTodoSetQuery([app], Date.parse('2026-06-24T00:00:00Z'))
    expect(deviceQuery).toContain('com.example.o\'\'brien')
    expect(setQuery).toContain('com.example.o\'\'brien')
    expect(deviceQuery).toContain('timestamp >= toDateTime(\'2026-08-01 00:00:00\')')
    expect(setQuery).toContain('timestamp >= toDateTime(\'2026-08-01 00:00:00\')')
    expect(buildTodoSetQuery([candidate('old-app', setup(3), '2025-01-01T00:00:00Z')], Date.parse('2026-06-24T00:00:00Z')))
      .toContain('timestamp >= toDateTime(\'2026-06-24 00:00:00\')')
  })

  it('accepts a qualifying set event even when its version no longer exists in Postgres', async () => {
    const database = databaseWithRows([])
    const runQuery = vi.fn(async (query: string) => query.includes('FROM app_log')
      ? [{ app_id: 'app-a', last_event_at: new Date('2026-09-20T00:00:00Z') }]
      : [{ app_id: 'app-a', last_event_at: new Date('2026-09-20T00:00:00Z') }])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.device.has('app-a')).toBe(true)
    expect(found.update.has('app-a')).toBe(true)
  })

  it('does not issue a Postgres version-name lookup for set evidence', async () => {
    const database = databaseWithRows([])
    const runQuery = vi.fn(async (query: string) => query.includes('FROM app_log')
      ? [{ app_id: 'app-a', last_event_at: new Date('2026-09-20T00:00:00Z') }]
      : [])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.update.has('app-a')).toBe(true)
    const queries = database.execute.mock.calls.map(call => dialect.sqlToQuery(call[0] as any).sql)
    expect(queries.some(query => query.includes('jsonb_to_recordset'))).toBe(false)
    expect(queries.some(query => query.includes('name AS version_name'))).toBe(false)
  })

  it('does not use Analytics Engine observations from before this app row was created', async () => {
    const database = databaseWithRows([])
    const runQuery = vi.fn(async () => [{ app_id: 'app-a', last_event_at: new Date('2026-08-20T00:00:00Z') }])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.device.has('app-a')).toBe(false)
    expect(found.update.has('app-a')).toBe(false)
  })

  it('reports Cloudflare failures separately from absent evidence', async () => {
    const database = databaseWithRows([])
    const runQuery = vi.fn(async () => {
      throw new Error('Cloudflare unavailable')
    })
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.device.size).toBe(0)
    expect(found.update.size).toBe(0)
    expect(found.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'device', appIds: ['app-a'] }),
      expect.objectContaining({ source: 'update', appIds: ['app-a'] }),
    ]))
  })

})
