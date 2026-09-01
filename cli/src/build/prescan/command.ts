// src/build/prescan/command.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/supabase.types'
import type { OutcomeOptions, Platform, PrescanReport, Severity } from './types'
import { cwd, exit } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { createSupabaseClient, findSavedKeySilent, sendEvent } from '../../utils'
import { buildScanContext } from './context'
import { enforcedCounts, informationOnlyFindings } from './enforcement'
import { decideOutcome, runPrescan } from './engine'
import { parsePrescanOverrides, validateOverrideIds } from './overrides'
import { resolveWarningGate } from './prompt'
import { ALL_CHECKS, ALL_CHECK_IDS } from './registry'
import { renderJsonReport, renderTerminalReport } from './report'

export interface PrescanCommandOptions {
  platform?: string
  path?: string
  apikey?: string
  androidFlavor?: string
  iosDist?: 'app_store' | 'ad_hoc'
  json?: boolean
  failOnWarnings?: boolean
  ignoreFatal?: boolean
  verbose?: boolean
  supaHost?: string
  supaAnon?: string
  /** Test seam for hard-coded rollout deadlines; defaults to the current time. */
  now?: Date
  /**
   * pre-merged credentials (CLI flags + env + saved file) when invoked from
   * build request's gate — the scan must validate the exact set the build
   * will use, not a fresh saved-file/env merge.
   */
  credentials?: Record<string, string>
  /** Check ids to skip entirely (repeatable / comma-separated). */
  skip?: string[] | string
  /** Check ids whose findings are downgraded to warning (repeatable / comma-separated). */
  warn?: string[] | string
}

export function validateFlags(opts: Pick<PrescanCommandOptions, 'failOnWarnings' | 'ignoreFatal'>): void {
  if (opts.failOnWarnings && opts.ignoreFatal)
    throw new Error('--ignore-fatal and --fail-on-warnings are contradictory — pick one')
}

export function exitCodeFor(counts: Record<Severity, number>, opts: OutcomeOptions, findings: PrescanReport['findings'] = []): number {
  if (opts.ignoreFatal)
    return 0
  const enforced = enforcedCounts({ counts, findings }, opts.now)
  if (enforced.error > 0)
    return 1
  if (enforced.warning > 0 && opts.failOnWarnings)
    return 2
  return 0
}

export interface PrescanExecution {
  report: PrescanReport
  /** apikey actually used for the scan (flag or saved key); undefined when remote checks were skipped */
  apikey?: string
}

