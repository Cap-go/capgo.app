// src/build/prescan/types.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/supabase.types'
import type { CapacitorConfig } from '../../schemas/config'

export type Severity = 'error' | 'warning' | 'info'
export type Platform = 'ios' | 'android'

export interface Finding {
  id: string
  severity: Severity
  /** Finding stays visible but is information-only until this UTC instant. */
  enforceAfter?: string
  /**
   * detail/fix/title are printed to the terminal and serialized into --json reports
   * (routinely captured in CI logs): they must NEVER contain credential material
   * (passwords, key/cert contents, raw credential field values).
   */
  title: string
  detail?: string
  fix?: string
  docsUrl?: string
}

export interface ScanContext {
  appId: string
  platform: Platform
  /** Operating system running the prescan, used for host-specific local checks. */
  hostPlatform: NodeJS.Platform
  projectDir: string
  config?: CapacitorConfig
  /** merged credentials, env-var style keys (BUILD_CERTIFICATE_BASE64, ANDROID_KEYSTORE_FILE, ...) */
  credentials?: Record<string, string>
  distributionMode?: 'app_store' | 'ad_hoc'
  androidFlavor?: string
  apikey?: string
  supabase?: SupabaseClient<Database>
}

export interface PrescanCheck {
  id: string
  platforms: Platform[]
  /** Findings from this check stay information-only until this UTC instant. */
  enforceAfter?: string
  /** requires ctx.supabase; skipped (with notice) when absent */
  remote?: boolean
  appliesTo?: (ctx: ScanContext) => boolean
  run: (ctx: ScanContext) => Promise<Finding[]>
}

export interface PrescanReport {
  findings: Finding[]
  counts: Record<Severity, number>
  skippedRemote: number
  durationMs: number
  checksRun: number
}

export type PrescanOutcome = 'proceed' | 'ask' | 'block'

export interface OutcomeOptions {
  failOnWarnings?: boolean
  ignoreFatal?: boolean
  /** Test seam for hard-coded rollout deadlines; defaults to the current time. */
  now?: Date
}
