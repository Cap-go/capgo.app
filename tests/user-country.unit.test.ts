import type { Context } from 'hono'
import type { ConsoleQueryRequest } from '../supabase/functions/_backend/private/console_query_sql.ts'
import { describe, expect, it } from 'vitest'
import { getRequestCountry } from '../supabase/functions/_backend/utils/request_country.ts'
import { defaultUserCountry } from '../supabase/functions/_backend/utils/user_country.ts'

function context(country?: unknown, header?: string) {
  return { req: { raw: { cf: { country } }, header: () => header } } as unknown as Context
}

function request(method = 'insert', payload: unknown = { id: 'new-user', country: null }): ConsoleQueryRequest {
  return { kind: 'table', name: 'users', args: [], operations: [{ method, args: [payload] }] }
}

describe('request country', () => {
  it.each([
    ['in', 'US', 'IN'],
    [undefined, 'br', 'BR'],
    ['XX', 'US', null],
    ['T1', 'US', null],
    ['India', undefined, null],
    [123, undefined, null],
    [undefined, undefined, null],
  ])('normalizes Worker country %s and fallback header %s to %s', (country, header, expected) => {
    expect(getRequestCountry(context(country, header))).toBe(expected)
  })
})

describe('console profile country defaults', () => {
  it('fills missing countries on first-login inserts while preserving explicit values', () => {
    const query = request('insert', [
      { id: 'one', country: null },
      { id: 'two' },
      { id: 'three', country: '' },
      { id: 'four', country: 'Portugal' },
    ])
    query.operations[0].args.push({ defaultToNull: false })
    const result = defaultUserCountry(context('IN'), query)
    expect(result.operations[0].args).toEqual([[
      { id: 'one', country: 'IN' },
      { id: 'two', country: 'IN' },
      { id: 'three', country: 'IN' },
      { id: 'four', country: 'Portugal' },
    ], { defaultToNull: false }])
    expect((query.operations[0].args[0] as any[])[0].country).toBeNull()
  })

  it('fills a single profile and retains the query shape', () => {
    const query = request()
    query.operations.push({ method: 'select', args: ['*'] }, { method: 'single', args: [] })
    const result = defaultUserCountry(context('BR'), query)
    expect(result.operations[0].args[0]).toEqual({ id: 'new-user', country: 'BR' })
    expect(result.operations.slice(1)).toEqual(query.operations.slice(1))
  })

  it.each(['update', 'upsert', 'select', 'delete'])('does not infer country for %s', (method) => {
    const query = request(method)
    expect(defaultUserCountry(context('IN'), query)).toEqual(query)
  })

  it('leaves unknown locations, other tables, RPCs and malformed rows untouched', () => {
    const query = request()
    expect(defaultUserCountry(context('XX'), query)).toBe(query)
    for (const other of [{ ...query, name: 'orgs' }, { ...query, kind: 'rpc' as const }, request('insert', null)])
      expect(defaultUserCountry(context('IN'), other)).toEqual(other)
  })
})
