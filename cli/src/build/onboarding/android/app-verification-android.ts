// src/build/onboarding/android/app-verification-android.ts
//
// Pure decision logic for the Android "verify Play Store app" onboarding step.
//
// A thin wrapper around the shared iOS `classifyAppVerification` classifier so
// the exact-match / wrong-build-id / no-app decision stays in one place across
// platforms. The Android-specific wrinkle is *multiple* Gradle applicationIds
// (build flavors): when more than one id is present without a single clean
// match we force the picker (`multi-gradle`) rather than guessing.

import type { AscAppLike } from '../app-verification.js'
import { classifyAppVerification } from '../app-verification.js'

/** Minimal shape of a Play Store app needed for reconciliation. */
export interface PlayAppLike {
  packageName: string
  displayName: string
}

/**
 * Reconcile outcome for the Android package-select step.
 *
 * - `exact-match`     — a Play app's `packageName` == a single clean Gradle id.
 *                       Auto-confirm, no picker. Carries the matched package.
 * - `wrong-build-id`  — apps exist but the build id matches none → Path A picker.
 * - `no-app`          — no Play apps at all → Path B (create the app).
 * - `multi-gradle`    — several Gradle flavors and no clean single match → force
 *                       the picker so the user disambiguates.
 */
export type AndroidReconcileResult
  = | { kind: 'exact-match', packageName: string }
    | { kind: 'wrong-build-id' }
    | { kind: 'no-app' }
    | { kind: 'multi-gradle' }

export interface ReconcileAndroidAppInput {
  /** Every distinct `applicationId` found in the project's Gradle files (≥0). */
  gradleIds: string[]
  /** Apps that actually exist in the user's Play Console. */
  apps: PlayAppLike[]
}

/**
 * Pure reconciliation of the Android app-existence invariant.
 *
 * The common Capacitor case is a single Gradle id, which defers entirely to the
 * shared iOS classifier (`packageName` ↦ `bundleId`). Android has no
 * Developer-portal registration split, so both iOS `no-app-*` results collapse
 * to a single `no-app` route.
 *
 * Multiple Gradle ids are handled here: exactly one matching a Play app is
 * still a clean single match (`exact-match`); zero apps is `no-app`; anything
 * else forces the picker (`multi-gradle`).
 */
export function reconcileAndroidApp(input: ReconcileAndroidAppInput): AndroidReconcileResult {
  const { gradleIds, apps } = input

  // Map Play apps onto the shared classifier's shape so the decision stays
  // shared with iOS.
  const ascApps: AscAppLike[] = apps.map(a => ({ bundleId: a.packageName, name: a.displayName }))

  // Single Gradle id (or none): defer to the shared iOS classifier.
  if (gradleIds.length <= 1) {
    const releaseBundleId = gradleIds[0] ?? ''
    // Defensive: with no usable Gradle id there is nothing to match — never
    // let an empty string "exact-match" (e.g. a malformed Play row that lost
    // its packageName). Apps exist → the enriched picker (wrong-build-id);
    // none → Path B (no-app).
    if (!releaseBundleId)
      return apps.length > 0 ? { kind: 'wrong-build-id' } : { kind: 'no-app' }
    const { result } = classifyAppVerification({
      releaseBundleId,
      apps: ascApps,
      registeredBundleIds: [],
    })
    if (result === 'exact-match')
      return { kind: 'exact-match', packageName: releaseBundleId }
    if (result === 'wrong-build-id')
      return { kind: 'wrong-build-id' }
    // no-app-identifier-exists / no-app-unregistered → Android has no portal
    // registration split, so both collapse to a single no-app route.
    return { kind: 'no-app' }
  }

  // Multiple Gradle flavors. Exactly one matching a Play app is still a clean
  // single match → auto-confirm; otherwise force the picker.
  const matchedIds = gradleIds.filter(id => ascApps.some(a => a.bundleId === id))
  if (matchedIds.length === 1)
    return { kind: 'exact-match', packageName: matchedIds[0] }

  if (apps.length === 0)
    return { kind: 'no-app' }

  return { kind: 'multi-gradle' }
}
