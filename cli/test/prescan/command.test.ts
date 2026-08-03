// test/prescan/command.test.ts
import type { Finding, PrescanReport, Severity } from '../../src/build/prescan/types'
import { describe, expect, it } from 'bun:test'
import { exitCodeFor, runPrescanGate, validateFlags } from '../../src/build/prescan/command'
import { ASC_PRESCAN_AUTH_ENFORCE_AFTER } from '../../src/build/prescan/checks/store-access'
import { IOS_PRESCAN_EXPANSION_ENFORCE_AFTER } from '../../src/build/prescan/registry'

describe('validateFlags', () => {
  it('rejects ignore-fatal + fail-on-warnings', () => {
    expect(() => validateFlags({ ignoreFatal: true, failOnWarnings: true }))
      .toThrow(/contradictory/i)
  })
  it('accepts each alone', () => {
    expect(() => validateFlags({ ignoreFatal: true })).not.toThrow()
    expect(() => validateFlags({ failOnWarnings: true })).not.toThrow()
  })
})

describe('exitCodeFor', () => {
  const counts = (error: number, warning: number) => ({ error, warning, info: 0 })
  it('0 when clean', () => expect(exitCodeFor(counts(0, 0), {})).toBe(0))
  it('1 on errors', () => expect(exitCodeFor(counts(1, 0), {})).toBe(1))
  it('0 on warnings by default', () => expect(exitCodeFor(counts(0, 2), {})).toBe(0))
  it('2 on warnings with failOnWarnings', () => expect(exitCodeFor(counts(0, 2), { failOnWarnings: true })).toBe(2))
  it('0 always with ignoreFatal', () => expect(exitCodeFor(counts(3, 3), { ignoreFatal: true })).toBe(0))
  it('0 for a deferred critical finding before the deadline', () => {
    const findings: Finding[] = [{
      id: 'ios/new-check',
      severity: 'error',
      title: 'critical',
      enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER,
    }]
    expect(exitCodeFor(counts(1, 0), { now: new Date('2026-08-01T00:00:00.000Z') }, findings)).toBe(0)
  })
  it('ASC auth finding becomes blocking exactly at the rollout deadline', () => {
    const findings: Finding[] = [{
      id: 'ios/asc-key-access',
      severity: 'error',
      title: 'authentication failed',
      enforceAfter: ASC_PRESCAN_AUTH_ENFORCE_AFTER,
    }]
    expect(exitCodeFor(counts(1, 0), { now: new Date('2026-08-16T23:59:59.999Z') }, findings)).toBe(0)
    expect(exitCodeFor(counts(1, 0), { now: new Date(ASC_PRESCAN_AUTH_ENFORCE_AFTER) }, findings)).toBe(1)
  })
})

/** Capture everything written to process.stdout during fn (clack writes raw to stdout). */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let out = ''
  // eslint-disable-next-line no-restricted-properties
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  }
  finally {
    process.stdout.write = original
  }
  return out
}

