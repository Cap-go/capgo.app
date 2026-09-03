import type { BentoTrackingPayload } from './tracking.ts'
import { greaterThan, tryParse } from '@std/semver'

/**
 * The CLI emits a `Bundle Incompatible` tracking event when a `bundle upload`'s
 * native dependencies don't match the version currently live on the channel.
 * PostHog records every such upload; this helper builds the Bento payload only
 * when the incompatible bundle actually went live — i.e. the upload overwrote
 * the channel's version (`channelOverwritten`) — so org admins are emailed only
 * when it can affect users. Delivery + email gating run through
 * `sendNotifToOrgMembers` via a dedicated preference key per event
 * (`bundle_incompatible` / `bundle_incompatible_expected`).
 * Mirrors `buildBuilderOnboardingBentoEvent`.
 */
export const BUNDLE_INCOMPATIBLE_EVENT = 'Bundle Incompatible'

/** Bento event for a native-breaking bundle that CAN reach outdated natives. */
export const BUNDLE_INCOMPATIBLE_BENTO_EVENT = 'bundle_incompatible'
/**
 * Bento event for a native-breaking bundle whose version bump follows the
 * channel's `disable_auto_update` strategy, so outdated natives never receive
 * it. The breaking change was done correctly — this is an informational mail,
 * not the crash warning.
 */
export const BUNDLE_INCOMPATIBLE_EXPECTED_BENTO_EVENT = 'bundle_incompatible_expected'

/** CLI tracking tags send booleans as `true` or the string `'true'`. */
export function isCliTrueTag(value: unknown): boolean {
  return value === true || value === 'true'
}

export type BundleIncompatibleEmailOutcome = 'skipped_accepted' | 'sent_expected' | 'sent'

/** PostHog `Bundle Incompatible Email` outcome recorded by `/private/events`. */
export function bundleIncompatibleEmailOutcome(
  incompatibilityAccepted: boolean,
  gatedByStrategy: boolean,
): BundleIncompatibleEmailOutcome {
  if (incompatibilityAccepted)
    return 'skipped_accepted'
  return gatedByStrategy ? 'sent_expected' : 'sent'
}

/**
 * Pure: does the channel's `disable_auto_update` strategy already keep this
 * bundle away from devices still running the previous (incompatible) native
 * build? Mirrors the update-gating rules in
 * `plugin_runtime/utils/update.ts`, comparing the new bundle name against the
 * previously live bundle name — the native version those devices still have.
 *
 * Fails closed: unparseable or missing versions (including a `version_number`
 * channel without a usable `min_update_version`) are treated as NOT gated so
 * the crash warning is emitted instead of the calmer "done correctly" mail.
 */
export function isBreakingChangeGatedByChannelStrategy(input: {
  strategy: string | null | undefined
  versionOldName: string | undefined
  versionNewName: string | undefined
  /** `min_update_version` of the new bundle, only used by `version_number`. */
  minUpdateVersion?: string | null
}): boolean {
  if (input.strategy !== 'major' && input.strategy !== 'minor' && input.strategy !== 'patch' && input.strategy !== 'version_number')
    return false

  const oldVersion = input.versionOldName ? tryParse(input.versionOldName) : undefined

  // `version_number` gates on the new bundle's `min_update_version` vs the
  // device's native version. A bundle whose minimum is not above the previous
  // (incompatible) version still reaches those devices, so only a strictly
  // greater minimum counts as gated.
  if (input.strategy === 'version_number') {
    const minVersion = input.minUpdateVersion ? tryParse(input.minUpdateVersion) : undefined
    if (!minVersion || !oldVersion)
      return false
    return greaterThan(minVersion, oldVersion)
  }

  const newVersion = input.versionNewName ? tryParse(input.versionNewName) : undefined
  if (!oldVersion || !newVersion)
    return false

  if (input.strategy === 'major')
    return newVersion.major > oldVersion.major
  if (input.strategy === 'minor')
    return newVersion.major !== oldVersion.major || newVersion.minor !== oldVersion.minor
  return newVersion.major !== oldVersion.major
    || newVersion.minor !== oldVersion.minor
    || newVersion.patch !== oldVersion.patch
}

