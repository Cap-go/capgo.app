// Appflow → shared build/CI tail adapter.
//
// The Appflow migration flow ends at `handoff-build` (a choice: 'build' | 'skip').
// On 'build' the flow REUSES the existing onboarding "tail" (the platform-neutral
// build + CI/CD state machine in ../tail/flow.ts) inline, exactly as the iOS and
// Android drivers do — no new build/CI architecture. This module is the appflow
// counterpart of ios/flow.ts's `toTailDeps` + `buildIosSavedCredentials`: it
// builds a `TailEffectDeps` for the chosen platform from the SAME shared CLI
// building blocks the native drivers inject (createCiSecretEntries, requestBuildInternal,
// generateWorkflow, writeWorkflowFile, getPackageScripts, findProjectType, …) and
// supplies the saved-credential SHAPE straight from the already-mapped per-platform
// Capgo creds the migration collected (progress.ios / progress.android).
//
// The appflow flow does NOT keep an on-disk progress.json (it is process/React
// state only), so the persistence deps are thin: loadProgress always resolves
// null (no self-heal target — the build runs from in-memory state), and
// save/delete are no-ops. updateSavedCredentials reuses the real credential store
// (the same path persistAppflowCredentials writes), so the migrated creds are
// written by the tail's `saving-credentials` step too — idempotent with the
// finish-time persist.
import {
  createCiSecretEntries,
  detectCiSecretTargets,
  getCiSecretRepoLabelAsync,
  listExistingCiSecretKeysAsync,
  uploadCiSecretsAsync,
} from '../ci-secrets.js'
import { defaultExportPath, exportCredentialsToEnv } from '../env-export.js'
import { generateWorkflow } from '../workflow-generator.js'
import { writeWorkflowFile } from '../workflow-writer.js'
import { requestBuildInternal } from '../../request.js'
import { updateSavedCredentials } from '../../credentials.js'
import { appendInternalLog } from '../../../support/internal-log.js'
import { findBuildCommandForProjectType, findProjectType, findSavedKeySilent, getPackageScripts } from '../../../utils.js'
import type { BuildLogger } from '../../request.js'
import type { TailEffectDeps } from '../tail/flow.js'
import type { AppflowProgress } from './types.js'

/**
 * The tail-facing progress shape. The shared tail reads `appId` (required),
 * plus the tail-input fields the appflow driver records on `AppflowProgress`
 * (setupMode / ciSecretTarget / selectedPackageManager / buildScriptChoice /
 * envExportTargetPath). `AppflowProgress` carries every one of those as an
 * optional field, so it satisfies `TailEffectProgress` once `appId` is present.
 */
export type AppflowTailProgress = AppflowProgress & { appId: string }

/**
 * Build the saved-credential SHAPE for the chosen platform from the migrated
 * Capgo creds. The migration already mapped Appflow's signing/distribution into
 * the Capgo field names (progress.ios / progress.android are Record<string,string>),
 * so the "build" here is just selecting the right platform map. Throws on an empty
 * map — the same fail-fast guard the native builders use.
 */
export function buildAppflowSavedCredentials(progress: AppflowTailProgress, platform: 'ios' | 'android'): Record<string, string> {
  const creds = platform === 'ios' ? progress.ios : progress.android
  if (!creds || Object.keys(creds).length === 0)
    throw new Error(`No ${platform} credentials were migrated from Appflow.`)
  return { ...creds }
}

/** Build-request logger streaming sink — forwards each line to onBuildOutput. */
function makeTailBuildLogger(onLine: (line: string) => void): BuildLogger {
  return {
    info: (msg: string) => onLine(msg),
    error: (msg: string) => onLine(`✖ ${msg}`),
    warn: (msg: string) => onLine(`⚠ ${msg}`),
    success: (msg: string) => onLine(`✔ ${msg}`),
    buildLog: (msg: string) => onLine(msg),
    uploadProgress: (percent: number) => onLine(`Uploading: ${percent.toFixed(0)}%`),
    customMsg: (_kind: string, _data: Record<string, unknown>) => {},
  }
}

export interface AppflowTailDepsOptions {
  /** Capgo API key flag (overrides the saved key, like the native drivers). */
  apikey?: string
  /** Gateway override threaded into the build request options. */
  supaHost?: string
  /** Builder journey id threaded into the build request options. */
  journeyId?: string
  /** Build VIEWER sink — every requesting-build line streams here (fullscreen pane). */
  onBuildOutput?: (line: string) => void
  /** Side-log sink (✔ Credentials saved, ✔ Uploaded …). */
  onLog?: (message: string, color?: string) => void
  /** The driver-held transient threaded back into each effect (NEVER persisted). */
  carried?: TailEffectDeps<AppflowTailProgress>['carried']
  signal?: AbortSignal
}

/**
 * Adapt the appflow flow's collected state into a platform-neutral
 * `TailEffectDeps` for `platform`, reusing the SAME shared CLI building blocks
 * the iOS/Android drivers inject. Mirrors ios/flow.ts's `toTailDeps` 1:1; the
 * only appflow-specific pieces are the credential SHAPE (selected straight from
 * the migrated maps) and the thin no-disk persistence (the migration keeps no
 * progress.json).
 */
export function toAppflowTailDeps(
  platform: 'ios' | 'android',
  options: AppflowTailDepsOptions = {},
): TailEffectDeps<AppflowTailProgress> {
  const resolveCapgoKey = (): string | undefined => options.apikey ?? findSavedKeySilent()
  const onBuildOutput = options.onBuildOutput
  return {
    platform,
    buildSavedCredentials: p => buildAppflowSavedCredentials(p, platform),
    // Lossy rebuild: the migrated map IS the credential map, so a "rebuild" just
    // re-selects it. Returns {} when the platform map is absent (matches the
    // native lossy-rebuild contract — never throws).
    rebuildTailCredentials: (p) => {
      const creds = platform === 'ios' ? p.ios : p.android
      return creds && Object.keys(creds).length > 0 ? { ...creds } : {}
    },
    // The appflow tail has NO on-disk progress to resume from, so the self-heal
    // resolver always reports the current step (no divert target).
    resumeStep: () => 'saving-credentials',

    // ── persistence (thin — no progress.json for the migration) ──
    updateSavedCredentials,
    loadProgress: async () => null,
    saveProgress: async () => {},
    deleteProgress: async () => {},

    // ── shared tail helpers (reuse the native CLI building blocks) ──
    createCiSecretEntries: creds => createCiSecretEntries(creds, resolveCapgoKey()),
    detectCiSecretTargets,
    getCiSecretRepoLabelAsync,
    listExistingCiSecretKeysAsync,
    uploadCiSecretsAsync,
    exportCredentialsToEnv,
    defaultExportPath,
    generateWorkflow,
    writeWorkflowFile,
    requestBuildInternal: (id, opts, silent, logger) =>
      requestBuildInternal(id, { ...opts, supaHost: options.supaHost, builderJourneyId: options.journeyId }, silent, logger),
    getPackageScripts,
    findProjectType,
    findBuildCommandForProjectType,
    resolveApikey: resolveCapgoKey,

    // ── streaming sinks ──
    logger: onBuildOutput ? makeTailBuildLogger(onBuildOutput) : undefined,
    onBuildOutput,
    onLog: options.onLog,
    onInternalLog: (line: string) => appendInternalLog(line),

    carried: options.carried,
    signal: options.signal,
  }
}
