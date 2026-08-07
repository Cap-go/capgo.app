// test/prescan/overrides.test.ts
import { describe, expect, it } from 'bun:test'
import { decideOutcome, runPrescan } from '../../src/build/prescan/engine'
import {
  applyWarnOverrides,
  normalizeCheckIds,
  parsePrescanOverrides,
  validateOverrideIds,
} from '../../src/build/prescan/overrides'
import { ALL_CHECK_IDS } from '../../src/build/prescan/registry'
import type { Finding, PrescanCheck, ScanContext } from '../../src/build/prescan/types'

const baseCtx = { appId: 'com.demo.app', platform: 'ios', projectDir: '/tmp/none' } as ScanContext

function check(partial: Partial<PrescanCheck>): PrescanCheck {
  return { id: 'test/x', platforms: ['ios', 'android'], run: async () => [], ...partial }
}

describe('normalizeCheckIds', () => {
  it('splits comma lists and dedupes', () => {
    expect(normalizeCheckIds(['ios/a, ios/b', 'ios/b', '  ios/c  '])).toEqual(['ios/a', 'ios/b', 'ios/c'])
  })
  it('accepts a single string', () => {
    expect(normalizeCheckIds('ios/a,ios/b')).toEqual(['ios/a', 'ios/b'])
  })
})

describe('validateOverrideIds', () => {
  it('rejects unknown ids', () => {
    expect(() => validateOverrideIds(parsePrescanOverrides({ skip: 'not/a-real-check' }), ALL_CHECK_IDS))
      .toThrow(/Unknown prescan check id/)
  })
  it('accepts known ids', () => {
    expect(() => validateOverrideIds(
      parsePrescanOverrides({ skip: 'ios/capacitor-server-url-shipped', warn: 'ios/capacitor-server-cleartext' }),
      ALL_CHECK_IDS,
    )).not.toThrow()
  })
})

describe('applyWarnOverrides', () => {
  it('downgrades errors to warnings for matched ids', () => {
    const findings: Finding[] = [
      { id: 'ios/capacitor-server-url-shipped', severity: 'error', title: 'remote url' },
      { id: 'ios/other', severity: 'error', title: 'keep' },
    ]
    const out = applyWarnOverrides(findings, parsePrescanOverrides({ warn: 'ios/capacitor-server-url-shipped' }))
    expect(out[0]?.severity).toBe('warning')
    expect(out[1]?.severity).toBe('error')
  })
})

describe('runPrescan overrides', () => {
  it('skips checks listed in --prescan-skip and reports info', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'ios/capacitor-server-url-shipped', run: async () => [{ id: 'ios/capacitor-server-url-shipped', severity: 'error', title: 'bad' }] }),
      check({ id: 'ios/other', run: async () => [{ id: 'ios/other', severity: 'warning', title: 'warn' }] }),
    ], { overrides: parsePrescanOverrides({ skip: 'ios/capacitor-server-url-shipped' }) })
    expect(report.findings.some(f => f.id === 'ios/capacitor-server-url-shipped')).toBe(false)
    expect(report.findings.find(f => f.id === 'prescan/check-skipped')?.detail).toContain('ios/capacitor-server-url-shipped')
    expect(report.counts.error).toBe(0)
    expect(report.counts.warning).toBe(1)
  })

  it('downgrades matched check findings to warning', async () => {
    const report = await runPrescan(baseCtx, [
      check({ id: 'ios/capacitor-server-url-shipped', run: async () => [{ id: 'ios/capacitor-server-url-shipped', severity: 'error', title: 'bad' }] }),
    ], { overrides: parsePrescanOverrides({ warn: 'ios/capacitor-server-url-shipped' }) })
    expect(report.counts.error).toBe(0)
    expect(report.counts.warning).toBe(1)
    expect(decideOutcome(report, {})).toBe('ask')
  })
})