export interface BundleCompatibilityBentoInput {
  /** The incoming tracking event name (must be 'Bundle Incompatible'). */
  event: string
  orgId: string | undefined
  appId: string | undefined
  /**
   * True only when the upload overwrote the channel's live version. The Bento
   * email is built only in that case; PostHog still records every incompatible
   * upload upstream.
   */
  channelOverwritten: boolean | undefined
  /** Channel the bundle was checked against. */
  channel: string | undefined
  /** Which flow emitted the event (currently always 'upload'). */
  source: string | undefined
  /** The freshly uploaded bundle (its id is resolved server-side). */
  versionNewId: string | undefined
  versionNewName: string | undefined
  /** Version that was live on the channel before this upload. */
  versionOldId: string | undefined
  versionOldName: string | undefined
  orgName: string | undefined
  appName: string | undefined
  /** The channel's `disable_auto_update` strategy, used to pick the event. */
  disableAutoUpdate: string | null | undefined
  /** `min_update_version` of the new bundle; gates the `version_number` strategy. */
  minUpdateVersion: string | null | undefined
  /**
   * True when the caller explicitly accepted this native incompatibility
   * (`--accept-incompatible` / console confirm). Skip the crash-warning email.
   */
  incompatibilityAccepted?: boolean
}

/**
 * Pure: decide whether this event should emit a Bento signal and build its
 * payload. Returns undefined when nothing should be emitted (wrong event name,
 * or missing org/app context).
 *
 * Two events: the crash warning when the strategy lets the bundle reach
 * outdated natives, and the calmer "expected" event when the version bump
 * follows the channel strategy so those devices stay on the old bundle.
 */
export function buildBundleCompatibilityBentoEvent(input: BundleCompatibilityBentoInput): BentoTrackingPayload | undefined {
  if (input.event !== BUNDLE_INCOMPATIBLE_EVENT)
    return undefined
  if (!input.orgId || !input.appId)
    return undefined
  // Email gate: only build a payload when the incompatible bundle actually went
  // live (the upload overwrote the channel's version). PostHog still records the
  // event upstream regardless of this.
  if (!input.channelOverwritten)
    return undefined
  // Caller marked the mismatch as handled (runtime plugin guards, etc.).
  // Still tracked in PostHog; do not email the crash warning.
  if (input.incompatibilityAccepted)
    return undefined

  const source = input.source ?? 'unknown'
  const channel = input.channel ?? ''
  const versionNewName = input.versionNewName ?? ''
  const versionOldName = input.versionOldName ?? ''

  const gated = isBreakingChangeGatedByChannelStrategy({
    strategy: input.disableAutoUpdate,
    versionOldName: input.versionOldName,
    versionNewName: input.versionNewName,
    minUpdateVersion: input.minUpdateVersion,
  })
  const event = gated ? BUNDLE_INCOMPATIBLE_EXPECTED_BENTO_EVENT : BUNDLE_INCOMPATIBLE_BENTO_EVENT

  return {
    event,
    // Dedicated key per event — independent from other bundle/OTA email
    // preferences, and opt-out of the warning stays separate from the calmer mail.
    preferenceKey: event,
    // Permanent per app+channel+version claim (no reopening cron window): repeated
    // incompatible uploads of the SAME version must not re-email org admins. A
    // genuinely new version has a different uniqId and notifies on its own.
    once: true,
    // Event-prefixed so the two signals never share a claim.
    uniqId: `${event}:${input.appId}:${channel}:${versionNewName || versionOldName}`,
    data: {
      disable_auto_update: input.disableAutoUpdate ?? '',
      gated,
      min_update_version: input.minUpdateVersion ?? '',
      org_id: input.orgId,
      org_name: input.orgName ?? '',
      app_id: input.appId,
      app_name: input.appName ?? '',
      channel,
      source,
      version_new_id: input.versionNewId ?? '',
      version_new_name: versionNewName,
      version_old_id: input.versionOldId ?? '',
      version_old_name: versionOldName,
    },
  }
}
