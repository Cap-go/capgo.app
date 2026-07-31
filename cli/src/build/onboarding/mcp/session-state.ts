// src/build/onboarding/mcp/session-state.ts
//
// Cross-call carried-state registry for the MCP-conducted onboarding.
//
// The TUI keeps each flow's transient "carried" state in React refs/state for
// the lifetime of the Ink process. The MCP server is the headless equivalent:
// the stdio server process is long-lived, but each onboarding step arrives as a
// separate tool call. This module is where the granular iOS path and the MCP
// tail park their carried transients BETWEEN tool calls, keyed by appId —
// mirroring the oauth-session.ts pending-session registry.
//
// The carried shapes are imported from the flow engines (the single source of
// truth): `IosEffectDeps['carried']` (certData/profileData/teamId/p8Content/
// importedP12Password/picker guards/verify* gate fields/...) and
// `TailEffectDeps['carried']` (savedCredentials/ciSecretEntries/
// ciSecretExistingKeys/workflowIsNew).
//
// Lifecycle per appId:
//   getSession(appId)            → { iosCarried, tailCarried } (created empty on demand)
//   mergeIosCarried(appId, p)    → shallow-merge p into iosCarried (undefined values skipped)
//   mergeTailCarried(appId, p)   → shallow-merge p into tailCarried (undefined values skipped)
//   clearSession(appId)          → drop the entry (idempotent)
//   clearAllSessions()           → drop everything (test isolation)
//
// INVARIANTS — consumers (engine S6/S8 wiring, MCP tail) MUST respect these:
//
//  - State is PROCESS-LOCAL. A server restart loses every session. Consumers
//    MUST degrade gracefully when carried state is absent (the flow engines
//    self-heal: re-derive from progress.json, re-read the .p8 from p8Path,
//    re-scan identities, ...). NEVER crash on a missing carried field.
//
//  - Carried state holds SECRETS (p8Content key bytes, importedP12Password,
//    savedCredentials, ciSecretEntries values). They live ONLY in this
//    process-local registry: they must NEVER serialize into MCP tool results,
//    progress.json, or logs. Tool-result builders must whitelist fields, never
//    spread carried state.
//
//  - Merges are IMMUTABLE: each merge produces a NEW carried object; a
//    previously captured snapshot (a getSession() return) is never mutated.
//    Read fresh via getSession() after any merge.

import type { CiSecretSetupAdvice, CiSecretTarget } from '../ci-secrets.js'
import type { IosEffectDeps } from '../ios/flow.js'
import type { TailEffectDeps } from '../tail/flow.js'
import type { OnboardingStep } from '../types.js'
import type { Platform } from './contract.js'
import type { AppflowProgress } from '../appflow/types.js'

/**
 * The iOS driver-held transient state — the exact `IosEffectDeps['carried']`
 * shape, plus the MCP-only `parkedImportStep` (S12): the interactive import
 * sub-flow prompt the driver parked between tool calls — the headless mirror
 * of the TUI's React `step` state for the EPHEMERAL import prompts, which
 * resume routing can never reproduce (see engine.ts iosParkedStep). NON-SECRET
 * (a step name). Wiped with the session; a restart self-heals via a fresh
 * import-scanning that re-derives the inventory and re-renders the picker.
 */
export type IosCarried = NonNullable<IosEffectDeps['carried']> & {
  parkedImportStep?: OnboardingStep
  /**
   * The chosen identity's Apple cert resource id (import-checking-apple-cert's
   * transient — typed on IosStepCtx, not on the engine's carried shape). The
   * registry really holds it after the transient merge; typing it here lets
   * the driver DROP it when the user re-picks a different identity (the TUI
   * clears its appleCertId mirror the same way). NON-SECRET (an Apple id).
   */
  _appleCertIdForChosen?: string
}
/**
 * The tail driver-held transient state — the exact `TailEffectDeps['carried']`
 * shape, plus the NON-SECRET tail OUTCOME facts the outcome-aware terminal
 * summary harvests (engine.ts harvestTailOutcomes → tailCompleteResult): the
 * exact upload summary line (counts/labels only), the written workflow path
 * and the exported .env path. These three are non-secret BY CONSTRUCTION and
 * are the one carried subset allowed to surface verbatim in a tool result —
 * secret VALUES (savedCredentials / ciSecretEntries) must still never leave
 * this registry.
 */
export type TailCarried = NonNullable<TailEffectDeps['carried']> & {
  ciSecretUploadSummary?: string
  workflowFilePath?: string
  envExportPath?: string
}

