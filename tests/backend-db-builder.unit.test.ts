import type { ConsoleQueryRequest, ConsoleQueryResult, QueryCatalog, QueryColumn, QueryFunction } from '../supabase/functions/_backend/private/console_query_sql'
import { describe, expect, it } from 'vitest'
import { compileConsoleQuery } from '../supabase/functions/_backend/private/console_query_sql'
import { createDbClient, DbQueryError } from '../supabase/functions/_backend/utils/db'
import { freshReadSql } from '../supabase/functions/_backend/utils/pg_query'
import { parsePostgrestRequest, postgrestResponse } from '../supabase/functions/_backend/utils/postgrest_http'

function column(name: string, udt: string): QueryColumn {
  return { name, udt }
}

const metrics: QueryFunction = {
  name: 'get_app_metrics',
  argNames: ['org_id', 'start_date', 'end_date'],
  argTypes: ['uuid', 'date', 'date'],
  returnsSet: true,
  returnsComposite: true,
  defaultCount: 0,
  outColumns: [column('app_id', 'varchar'), column('date', 'date'), column('mau', 'int8')],
}

const catalog: QueryCatalog = {
  columns: new Map([
    ['daily_mau', [column('app_id', 'varchar'), column('date', 'date'), column('mau', 'int8')]],
    ['app_versions', [column('id', 'int8'), column('name', 'text'), column('app_id', 'text'), column('manifest', '_manifest_entry')]],
  ]),
  foreignKeys: [],
  primaryKeys: new Map([['daily_mau', ['app_id', 'date']]]),
  functions: [metrics, { name: 'get_user_id', argNames: ['apikey'], argTypes: ['text'], returnsSet: false, returnsComposite: false, defaultCount: 0 }],
}

