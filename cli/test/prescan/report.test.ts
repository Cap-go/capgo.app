// test/prescan/report.test.ts
import { describe, expect, it } from 'bun:test'
import { renderJsonReport, renderTerminalReport } from '../../src/build/prescan/report'
import type { PrescanReport } from '../../src/build/prescan/types'

const report: PrescanReport = {
  findings: [
    { id: 'ios/p12-expiry', severity: 'error', title: 'Certificate expired', detail: 'expired 2026-01-01', fix: 'Renew and re-save credentials' },
    { id: 'android/gradle-props-heuristics', severity: 'warning', title: 'Serial Gradle build' },
    { id: 'prescan/remote-skipped', severity: 'info', title: '2 remote check(s) skipped (no apikey or offline)' },
  ],
  counts: { error: 1, warning: 1, info: 1 },
  skippedRemote: 2,
  durationMs: 123,
  checksRun: 20,
}

describe('renderTerminalReport', () => {
  it('groups by severity with fix hints and a summary line', () => {
    const out = renderTerminalReport(report, { verbose: false })
    expect(out).toContain('Certificate expired')
    expect(out).toContain('Renew and re-save credentials')
    expect(out).toContain('ios/p12-expiry')
    expect(out).toContain('1 error')
    expect(out).toContain('1 warning')
    // errors before warnings
    expect(out.indexOf('Certificate expired')).toBeLessThan(out.indexOf('Serial Gradle build'))
  })

  it('omits ANSI color codes when color is disabled', () => {
    const out = renderTerminalReport(report, { color: false })
    // eslint-disable-next-line no-control-regex
    expect(/\x1B\[/.test(out)).toBe(false)
  })

  it('emits ANSI color codes when color is enabled, without splitting plain substrings', () => {
    const out = renderTerminalReport(report, { color: true })
    expect(out).toContain('\x1B[') // some ANSI present
    expect(out).toContain('\x1B[1m\x1B[31m✖ ERROR\x1B[0m') // bold red error badge
    expect(out).toContain('\x1B[1m\x1B[33m⚠ WARN \x1B[0m') // bold yellow warn badge
    // plain text the gate/tests rely on stays contiguous despite coloring
    expect(out).toContain('Certificate expired')
    expect(out).toContain('1 error')
    expect(out).toContain('1 warning')
  })

  it('keeps a deferred error visibly critical while explaining the information-only window', () => {
    const deferred: PrescanReport = {
      ...report,
      findings: [{
        id: 'ios/new-check',
        severity: 'error',
        title: 'New critical check failed',
        enforceAfter: '2026-08-14T00:00:00.000Z',
      }],
      counts: { error: 1, warning: 0, info: 0 },
    }
    const out = renderTerminalReport(deferred, { color: false, now: new Date('2026-08-01T00:00:00.000Z') })
    expect(out).toContain('CRITICAL — INFORMATION ONLY')
    expect(out).toContain('will fail builds starting 2026-08-14 00:00 UTC')
    expect(out).toContain('1 error')
  })
})

describe('renderJsonReport', () => {
  it('emits stable machine-readable shape', () => {
    const parsed = JSON.parse(renderJsonReport(report))
    expect(parsed.version).toBe(1)
    expect(parsed.counts.error).toBe(1)
    expect(parsed.findings[0]).toEqual({
      id: 'ios/p12-expiry', severity: 'error', title: 'Certificate expired',
      detail: 'expired 2026-01-01', fix: 'Renew and re-save credentials',
    })
    expect(parsed.checksRun).toBe(20)
  })

  it('serializes the hard-coded enforcement date for rollout-aware consumers', () => {
    const deferred: PrescanReport = {
      ...report,
      findings: [{
        id: 'ios/new-check',
        severity: 'error',
        title: 'New critical check failed',
        enforceAfter: '2026-08-14T00:00:00.000Z',
      }],
      counts: { error: 1, warning: 0, info: 0 },
    }
    const parsed = JSON.parse(renderJsonReport(deferred))
    expect(parsed.findings[0].enforceAfter).toBe('2026-08-14T00:00:00.000Z')
  })
})
