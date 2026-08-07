import { describe, expect, it } from 'vitest'
import {
  parseDateRangeQuery,
  serializeDateRangeQuery,
} from '../src/services/dateRange'

describe('date range query parse/serialize', () => {
  it.concurrent('parses rolling presets from range', () => {
    expect(parseDateRangeQuery({ range: '30day' })).toEqual({ mode: '30day' })
    expect(parseDateRangeQuery({ range: '24h' })).toEqual({ mode: '24h' })
    expect(parseDateRangeQuery({ range: '7day' })).toEqual({ mode: '7day' })
  })

  it.concurrent('parses custom range with valid start/end', () => {
    const start = '2026-03-01T00:00:00.000Z'
    const end = '2026-03-15T00:00:00.000Z'
    expect(parseDateRangeQuery({ range: 'custom', start, end })).toEqual({
      mode: 'custom',
      start: new Date(start),
      end: new Date(end),
    })
  })

  it.concurrent('rejects missing, unknown, or invalid custom bounds', () => {
    expect(parseDateRangeQuery({})).toBeNull()
    expect(parseDateRangeQuery({ range: 'nope' })).toBeNull()
    expect(parseDateRangeQuery({ range: 'custom' })).toBeNull()
    expect(parseDateRangeQuery({
      range: 'custom',
      start: 'not-a-date',
      end: '2026-03-15T00:00:00.000Z',
    })).toBeNull()
    expect(parseDateRangeQuery({
      range: 'custom',
      start: '2026-03-15T00:00:00.000Z',
      end: '2026-03-01T00:00:00.000Z',
    })).toBeNull()
  })

  it.concurrent('serializes rolling and custom modes for the URL', () => {
    expect(serializeDateRangeQuery('30day')).toEqual({ range: '30day' })
    expect(serializeDateRangeQuery('custom', {
      start: new Date('2026-03-01T00:00:00.000Z'),
      end: new Date('2026-03-15T00:00:00.000Z'),
    })).toEqual({
      range: 'custom',
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-15T00:00:00.000Z',
    })
  })
})
