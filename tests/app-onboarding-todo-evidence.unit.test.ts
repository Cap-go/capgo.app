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
    if (query.includes('jsonb_to_recordset')) {
      const pairs = JSON.parse(compiled.params.find(param => typeof param === 'string' && param.startsWith('[{')) as string) as Array<{ app_id: string, version_name: string }>
      return { rows: [...new Set(pairs.filter(pair => rows.some(row => row.app_id === pair.app_id && row.version_name === pair.version_name)).map(pair => pair.app_id))].map(app_id => ({ app_id })) }
    }
    if (query.includes('FROM public.app_versions'))
      return { rows: rows.filter(row => row.version_name !== undefined) }
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

  it('groups at most five app IDs per query and caps ordinary 25-app work at ten requests', async () => {
    const database = databaseWithRows(Array.from({ length: 25 }, (_, i) => ({ app_id: `app-${i}`, version_name: '1.0.0', published: false })))
    const queries: string[] = []
    const runQuery = vi.fn(async (query: string) => {
      queries.push(query)
      return []
    })
    const candidates = Array.from({ length: 25 }, (_, i) => candidate(`app-${i}`, setup(3)))
    await gatherTodoEvidence(c, database as any, candidates, { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(queries).toHaveLength(10)
    expect(queries.filter(query => query.includes('FROM device_info'))).toHaveLength(5)
    expect(queries.filter(query => query.includes('FROM app_log'))).toHaveLength(5)
    for (const query of queries)
      expect((query.match(/'app-\d+'/g) ?? []).length).toBeLessThanOrEqual(5)
    expect(queries.filter(query => query.includes('FROM app_log')).every(query => query.includes('LIMIT 50'))).toBe(true)
  })

  it('runs no more than four Analytics Engine queries at once', async () => {
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
    expect(peak).toBe(4)
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

  it('matches a set event only to a valid version after app creation', async () => {
    const database = databaseWithRows([{ app_id: 'app-a', version_name: '1.0.0', published: false }])
    const runQuery = vi.fn(async (query: string) => query.includes('FROM app_log')
      ? [
          { app_id: 'app-a', version_name: 'missing', last_set_at: new Date('2026-09-20T00:00:00Z') },
          { app_id: 'app-a', version_name: '1.0.0', last_set_at: new Date('2026-08-20T00:00:00Z') },
        ]
      : [{ app_id: 'app-a', last_device_at: new Date('2026-09-20T00:00:00Z') }])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.device.has('app-a')).toBe(true)
    expect(found.update.has('app-a')).toBe(false)
  })

  it('verifies a returned set version through the indexed Postgres lookup', async () => {
    const database = databaseWithRows([{ app_id: 'app-a', version_name: 'real-version', published: false }])
    const runQuery = vi.fn(async (query: string) => query.includes('FROM app_log')
      ? [{ app_id: 'app-a', version_name: 'real-version', last_set_at: new Date('2026-09-20T00:00:00Z') }]
      : [])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.update.has('app-a')).toBe(true)
    const queries = database.execute.mock.calls.map(call => dialect.sqlToQuery(call[0] as any).sql)
    expect(queries.filter(query => query.includes('jsonb_to_recordset'))).toHaveLength(1)
    expect(queries.some(query => query.includes('name AS version_name'))).toBe(false)
  })

  it('does not use a device observation from before this app row was created', async () => {
    const database = databaseWithRows([])
    const onboarding = setup(3, { test_update: { status: 'done' } })
    const runQuery = vi.fn(async () => [{ app_id: 'app-a', last_device_at: new Date('2026-08-20T00:00:00Z') }])
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', onboarding)], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.device.has('app-a')).toBe(false)
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

  it('uses at most five exact version lookups when a 50-row set group is saturated', async () => {
    const database = databaseWithRows(Array.from({ length: 25 }, (_, i) => ({ app_id: `app-${i}`, version_name: 'real-version', published: false })))
    const queries: string[] = []
    const runQuery = vi.fn(async (query: string) => {
      queries.push(query)
      if (!query.includes('FROM app_log'))
        return []
      if (query.includes('index1 IN')) {
        const firstId = /'app-(\d+)'/.exec(query)?.[1]
        return Array.from({ length: 50 }, (_, i) => ({ app_id: `app-${firstId}`, version_name: `unmatched-${i}`, last_set_at: new Date('2026-09-20T00:00:00Z') }))
      }
      return [{ version_name: 'real-version', last_set_at: new Date('2026-09-20T00:00:00Z') }]
    })
    const candidates = Array.from({ length: 25 }, (_, i) => candidate(`app-${i}`, setup(3)))
    const found = await gatherTodoEvidence(c, database as any, candidates, { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(queries).toHaveLength(15)
    expect(queries.filter(query => query.includes('FROM app_log') && query.includes('index1 ='))).toHaveLength(5)
    expect(found.update.size).toBe(5)
    expect(found.truncated).toHaveLength(20)
    expect(found.truncated.every(appId => !found.update.has(appId))).toBe(true)
  })

  it('does not infer a match from a saturated grouped result if the exact query fails', async () => {
    const database = databaseWithRows([{ app_id: 'app-a', version_name: 'real-version', published: false }])
    const runQuery = vi.fn(async (query: string) => {
      if (query.includes('FROM device_info'))
        return []
      if (query.includes('index1 IN'))
        return Array.from({ length: 50 }, (_, i) => ({ app_id: 'app-a', version_name: `unmatched-${i}`, last_set_at: new Date('2026-09-20T00:00:00Z') }))
      throw new Error('exact lookup failed')
    })
    const found = await gatherTodoEvidence(c, database as any, [candidate('app-a', setup(3))], { runQuery, now: new Date('2026-09-22T00:00:00Z') })
    expect(found.update.has('app-a')).toBe(false)
    expect(found.errors).toEqual([expect.objectContaining({ source: 'update', appIds: ['app-a'], message: 'exact lookup failed' })])
  })
})
