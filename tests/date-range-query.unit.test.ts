import { describe, expect, it } from 'vitest'
import {
  getTableDateRangeSignature,
  getTimeWindowPageRange,
  parseDateRangeQuery,
  serializeDateRangeQuery,
  shouldRecountOnTableReload,
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

  it.concurrent('keeps rolling table signatures stable across wall-clock ticks', () => {
    expect(getTableDateRangeSignature('30min')).toEqual({ mode: '30min' })
    expect(getTableDateRangeSignature('30day')).toEqual({ mode: '30day' })
    expect(getTableDateRangeSignature('30min')).toEqual(getTableDateRangeSignature('30min'))
  })

  it.concurrent('includes custom bounds in the table signature', () => {
    const start = new Date('2026-03-01T00:00:00.000Z')
    const end = new Date('2026-03-15T00:00:00.000Z')
    expect(getTableDateRangeSignature('custom', [start, end])).toEqual({
      mode: 'custom',
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-15T00:00:00.000Z',
    })
    expect(getTableDateRangeSignature('custom', null)).toEqual({ mode: 'custom' })
  })

  it.concurrent('skips recount on page-only navigation and recounts on filter or reload', () => {
    expect(shouldRecountOnTableReload({
      filtersChanged: false,
      previousPage: 1,
      requestedPage: 2,
    })).toBe(false)
    expect(shouldRecountOnTableReload({
      filtersChanged: true,
      previousPage: 2,
      requestedPage: 2,
    })).toBe(true)
    expect(shouldRecountOnTableReload({
      filtersChanged: false,
      previousPage: 3,
      requestedPage: 3,
    })).toBe(true)
  })

  it.concurrent('shifts logs Load older windows backward without resetting page 1', () => {
    const start = Date.parse('2026-08-08T12:00:00.000Z')
    const end = Date.parse('2026-08-08T12:30:00.000Z')
    expect(getTimeWindowPageRange(start, end, 1)).toEqual({
      rangeStart: start,
      rangeEnd: end,
    })
    expect(getTimeWindowPageRange(start, end, 0)).toEqual({
      rangeStart: Date.parse('2026-08-08T11:30:00.000Z'),
      rangeEnd: Date.parse('2026-08-08T12:00:00.000Z'),
    })
  })
})