/** Shared scan runner used by both the standalone command and build request's gate. */
export async function executePrescan(appId: string | undefined, options: PrescanCommandOptions): Promise<PrescanExecution> {
  const platform = options.platform as Platform
  if (platform !== 'ios' && platform !== 'android')
    throw new Error('--platform must be ios or android')
  // findSavedKeySilent never logs: `--json` consumers parse stdout, so a clack
  // error line before the JSON report would break them.
  const apikey = options.apikey ?? findSavedKeySilent()
  let supabase: SupabaseClient<Database> | undefined
  if (apikey) {
    try {
      supabase = await createSupabaseClient(apikey, options.supaHost, options.supaAnon, true)
    }
    catch { /* offline/invalid: remote checks will be skipped with a notice */ }
  }
  const ctx = await buildScanContext({
    appId,
    platform,
    projectDir: options.path ?? cwd(),
    distributionMode: options.iosDist,
    androidFlavor: options.androidFlavor,
    apikey,
    supabase,
    credentials: options.credentials,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  const overrides = parsePrescanOverrides({ skip: options.skip, warn: options.warn })
  validateOverrideIds(overrides, ALL_CHECK_IDS)
  const report = await runPrescan(ctx, ALL_CHECKS, { overrides })
  return { report, apikey }
}

export async function prescanCommand(appId: string | undefined, options: PrescanCommandOptions): Promise<void> {
  validateFlags(options)
  if (!options.json)
    intro('Capgo build prescan')
  const { report, apikey: apikeyUsedForScan } = await executePrescan(appId, options)
  if (options.json) {
    console.log(renderJsonReport(report))
  }
  else {
    log.message(renderTerminalReport(report, { verbose: options.verbose, now: options.now, ignoreFatal: options.ignoreFatal }))
    const outcome = decideOutcome(report, options)
    outro(outcome === 'block' ? 'Prescan found blocking problems — fix them before building.' : 'Prescan finished.')
  }
  if (apikeyUsedForScan) {
    const enforced = enforcedCounts(report, options.now)
    const informationOnly = informationOnlyFindings(report, options.now).length
    await sendEvent(apikeyUsedForScan, {
      channel: 'build',
      event: 'Prescan run',
      tags: {
        'source': 'standalone',
        'result': enforced.error > 0 ? (options.ignoreFatal ? 'bypassed' : 'blocked') : enforced.warning > 0 ? (options.failOnWarnings ? 'blocked' : 'warned') : informationOnly > 0 ? 'information-only' : 'clean',
        'app-id': appId ?? 'unknown',
        'platform': options.platform ?? 'unknown',
        'errors': String(report.counts.error),
        'warnings': String(report.counts.warning),
        'finding-ids': report.findings.filter(f => f.severity !== 'info').map(f => f.id).join(',').slice(0, 200),
        'information-only-findings': String(informationOnly),
      },
    }, options.verbose).catch(() => {})
  }
  exit(exitCodeFor(report.counts, options, report.findings))
}

export interface PrescanGateOptions {
  enabled: boolean
  ignoreFatal?: boolean
  failOnWarnings?: boolean
  /** test seam; defaults to canPromptInteractively() (via resolveWarningGate) at call time */
  interactive?: boolean
  silent?: boolean
  /** Test seam for hard-coded rollout deadlines; defaults to the current time. */
  now?: Date
  /**
   * Output sink for the report / crash notice. Callers that own the terminal
   * (Ink onboarding, SDK, MCP stdio) pass their BuildLogger here; raw clack
   * writes would corrupt their rendering or the JSON-RPC stdout channel.
   * Defaults to clack when not silent, and to no output when silent.
   */
  print?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface PrescanGateResult {
  decision: 'proceed' | 'block'
  /** null when the gate was disabled or the scan crashed (no scan ran) */
  report: PrescanReport | null
  crashed: boolean
  informationOnlyFindings: number
}

/**
 * Used by build request. Runs the scan via the provided thunk, prints the report,
 * and resolves to 'proceed' | 'block'. NEVER throws: a crashing scanner proceeds with a notice
 * (the scanner must never be worse than no scanner).
 */
export async function runPrescanGate(
  opts: PrescanGateOptions,
  scan: () => Promise<PrescanReport>,
): Promise<PrescanGateResult> {
  if (!opts.enabled)
    return { decision: 'proceed', report: null, crashed: false, informationOnlyFindings: 0 }
  const noop = (): void => {}
  const print = opts.print ?? (opts.silent ? noop : (msg: string) => log.message(msg))
  const warn = opts.warn ?? (opts.silent ? noop : (msg: string) => log.warn(msg))
  let report: PrescanReport
  try {
    report = await scan()
  }
  catch (e) {
    warn(`prescan crashed and was skipped: ${e instanceof Error ? e.message : String(e)}`)
    return { decision: 'proceed', report: null, crashed: true, informationOnlyFindings: 0 }
  }
  if (report.findings.length > 0)
    print(renderTerminalReport(report, { now: opts.now, ignoreFatal: opts.ignoreFatal }))
  const outcome = decideOutcome(report, { ignoreFatal: opts.ignoreFatal, failOnWarnings: opts.failOnWarnings, now: opts.now })
  let decision: 'proceed' | 'block'
  if (outcome === 'ask')
    decision = opts.interactive === false ? 'proceed' : await resolveWarningGate('ask', { silent: opts.silent })
  else
    decision = outcome
  return { decision, report, crashed: false, informationOnlyFindings: informationOnlyFindings(report, opts.now).length }
}
