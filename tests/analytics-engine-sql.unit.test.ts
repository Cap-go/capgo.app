import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lintAnalyticsEngineSql } from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { collectAnalyticsEngineSqlFixtures } from './helpers/collectAnalyticsEngineSqlFixtures.ts'

describe('analytics engine sql lint rules', () => {
  it.concurrent('flags COUNT(*)', () => {
    expect(lintAnalyticsEngineSql('SELECT COUNT(*) AS total FROM device_info')).toEqual([
      expect.objectContaining({ rule: 'no-count-star' }),
    ])
  })

  it.concurrent('flags CASE WHEN inside argMax', () => {
    expect(lintAnalyticsEngineSql(
      "SELECT argMax(blob9, CASE WHEN blob9 != '' THEN timestamp ELSE toDateTime('1970-01-01 00:00:00') END) FROM device_info",
    )).toEqual([
      expect.objectContaining({ rule: 'no-case-in-argmax' }),
    ])
  })

  it.concurrent('flags JOIN clauses', () => {
    const issues = lintAnalyticsEngineSql(
      'SELECT 1 FROM bandwidth_usage LEFT JOIN device_usage ON bandwidth_usage.blob1 = device_usage.blob1',
    )
    expect(issues.map(issue => issue.rule)).toContain('no-join')
  })

  it.concurrent('flags multiIf', () => {
    expect(lintAnalyticsEngineSql("SELECT multiIf(blob4 != '', blob4, 1, 'ios') FROM device_usage").map(issue => issue.rule)).toContain('no-multiif')
  })

  it.concurrent('flags unsupported toString calls', () => {
    expect(lintAnalyticsEngineSql('SELECT toString(toDate(timestamp)) AS date FROM app_log').map(issue => issue.rule)).toContain('no-to-string')
  })

  it.concurrent('flags unsupported concat calls', () => {
    expect(lintAnalyticsEngineSql("SELECT concat(index1, ':', blob1) FROM device_usage").map(issue => issue.rule)).toContain('no-concat')
  })

  it.concurrent('accepts supported COUNT() and COUNT(DISTINCT) forms', () => {
    expect(lintAnalyticsEngineSql('SELECT COUNT() AS total FROM device_info')).toEqual([])
    expect(lintAnalyticsEngineSql('SELECT COUNT(DISTINCT blob1) AS total FROM device_info')).toEqual([])
  })

  it.concurrent('flags untyped NULL IF() branches', () => {
    expect(lintAnalyticsEngineSql(
      "SELECT min(if(blob2 = 'download_complete' AND double1 > 0, double1, NULL)) FROM app_log",
    ).map(issue => issue.rule)).toContain('no-if-untyped-null')
    expect(lintAnalyticsEngineSql(
      "SELECT min(if(blob2 IN ('download_complete', 'download_zip_complete') AND double1 > 0, double1, NULL)) FROM app_log",
    ).map(issue => issue.rule)).toContain('no-if-untyped-null')
    expect(lintAnalyticsEngineSql(
      "SELECT min(if(blob2 = 'download_complete', NULL, double1)) FROM app_log",
    ).map(issue => issue.rule)).toContain('no-if-untyped-null')
    expect(lintAnalyticsEngineSql(
      "SELECT coalesce(double1, NULL) FROM app_log",
    ).map(issue => issue.rule)).not.toContain('no-if-untyped-null')
    expect(lintAnalyticsEngineSql(
      "SELECT sum(if(blob2 = 'set', 1, 0)) AS succeeded FROM app_log WHERE blob2 IN ('set', NULL)",
    ).map(issue => issue.rule)).not.toContain('no-if-untyped-null')
    expect(lintAnalyticsEngineSql(
      "SELECT if(blob2 IN ('set', NULL), 1, 0) FROM app_log",
    ).map(issue => issue.rule)).not.toContain('no-if-untyped-null')
  })
})

describe('analytics engine sql fixtures', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('generates lint-clean queries for every Analytics Engine read path', async () => {
    const fixtures = await collectAnalyticsEngineSqlFixtures()

    expect(fixtures.length).toBeGreaterThan(30)

    const offenders = fixtures.flatMap((fixture) => {
      const issues = lintAnalyticsEngineSql(fixture.query)
      return issues.map(issue => ({ fixture: fixture.name, issue }))
    })

    expect(offenders, offenders.map(entry => `${entry.fixture}: ${entry.issue.rule}`).join('\n')).toEqual([])
  })
})