describe('runPrescanGate', () => {
  // findings must be consistent with counts so the report-render branch executes
  const fakeReport = (error: number, warning: number): PrescanReport => {
    const findings: Finding[] = []
    const push = (severity: Severity, n: number) => {
      for (let i = 0; i < n; i++)
        findings.push({ id: `test/${severity}-${i}`, severity, title: `${severity} ${i}` })
    }
    push('error', error)
    push('warning', warning)
    return { findings, counts: { error, warning, info: 0 }, skippedRemote: 0, durationMs: 1, checksRun: 1 }
  }
  it('returns proceed when scan disabled', async () => {
    const r = await runPrescanGate({ enabled: false }, async () => fakeReport(9, 9))
    expect(r.decision).toBe('proceed')
  })
  it('blocks on errors', async () => {
    const r = await runPrescanGate({ enabled: true, silent: true }, async () => fakeReport(1, 0))
    expect(r.decision).toBe('block')
  })
  it('prints a critical information-only error and proceeds during rollout', async () => {
    const printed: string[] = []
    const report = fakeReport(1, 0)
    report.findings[0].enforceAfter = IOS_PRESCAN_EXPANSION_ENFORCE_AFTER
    const r = await runPrescanGate({
      enabled: true,
      now: new Date('2026-08-01T00:00:00.000Z'),
      print: message => printed.push(message),
    }, async () => report)
    expect(r.decision).toBe('proceed')
    expect(printed.join('\n')).toContain('CRITICAL — INFORMATION ONLY')
    expect(printed.join('\n')).toContain('will fail builds starting 2026-08-14 00:00 UTC')
  })
  it('proceeds on errors with ignoreFatal', async () => {
    const r = await runPrescanGate({ enabled: true, ignoreFatal: true, silent: true }, async () => fakeReport(1, 0))
    expect(r.decision).toBe('proceed')
  })
  it('hides deferred critical rollout deadlines with ignoreFatal', async () => {
    const printed: string[] = []
    const report = fakeReport(1, 0)
    report.findings[0].enforceAfter = IOS_PRESCAN_EXPANSION_ENFORCE_AFTER
    const r = await runPrescanGate({
      enabled: true,
      ignoreFatal: true,
      now: new Date('2026-08-01T00:00:00.000Z'),
      print: message => printed.push(message),
    }, async () => report)
    expect(r.decision).toBe('proceed')
    expect(printed.join('\n')).toContain('CRITICAL — INFORMATION ONLY')
    expect(printed.join('\n')).not.toContain('will fail builds starting 2026-08-14 00:00 UTC')
  })
  it('proceeds (non-interactive) on warnings', async () => {
    const r = await runPrescanGate({ enabled: true, interactive: false, silent: true }, async () => fakeReport(0, 1))
    expect(r.decision).toBe('proceed')
  })
  it('never throws when the scan itself crashes — proceeds with a notice', async () => {
    const warned: string[] = []
    const r = await runPrescanGate({ enabled: true, warn: m => warned.push(m) }, async () => { throw new Error('scanner bug') })
    expect(r.decision).toBe('proceed')
    expect(warned.join('\n')).toContain('scanner bug')
  })
  it('renders the report through the caller-provided print sink', async () => {
    const printed: string[] = []
    await runPrescanGate({ enabled: true, interactive: false, print: m => printed.push(m) }, async () => fakeReport(0, 1))
    expect(printed.join('\n')).toContain('warning 0')
    expect(printed.join('\n')).toContain('1 warning(s)')
  })
  it('silent gate writes NOTHING to stdout (Ink/MCP callers own the channel)', async () => {
    const out = await captureStdout(async () => {
      const r = await runPrescanGate({ enabled: true, silent: true, interactive: false }, async () => fakeReport(2, 1))
      expect(r.decision).toBe('block')
    })
    expect(out).toBe('')
  })
  it('silent gate writes NOTHING to stdout when the scan crashes', async () => {
    const out = await captureStdout(async () => {
      const r = await runPrescanGate({ enabled: true, silent: true }, async () => { throw new Error('boom') })
      expect(r.decision).toBe('proceed')
    })
    expect(out).toBe('')
  })
  // The build-request gate telemetry reads result.report (counts + finding ids) and
  // result.crashed, so lock that contract.
  it('surfaces the report on a normal run (for telemetry)', async () => {
    const r = await runPrescanGate({ enabled: true, silent: true, interactive: false }, async () => fakeReport(1, 2))
    expect(r.report?.counts).toEqual({ error: 1, warning: 2, info: 0 })
    expect(r.crashed).toBe(false)
  })
  it('reports null + crashed=true when the scan throws', async () => {
    const r = await runPrescanGate({ enabled: true, silent: true }, async () => { throw new Error('boom') })
    expect(r.report).toBeNull()
    expect(r.crashed).toBe(true)
  })
  it('reports null when the gate is disabled', async () => {
    const r = await runPrescanGate({ enabled: false }, async () => fakeReport(9, 9))
    expect(r.report).toBeNull()
    expect(r.crashed).toBe(false)
  })
})
