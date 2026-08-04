// src/build/prescan/engine.ts
import type { Finding, OutcomeOptions, PrescanCheck, PrescanOutcome, PrescanReport, ScanContext, Severity } from './types'
import { enforcedCounts } from './enforcement'

interface EngineOptions { checkTimeoutMs?: number }

const DEFAULT_CHECK_TIMEOUT_MS = 10_000
const MAX_CRASH_DETAIL_CHARS = 200

/**
 * Crash text is user-visible (terminal report + --json, often captured in CI logs).
 * Cap its length and strip long base64-looking runs so a check that ever throws
 * with credential context (e.g. a JSON.parse over a secret blob) cannot leak it.
 */
function sanitizeCrashDetail(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.replace(/[A-Z0-9+/=_-]{40,}/gi, '[redacted]').slice(0, MAX_CRASH_DETAIL_CHARS)
}

export async function runPrescan(ctx: ScanContext, checks: PrescanCheck[], options: EngineOptions = {}): Promise<PrescanReport> {
  const start = Date.now()
  const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  // appliesTo predicates get the same crash isolation as run(): a throwing
  // predicate must degrade to a notice, never reject the whole scan.
  const applicable: PrescanCheck[] = []
  const findings: Finding[] = []
  for (const c of checks) {
    if (!c.platforms.includes(ctx.platform))
      continue
    try {
      if (c.appliesTo && !c.appliesTo(ctx))
        continue
      applicable.push(c)
    }
    catch (error) {
      findings.push({
        id: 'prescan/check-crashed',
        severity: 'info',
        title: `Check ${c.id} crashed and was skipped`,
        detail: sanitizeCrashDetail(error),
      })
    }
  }
  const remoteSkipped = applicable.filter(c => c.remote && !ctx.supabase)
  const runnable = applicable.filter(c => !(c.remote && !ctx.supabase))

  findings.push(...(await Promise.all(runnable.map(c => runIsolated(c, ctx, timeoutMs)))).flat())

  if (remoteSkipped.length > 0) {
    findings.push({
      id: 'prescan/remote-skipped',
      severity: 'info',
      title: `${remoteSkipped.length} remote check(s) skipped (no apikey or offline)`,
      detail: remoteSkipped.map(c => c.id).join(', '),
    })
  }

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++

  return { findings, counts, skippedRemote: remoteSkipped.length, durationMs: Date.now() - start, checksRun: runnable.length }
}

async function runIsolated(check: PrescanCheck, ctx: ScanContext, timeoutMs: number): Promise<Finding[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Finding[]>((resolve) => {
    timer = setTimeout(() => resolve([{
      id: 'prescan/check-timeout',
      severity: 'info',
      title: `Check ${check.id} timed out and was skipped`,
    }]), timeoutMs)
  })
  try {
    const findings = await Promise.race([check.run(ctx), timeout])
    if (!check.enforceAfter)
      return findings
    return findings.map(finding => ({ ...finding, enforceAfter: finding.enforceAfter ?? check.enforceAfter }))
  }
  catch (error) {
    return [{
      id: 'prescan/check-crashed',
      severity: 'info',
      title: `Check ${check.id} crashed and was skipped`,
      detail: sanitizeCrashDetail(error),
      enforceAfter: check.enforceAfter,
    }]
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

export function decideOutcome(report: Pick<PrescanReport, 'counts' | 'findings'>, options: OutcomeOptions): PrescanOutcome {
  if (options.ignoreFatal) return 'proceed'
  const counts = enforcedCounts(report, options.now)
  if (counts.error > 0) return 'block'
  if (counts.warning > 0) return options.failOnWarnings ? 'block' : 'ask'
  return 'proceed'
}
