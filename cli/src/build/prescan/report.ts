// src/build/prescan/report.ts
import { env, stdout } from 'node:process'
import type { Finding, PrescanReport, Severity } from './types'
import { formatEnforcementDeadline, informationOnlyFindings, isFindingEnforced } from './enforcement'

const ORDER: Severity[] = ['error', 'warning', 'info']
const BADGE: Record<Severity, string> = { error: '✖ ERROR', warning: '⚠ WARN ', info: 'ℹ INFO ' }

// Minimal ANSI palette — no dependency. Coloring is disabled for non-TTY output
// (pipes, CI, MCP stdio) and when NO_COLOR is set, and never applied to --json.
const ANSI = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' }
const SEVERITY_CODES: Record<Severity, string> = {
  error: ANSI.bold + ANSI.red,
  warning: ANSI.bold + ANSI.yellow,
  info: ANSI.dim,
}

function colorEnabledByDefault(): boolean {
  return Boolean(stdout.isTTY) && !env.NO_COLOR
}

export function renderTerminalReport(report: PrescanReport, opts: { verbose?: boolean, color?: boolean, now?: Date } = {}): string {
  const enabled = opts.color ?? colorEnabledByDefault()
  const now = opts.now ?? new Date()
  // Wrap whole semantic units only (badge / id / detail / fix / summary) so substring
  // matching on the plain text still works when color is on.
  const paint = (codes: string, text: string): string => (enabled ? `${codes}${text}${ANSI.reset}` : text)

  const lines: string[] = []
  for (const sev of ORDER) {
    for (const f of report.findings.filter(x => x.severity === sev)) {
      const informationOnly = !isFindingEnforced(f, now)
      const badge = informationOnly
        ? (sev === 'error' ? '✖ CRITICAL — INFORMATION ONLY' : `${BADGE[sev].trim()} — INFORMATION ONLY`)
        : BADGE[sev]
      lines.push(`${paint(SEVERITY_CODES[sev], badge)}  ${f.title}  ${paint(ANSI.dim, `[${f.id}]`)}`)
      if (f.detail)
        lines.push(paint(ANSI.dim, `         ${f.detail}`))
      if (f.fix)
        lines.push(paint(ANSI.dim, `         fix: ${f.fix}`))
      if (f.docsUrl)
        lines.push(paint(ANSI.dim, `         docs: ${f.docsUrl}`))
      if (informationOnly && f.enforceAfter) {
        const impact = sev === 'error'
          ? 'this critical finding is information only now and will fail builds'
          : 'this finding is information only now and can affect build outcomes'
        lines.push(paint(ANSI.dim, `         rollout: ${impact} starting ${formatEnforcementDeadline(f.enforceAfter)}`))
      }
    }
  }

  const { error, warning, info } = report.counts
  lines.push('')
  const summary = `prescan: ${report.checksRun} checks in ${report.durationMs}ms — ${error} error(s), ${warning} warning(s), ${info} info`
  // Tint the summary by worst severity so the headline matches the badges above.
  const summaryCodes = error > 0 ? ANSI.red : warning > 0 ? ANSI.yellow : ANSI.dim
  lines.push(paint(summaryCodes, summary))
  const deferred = informationOnlyFindings(report, now)
  if (deferred.length > 0)
    lines.push(paint(ANSI.dim, `rollout: ${deferred.length} finding(s) are information only until their enforcement deadline`))
  if (opts.verbose)
    lines.push(paint(ANSI.dim, `remote checks skipped: ${report.skippedRemote}`))
  return lines.join('\n')
}

export function renderJsonReport(report: PrescanReport): string {
  const findings = report.findings.map((f: Finding) => {
    const out: Record<string, string> = { id: f.id, severity: f.severity, title: f.title }
    if (f.detail)
      out.detail = f.detail
    if (f.fix)
      out.fix = f.fix
    if (f.docsUrl)
      out.docsUrl = f.docsUrl
    if (f.enforceAfter)
      out.enforceAfter = f.enforceAfter
    return out
  })
  return JSON.stringify({ version: 1, counts: report.counts, checksRun: report.checksRun, durationMs: report.durationMs, skippedRemote: report.skippedRemote, findings }, null, 2)
}
