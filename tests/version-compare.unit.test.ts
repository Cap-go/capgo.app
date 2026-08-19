import { describe, expect, it } from 'vitest'
import { buildVersionCompareSql, compareVersionPrefix, parseVersionParts } from '../supabase/functions/_backend/utils/versionCompare.ts'

describe('parseVersionParts', () => {
  it.concurrent('parses android and ios versions', () => {
    expect(parseVersionParts('14')).toEqual([14])
    expect(parseVersionParts('14.0.1')).toEqual([14, 0, 1])
    expect(parseVersionParts('17.4')).toEqual([17, 4])
    expect(parseVersionParts('Android 14')).toEqual([14])
  })

  it.concurrent('returns null for empty, non-numeric, or oversized values', () => {
    expect(parseVersionParts('')).toBeNull()
    expect(parseVersionParts('builtin')).toBeNull()
    expect(parseVersionParts(undefined)).toBeNull()
    expect(parseVersionParts('9999999999')).toEqual([999999999])
  })
})

describe('compareVersionPrefix', () => {
  it.concurrent('matches android 14 and above', () => {
    expect(compareVersionPrefix('14', { op: 'gte', value: '14' })).toBe(true)
    expect(compareVersionPrefix('14.0.1', { op: 'gte', value: '14' })).toBe(true)
    expect(compareVersionPrefix('15', { op: 'gte', value: '14' })).toBe(true)
    expect(compareVersionPrefix('13', { op: 'gte', value: '14' })).toBe(false)
  })

  it.concurrent('matches android 14 and below including 14.x', () => {
    expect(compareVersionPrefix('14.0.1', { op: 'lte', value: '14' })).toBe(true)
    expect(compareVersionPrefix('13', { op: 'lte', value: '14' })).toBe(true)
    expect(compareVersionPrefix('15', { op: 'lte', value: '14' })).toBe(false)
  })

  it.concurrent('matches exact major with eq', () => {
    expect(compareVersionPrefix('14.2', { op: 'eq', value: '14' })).toBe(true)
    expect(compareVersionPrefix('15', { op: 'eq', value: '14' })).toBe(false)
  })

  it.concurrent('compares bundle numbers with three parts', () => {
    expect(compareVersionPrefix('1.2.4', { op: 'gte', value: '1.2.3' })).toBe(true)
    expect(compareVersionPrefix('1.2.2', { op: 'gte', value: '1.2.3' })).toBe(false)
    expect(compareVersionPrefix('1.1.9', { op: 'lt', value: '1.2.0' })).toBe(true)
  })
})

describe('buildVersionCompareSql', () => {
  it.concurrent('builds postgres prefix gte on a single part', () => {
    const sql = buildVersionCompareSql('os_version', { op: 'gte', value: '14' }, 'pg')
    expect(sql).toContain("split_part(os_version, '.', 1)")
    expect(sql).toContain('>= 14')
  })

  it.concurrent('builds cloudflare prefix gte on a single part', () => {
    const sql = buildVersionCompareSql('os_version', { op: 'gte', value: '14' }, 'cf')
    expect(sql).toContain("splitByChar('.', os_version)[1]")
    expect(sql).not.toContain('concat(')
    expect(sql).toContain('toUInt32OrZero')
    expect(sql).toContain('>= 14')
  })

  it.concurrent('builds three-part bundle compare', () => {
    const sql = buildVersionCompareSql('version_name', { op: 'gte', value: '1.2.3' }, 'pg')
    expect(sql).toContain('>= 3')
    expect(sql).toContain('> 1')
    expect(sql).toContain('> 2')
  })

  it.concurrent('builds an eq prefix compare', () => {
    const sql = buildVersionCompareSql('os_version', { op: 'eq', value: '14.0' }, 'pg')
    expect(sql).toContain('= 14')
    expect(sql).toContain('= 0')
    expect(sql).toContain('AND')
    expect(sql.startsWith('(')).toBe(false)
  })

  it.concurrent('returns a false predicate for unparseable values', () => {
    expect(buildVersionCompareSql('os_version', { op: 'gte', value: 'builtin' }, 'pg')).toBe('1 = 0')
  })
})

describe('compareVersionPrefix extra ops', () => {
  it.concurrent('does not treat later dotted parts as greater for gt on a shorter prefix', () => {
    expect(compareVersionPrefix('14.5', { op: 'gt', value: '14' })).toBe(false)
    expect(compareVersionPrefix('15', { op: 'gt', value: '14' })).toBe(true)
  })
})