/**
 * S9-S11: the MCP's parked interactive TAIL step + the NON-SECRET view context
 * it was rendered with (option inventories / labels — never credential values).
 * The TUI holds the current tail step in React state; the MCP mirrors it here so
 * (a) the strict tail gate validates an answer against the step that actually
 * asked, and (b) a re-render (corrective message, plain re-check) re-asks the
 * SAME parked question instead of drifting forward through the resume router —
 * which would collapse past consent gates like preview-workflow-file. A server
 * restart loses the park; resume routing then takes over (the frozen
 * tailResumeStep contract). EXPLICITLY NO SECRETS: ciSecretEntries (values)
 * stay in tailCarried; only derived key NAMES may surface in tool results.
 */
export interface TailParkedState {
  step: string
  ciSecretTargets?: CiSecretTarget[]
  ciSecretSetupAdvice?: CiSecretSetupAdvice[]
  ciSecretRepoLabel?: string | null
  ciSecretError?: string
  availableScripts?: Record<string, string>
  recommendedScript?: string | null
}

export interface OnboardingSessionState {
  iosCarried: IosCarried
  tailCarried: TailCarried
  tailParked?: TailParkedState
  /**
   * The platform this session is setting up, as CHOSEN by the user (platform
   * picker answer / single-platform auto-route / explicit `{ platform }`), NOT
   * inferred from on-disk progress. This is what lets a bare `next_step({})`
   * resume the right platform AND lets two concurrent server processes onboard
   * the same app for different platforms without reading each other's progress
   * files. Process-local: a restart loses it and the flow re-asks the picker.
   */
  activePlatform?: Platform
  /**
   * The platform whose continue-vs-restart resume prompt has already been
   * resolved THIS session — shown and answered, or skipped as unnecessary (no
   * resumable on-disk progress). While it differs from the committed platform, a
   * fresh platform entry first shows the resume prompt (mirroring the TUI's
   * `resume-prompt` fork) instead of silently resuming. Process-local: a restart
   * loses it and the prompt is re-offered. Reset by runStart so a fresh "start
   * onboarding" always re-asks.
   */
  resumeResolvedFor?: Platform
  /**
   * The Appflow migration's in-flight progress (token, org/app selection, the
   * per-platform mapped Capgo creds collected so far, completed steps, and the
   * migration-entry gate answer). The appflow flow is driven through the neutral
   * PlatformFlow contract and — unlike ios/android — has no on-disk progress
   * loader, so its cross-call state lives here, process-local, exactly like the
   * iOS/tail carried transients. HOLDS SECRETS (token, cert/keystore bytes,
   * service-account JSON, app-specific password): it must NEVER serialize into a
   * tool result / progress.json / log. A server restart loses it and the
   * migration re-runs from the explain step (the flow self-heals via the token
   * cache). NON-PERSISTED by design.
   */
  appflowProgress?: AppflowProgress
  /**
   * The one-time "Are you migrating from Ionic Appflow?" gate answer for a
   * single-platform (ios/android) entry. Set once the user answers so a resume /
   * bare next_step never re-prompts. NON-SECRET (a yes/no decision).
   */
  appflowGate?: 'asked-yes' | 'asked-no'
}

const registry = new Map<string, OnboardingSessionState>()

/**
 * Shallow-merge `partial` into `base`, returning a NEW object. Keys whose
 * value is `undefined` are skipped so they leave the prior value intact —
 * callers can pass effect transients straight through without first stripping
 * the fields the effect did not produce.
 */
function mergeDefined<T extends object>(base: T, partial: Partial<T>): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined)
      next[key] = value
  }
  return next as T
}

/**
 * Get the session state for `appId`, creating an empty one on demand.
 * The returned object is the current SNAPSHOT: merges replace the carried
 * objects rather than mutating them, so re-read after merging.
 */
export function getSession(appId: string): OnboardingSessionState {
  const existing = registry.get(appId)
  if (existing)
    return existing
  const created: OnboardingSessionState = { iosCarried: {}, tailCarried: {} }
  registry.set(appId, created)
  return created
}

/**
 * Read the platform this session committed to (via setSessionPlatform), or
 * undefined when none has been chosen yet (fresh session, or after a restart).
 * Deliberately does NOT consult disk progress — the platform is a session
 * decision, not a property of what happens to be saved on disk.
 */
export function getSessionPlatform(appId: string): Platform | undefined {
  return registry.get(appId)?.activePlatform
}

/**
 * Record (or, with `undefined`, clear) the platform this session is setting up.
 * Called when the user picks at the platform gate, when a single-platform
 * project auto-routes, or on any explicit `{ platform }`. Cleared by runStart so
 * a fresh "start onboarding" always re-asks instead of silently resuming.
 */
export function setSessionPlatform(appId: string, platform: Platform | undefined): void {
  const session = getSession(appId)
  registry.set(appId, { ...session, activePlatform: platform })
}

/**
 * Read which platform's resume prompt has already been resolved this session
 * (shown+answered, or determined unnecessary), or undefined when none has.
 * Process-local; deliberately ignores disk — the resume decision is a session
 * decision, exactly like the platform itself.
 */