function flat(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function table(name: string, operations: ConsoleQueryRequest['operations']): ConsoleQueryRequest {
  return { kind: 'table', name, args: [], operations }
}

describe('backend builder → SQL parity with PostgREST', () => {
  it('fills a key missing from some rows with NULL, or the column default when asked', () => {
    const rows = [{ app_id: 'a', date: '2026-01-01', mau: 1 }, { app_id: 'b', date: '2026-01-01' }]
    const nulls = compileConsoleQuery(catalog, table('daily_mau', [{ method: 'insert', args: [rows] }]))
    expect(flat(nulls.text)).toContain('VALUES ($1::varchar, $2::date, $3::bigint), ($4::varchar, $5::date, NULL)')
    const defaults = compileConsoleQuery(catalog, table('daily_mau', [{ method: 'insert', args: [rows, { defaultToNull: false }] }]))
    expect(flat(defaults.text)).toContain('($4::varchar, $5::date, DEFAULT)')
  })

  it('upserts on the primary key when onConflict is omitted', () => {
    const compiled = compileConsoleQuery(catalog, table('daily_mau', [{ method: 'upsert', args: [{ app_id: 'a', date: '2026-01-01', mau: 2 }] }]))
    expect(flat(compiled.text)).toContain('ON CONFLICT ("app_id", "date") DO UPDATE SET "mau" = EXCLUDED."mau"')
  })

  it('refuses an UPDATE or DELETE without a filter, like pg-safeupdate behind PostgREST', () => {
    expect(() => compileConsoleQuery(catalog, table('daily_mau', [{ method: 'delete', args: [] }]))).toThrow('DELETE requires a WHERE clause')
    expect(() => compileConsoleQuery(catalog, table('daily_mau', [{ method: 'update', args: [{ mau: 0 }] }]))).toThrow('UPDATE requires a WHERE clause')
    expect(() => compileConsoleQuery(catalog, table('daily_mau', [{ method: 'delete', args: [] }, { method: 'eq', args: ['app_id', 'a'] }]))).not.toThrow()
  })

  it('treats an empty batch as a write of nothing', () => {
    const compiled = compileConsoleQuery(catalog, table('daily_mau', [{ method: 'upsert', args: [[]] }]))
    expect(compiled.values).toEqual([])
    expect(compiled.text).toContain('WHERE false')
  })

  it('builds composite columns with jsonb_populate_record on the table type', () => {
    const compiled = compileConsoleQuery(catalog, table('app_versions', [
      { method: 'update', args: [{ manifest: [{ file_name: 'a.js', s3_path: 'x', file_hash: 'h' }] }] },
      { method: 'eq', args: ['id', 1] },
    ]))
    expect(flat(compiled.text)).toContain('"manifest" = (pg_catalog.jsonb_populate_record(NULL::"public"."app_versions", pg_catalog.jsonb_build_object(\'manifest\', $2::jsonb)))."manifest" WHERE t."id" = $1::bigint')
    expect(compiled.values[1]).toBe(JSON.stringify([{ file_name: 'a.js', s3_path: 'x', file_hash: 'h' }]))
  })

  it('orders, filters and pages the rows of a set-returning RPC', () => {
    const compiled = compileConsoleQuery(catalog, {
      kind: 'rpc',
      name: 'get_app_metrics',
      args: [{ org_id: '00000000-0000-0000-0000-000000000000', start_date: '2026-01-01', end_date: '2026-01-31' }],
      operations: [
        { method: 'eq', args: ['app_id', 'com.demo'] },
        { method: 'order', args: ['app_id', { ascending: true }] },
        { method: 'order', args: ['date', { ascending: false }] },
        { method: 'range', args: [1000, 1999] },
      ],
    })
    expect(flat(compiled.text)).toContain('AS q WHERE q."app_id" = $4::varchar ORDER BY q."app_id" ASC, q."date" DESC LIMIT 1000 OFFSET 1000')
    expect(() => compileConsoleQuery(catalog, { kind: 'rpc', name: 'get_user_id', args: [{ apikey: 'x' }], operations: [{ method: 'order', args: ['x'] }] })).toThrow('Unsupported RPC modifier')
  })

  it('reads fresh past the Hyperdrive cache', () => {
    expect(freshReadSql('SELECT 1')).toBe('WITH capgo_fresh_read AS (SELECT now()) SELECT 1')
    expect(freshReadSql('WITH written AS (UPDATE t SET a = 1) SELECT 1')).toBe('WITH capgo_fresh_read AS (SELECT now()), written AS (UPDATE t SET a = 1) SELECT 1')
    expect(freshReadSql('DELETE FROM t WHERE a = 1')).toBe('DELETE FROM t WHERE a = 1')
  })
})

describe('backend builder client', () => {
  function client(result: Partial<ConsoleQueryResult> = {}) {
    const requests: ConsoleQueryRequest[] = []
    const db = createDbClient(async (request) => {
      requests.push(request)
      return { data: null, error: null, count: null, status: 200, ...result }
    })
    return { db, requests }
  }

  it('sends what supabase-js would put on the wire, on every await', async () => {
    const { db, requests } = client({ data: [] })
    const date = new Date('2026-01-02T03:04:05.000Z')
    const query = (db.from as any)('daily_mau').insert({ app_id: 'a', mau: undefined, date }).select()
    expect(requests).toHaveLength(0)
    await query
    // A retry re-awaits the same builder; supabase-js sends the request again.
    await query
    expect(requests).toHaveLength(2)
    // Reading `then` (promise detection) sends nothing.
    expect(typeof query.then).toBe('function')
    expect(requests).toHaveLength(2)
    expect(requests[0].operations[0]).toEqual({ method: 'insert', args: [{ app_id: 'a', date: '2026-01-02T03:04:05.000Z' }] })
    expect(String((db.from as any)('x')[Symbol.toStringTag])).toBe('undefined')
  })

  it('answers writes with PostgREST status codes', async () => {
    const inserted = await (client().db.from as any)('daily_mau').insert({ app_id: 'a' })
    expect(inserted.status).toBe(201)
    expect(inserted.statusText).toBe('Created')
    const updated = await (client().db.from as any)('daily_mau').update({ mau: 1 }).eq('app_id', 'a')
    expect(updated.status).toBe(204)
  })

  it('returns errors as PostgrestError and throws them with throwOnError()', async () => {
    const failing = client({ error: { message: 'duplicate key', code: '23505', details: 'Key exists', hint: null }, status: 409 })
    const { error } = await (failing.db.from as any)('daily_mau').insert({ app_id: 'a' })
    expect(error).toBeInstanceOf(DbQueryError)
    expect(error).toMatchObject({ name: 'PostgrestError', code: '23505', details: 'Key exists', message: 'duplicate key' })
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'PostgrestError', message: 'duplicate key', details: 'Key exists', hint: null, code: '23505' })
    await expect((failing.db.from as any)('daily_mau').insert({ app_id: 'a' }).throwOnError()).rejects.toBeInstanceOf(DbQueryError)
  })
})

