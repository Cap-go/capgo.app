import type { Json } from '~/types/database.types'
import { parseAppOnboardingLedger } from '~/utils/appOnboardingProgress'

// Mirrors apps.onboarding.cicd, written by record_app_cicd_setup (console) and
// record_app_cicd_deploy (backend, on a CI bundle upload or build request).
export interface CiCdSetupState {
  otaDetectedAt: string | null
  builderDetectedAt: string | null
  detectedVia: 'ci' | 'key' | null
  ciProvider: string | null
  keyCreatedAt: string | null
  markedDoneAt: string | null
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function timestamp(value: unknown) {
  return typeof value === 'string' && value ? value : null
}

export function parseCiCdSetupState(onboarding: unknown): CiCdSetupState {
  const cicd = record(record(onboarding).cicd)
  return {
    otaDetectedAt: timestamp(cicd.ota_detected_at),
    builderDetectedAt: timestamp(cicd.builder_detected_at),
    detectedVia: cicd.detected_via === 'ci' || cicd.detected_via === 'key' ? cicd.detected_via : null,
    ciProvider: typeof cicd.ci_provider === 'string' && cicd.ci_provider ? cicd.ci_provider : null,
    keyCreatedAt: timestamp(cicd.key_created_at),
    markedDoneAt: timestamp(cicd.marked_done_at),
  }
}

/** First CI evidence, or the user saying CI/CD already ships this app. */
export function ciCdDetectedAt(state: CiCdSetupState) {
  return [state.otaDetectedAt, state.builderDetectedAt].filter((value): value is string => !!value).sort()[0] ?? null
}

export function isCiCdSetupDone(onboarding: unknown) {
  const state = parseCiCdSetupState(onboarding)
  return !!ciCdDetectedAt(state) || !!state.markedDoneAt
}

function setupOutcome(onboarding: unknown) {
  const value = record(onboarding)
  const setup = record(value.setup)
  return typeof setup.outcome === 'string' ? setup.outcome : value.outcome
}

/**
 * The app already ships (a live update reached a device, a cloud build
 * succeeded, or its setup checklist completed), so automating releases is the
 * next useful step.
 */
export function isAppShipping(onboarding: unknown) {
  const features = parseAppOnboardingLedger(onboarding).features ?? {}
  return !!features.ota?.succeeded_at || !!features.builder?.succeeded_at || setupOutcome(onboarding) === 'completed'
}

/**
 * Sidebar rule: once Getting started is gone, a shipping app with no CI
 * evidence keeps a "Set up CI/CD" entry until CI uploads or builds once, or the
 * user marks it as already set up.
 */
export function shouldShowCiCdNav(onboarding: unknown, gettingStartedVisible: boolean) {
  return !gettingStartedVisible && isAppShipping(onboarding) && !isCiCdSetupDone(onboarding)
}

/** Optimistic local copy of what record_app_cicd_setup('marked_done') stores. */
export function withCiCdMarkedDone(onboarding: unknown, at = new Date().toISOString()): Json {
  const value = record(onboarding)
  const cicd = record(value.cicd)
  return { ...value, cicd: { ...cicd, marked_done_at: timestamp(cicd.marked_done_at) ?? at } } as Json
}