export function getResumeResolvedFor(appId: string): Platform | undefined {
  return registry.get(appId)?.resumeResolvedFor
}

/**
 * Record (or, with `undefined`, clear) which platform's continue-vs-restart
 * resume prompt has been resolved this session. Set once the prompt is answered
 * or skipped as unnecessary; cleared by runStart so a fresh start re-asks.
 */
export function setResumeResolvedFor(appId: string, platform: Platform | undefined): void {
  const session = getSession(appId)
  registry.set(appId, { ...session, resumeResolvedFor: platform })
}

/** Read the in-flight Appflow migration progress for `appId`, or undefined when none. */
export function getAppflowProgress(appId: string): AppflowProgress | undefined {
  return registry.get(appId)?.appflowProgress
}

/** Store (or, with `undefined`, clear) the in-flight Appflow migration progress for `appId`. */
export function setAppflowProgress(appId: string, progress: AppflowProgress | undefined): void {
  const session = getSession(appId)
  registry.set(appId, { ...session, appflowProgress: progress })
}

/** Read the one-time "migrating from Appflow?" gate answer for `appId`, or undefined when unasked. */
export function getAppflowGate(appId: string): 'asked-yes' | 'asked-no' | undefined {
  return registry.get(appId)?.appflowGate
}

/** Record the one-time "migrating from Appflow?" gate answer for `appId`. */
export function setAppflowGate(appId: string, gate: 'asked-yes' | 'asked-no' | undefined): void {
  const session = getSession(appId)
  registry.set(appId, { ...session, appflowGate: gate })
}

/**
 * Drop the per-flow carried transients (iOS carried, tail carried, tail park)
 * for `appId` while PRESERVING the session-level decisions (activePlatform,
 * resumeResolvedFor). Used by the resume prompt's "restart" arm: the on-disk
 * progress is wiped, so the in-memory carried state from the old run must go
 * too — but the session stays committed to the same platform and must not
 * re-ask the resume prompt it just answered. Immutable: builds a NEW entry.
 */
export function clearSessionCarried(appId: string): void {
  const existing = registry.get(appId)
  if (!existing)
    return
  registry.set(appId, {
    iosCarried: {},
    tailCarried: {},
    activePlatform: existing.activePlatform,
    resumeResolvedFor: existing.resumeResolvedFor,
  })
}

/**
 * Merge `partial` into the iOS carried state for `appId` and return the new
 * merged carried object. `undefined` values leave the prior value intact.
 */
export function mergeIosCarried(appId: string, partial: Partial<IosCarried>): IosCarried {
  const session = getSession(appId)
  const iosCarried = mergeDefined(session.iosCarried, partial)
  registry.set(appId, { ...session, iosCarried })
  return iosCarried
}

/**
 * Merge `partial` into the tail carried state for `appId` and return the new
 * merged carried object. `undefined` values leave the prior value intact.
 */
export function mergeTailCarried(appId: string, partial: Partial<TailCarried>): TailCarried {
  const session = getSession(appId)
  const tailCarried = mergeDefined(session.tailCarried, partial)
  registry.set(appId, { ...session, tailCarried })
  return tailCarried
}

/**
 * Park the current interactive tail step (+ its non-secret view context) for
 * `appId`. REPLACES any prior park — each render re-parks the step it shows,
 * so the park always mirrors the question currently in front of the user.
 * Immutable: builds a NEW session entry; prior snapshots are untouched.
 */
export function setTailParked(appId: string, parked: TailParkedState): void {
  const session = getSession(appId)
  registry.set(appId, { ...session, tailParked: parked })
}

/**
 * Drop `keys` from the iOS carried state for `appId` and return the new
 * carried object. The complement of mergeIosCarried for one-shot consumable
 * fields (e.g. the verify-app `verifyAction` pick, which the driver MUST clear
 * after the resolver effect ran so a later re-entry runs the initial fetch —
 * merge semantics skip `undefined`, so a merge can never clear). Immutable:
 * builds a NEW carried object; prior snapshots are untouched.
 */
export function dropIosCarried(appId: string, keys: (keyof IosCarried)[]): IosCarried {
  const session = getSession(appId)
  const iosCarried: Record<string, unknown> = { ...(session.iosCarried as Record<string, unknown>) }
  for (const key of keys)
    delete iosCarried[key as string]
  registry.set(appId, { ...session, iosCarried: iosCarried as IosCarried })
  return iosCarried as IosCarried
}

/**
 * Drop the session entry for `appId`. Idempotent: safe on an absent appId and
 * safe to call twice. The next getSession() recreates a fresh empty session.
 */
export function clearSession(appId: string): void {
  registry.delete(appId)
}

/** Drop every session (test isolation only — production code clears per appId). */
export function clearAllSessions(): void {
  registry.clear()
}