describe('PostgREST HTTP requests (released CLIs)', () => {
  function parse(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    return parsePostgrestRequest({
      method,
      url: new URL(`https://api.example.com/private/legacy_supabase/rest/v1/${path}`),
      header: name => headers[name.toLowerCase()],
      body: body === undefined ? null : JSON.stringify(body),
    })
  }

  it('reads select, filters, or, order and paging from the query string', () => {
    const parsed = parse('GET', 'channels?select=id,name&app_id=eq.com.demo&name=not.in.(a,b)&or=(version.eq.1,rollout_version.eq.1)&order=name.desc.nullslast&limit=10&offset=20')
    expect(parsed.kind).toBe('table')
    expect(parsed.request.operations).toEqual([
      { method: 'select', args: ['id,name', { head: false }] },
      { method: 'filter', args: ['app_id', 'eq', 'com.demo'] },
      { method: 'filter', args: ['name', 'not.in', '(a,b)'] },
      { method: 'or', args: ['version.eq.1,rollout_version.eq.1'] },
      { method: 'order', args: ['name', { ascending: false, nullsFirst: false }] },
      { method: 'range', args: [20, 29] },
    ])
  })

  it('maps single-object Accept, Range, upsert resolution and RPC bodies', () => {
    expect(parse('GET', 'apps?app_id=eq.x', { accept: 'application/vnd.pgrst.object+json' }).request.operations.at(-1)).toEqual({ method: 'single', args: [] })
    expect(parse('GET', 'apps', { range: '0-0' }).request.operations.at(-1)).toEqual({ method: 'range', args: [0, 0] })
    const upsert = parse('POST', 'channels?on_conflict=app_id,name&select=*', { prefer: 'resolution=merge-duplicates,return=representation' }, { app_id: 'x', name: 'prod' })
    expect(upsert.request.operations[0]).toEqual({ method: 'upsert', args: [{ app_id: 'x', name: 'prod' }, { defaultToNull: true, onConflict: 'app_id,name', ignoreDuplicates: false }] })
    expect(upsert.request.operations[1]).toEqual({ method: 'select', args: ['*'] })
    const rpc = parse('POST', 'rpc/get_orgs_v7', {}, { userid: 'u' })
    expect(rpc).toMatchObject({ kind: 'rpc', name: 'get_orgs_v7', request: { args: [{ userid: 'u' }] } })
  })

  it('answers with PostgREST status, Content-Range and error bodies', () => {
    const get = parse('GET', 'apps?offset=5', { prefer: 'count=exact' })
    expect(postgrestResponse(get, { data: [{}, {}], error: null, count: 7, status: 200 })).toEqual({ status: 200, headers: { 'Content-Range': '5-6/7' }, body: [{}, {}] })
    const minimal = parse('PATCH', 'apps?app_id=eq.x', {}, { name: 'n' })
    expect(postgrestResponse(minimal, { data: null, error: null, count: null, status: 200 }).status).toBe(204)
    const failed = postgrestResponse(get, { data: null, error: { code: '42501', message: 'denied', details: null }, count: null, status: 401 })
    expect(failed).toEqual({ status: 401, headers: {}, body: { code: '42501', details: null, hint: null, message: 'denied' } })
  })
})

describe('embedded order and limit (referencedTable)', () => {
  const embedCatalog: QueryCatalog = {
    columns: new Map([
      ['channels', [column('id', 'int8'), column('name', 'text'), column('app_id', 'text')]],
      ['deploy_history', [column('id', 'int8'), column('channel_id', 'int8'), column('deployed_at', 'timestamptz')]],
    ]),
    foreignKeys: [{ name: 'deploy_history_channel_id_fkey', sourceTable: 'deploy_history', sourceColumn: 'channel_id', targetTable: 'channels', targetColumn: 'id', unique: false }],
    functions: [],
  }

  it('orders and limits the embedded rows, not the parent rows', () => {
    const compiled = compileConsoleQuery(embedCatalog, table('channels', [
      { method: 'select', args: ['id, deploy_history(deployed_at)'] },
      { method: 'eq', args: ['app_id', 'com.demo'] },
      { method: 'order', args: ['name', { ascending: true }] },
      { method: 'order', args: ['deployed_at', { referencedTable: 'deploy_history', ascending: false }] },
      { method: 'limit', args: [3, { referencedTable: 'deploy_history' }] },
    ]))
    const text = flat(compiled.text)
    expect(text).toContain('row_number() OVER (ORDER BY "deployed_at" DESC)')
    expect(text).toContain('ORDER BY "deployed_at" DESC LIMIT 3)')
    expect(text).toContain('ORDER BY t."name" ASC LIMIT 1000')
    expect(() => compileConsoleQuery(embedCatalog, table('channels', [
      { method: 'select', args: ['id'] },
      { method: 'limit', args: [3, { referencedTable: 'deploy_history' }] },
    ]))).toThrow('is not an embedded resource')
  })
})

describe('JSON key filters', () => {
  it('keeps camelCase JSON keys, as PostgREST does', () => {
    const jsonCatalog: QueryCatalog = {
      columns: new Map([['usage_credit_transactions', [column('id', 'int8'), column('source_ref', 'jsonb')]]]),
      foreignKeys: [],
      functions: [],
    }
    const compiled = compileConsoleQuery(jsonCatalog, table('usage_credit_transactions', [
      { method: 'select', args: ['id'] },
      { method: 'or', args: ['source_ref->>sessionId.eq.cs_test_1,source_ref->>paymentIntentId.eq.pi_1'] },
    ]))
    expect(flat(compiled.text)).toContain('(t."source_ref"->>\'sessionId\')')
    expect(flat(compiled.text)).toContain('(t."source_ref"->>\'paymentIntentId\')')
  })
})

describe('tooling database URL', () => {
  it('uses the given database and never falls back to local for a remote project', async () => {
    const { resolveDatabaseUrl } = await import('../scripts/db-client.ts')
    expect(resolveDatabaseUrl('https://project.supabase.co', 'postgresql://u:p@db.project.supabase.co:5432/postgres')).toBe('postgresql://u:p@db.project.supabase.co:5432/postgres')
    expect(() => resolveDatabaseUrl('https://project.supabase.co', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toThrow('Refusing to query the local database')
    expect(resolveDatabaseUrl('http://127.0.0.1:54321', 'postgresql://postgres:postgres@localhost:54322/postgres')).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres')
  })
})
