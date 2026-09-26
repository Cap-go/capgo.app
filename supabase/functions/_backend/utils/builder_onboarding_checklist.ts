import type { Context } from 'hono'
import type { AppOnboardingBuilderStepId, AppOnboardingBuilderStepState, AppOnboardingPatch } from './appOnboarding.ts'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { TrackOptions } from './tracking.ts'
import { emitCommittedAppOnboardingHistory, emitCommittedSystemAppOnboardingHistory } from './app_onboarding_posthog.ts'
import { applyAppOnboardingPatch } from './appOnboarding.ts'
import { persistAppOnboardingMutation, persistAuthorizedOnboardingMutation } from './appOnboardingMutation.ts'
import { cloudlogErr, serializeError } from './logging.ts'

type BuilderChecklistStatus = 'pending' | 'done' | 'skipped' | 'warning'
type BuilderChecklistAnnotationType = 'note' | 'warning'
type IosBuilderStep = 'start_setup' | 'choose_destination' | 'connect_app_store' | 'prepare_certificate' | 'prepare_profile'

export type BuilderChecklistUpdate = {
  platform: 'ios'
  step: IosBuilderStep
  status: BuilderChecklistStatus
  annotation?: string
  annotationType?: BuilderChecklistAnnotationType
} | {
  platform: 'android'
  step: 'start_setup'
  status: 'done'
  annotation?: never
  annotationType?: never
} | {
  platform: 'ios' | 'android'
  step: 'successful_cloud_build'
  status: 'done' | 'warning'
  annotation?: string
  annotationType?: BuilderChecklistAnnotationType
}

export interface BuilderBuildOutcome {
  appId: string
  platform: 'ios' | 'android'
  status: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function destinationUpdate(tags: Record<string, string | number | boolean>): BuilderChecklistUpdate | null {
  if (tags.action === 'question_skipped'
    && tags.question_id === 'ios_setup_method'
    && tags.choice === 'create-new'
    && tags.reason === 'non_macos_auto_create_new') {
    return { platform: 'ios', step: 'choose_destination', status: 'skipped', annotation: 'asc_new_auto', annotationType: 'note' }
  }

  if (tags.action !== 'question_answered')
    return null
  if (tags.question_id === 'ios_setup_method') {
    if (tags.choice === 'create-new')
      return { platform: 'ios', step: 'choose_destination', status: 'done', annotation: 'asc_new', annotationType: 'note' }
    if (tags.choice === 'import-existing')
      return { platform: 'ios', step: 'choose_destination', status: 'pending' }
    return null
  }
  if (tags.question_id !== 'ios_import_distribution')
    return null

  const annotations: Record<string, string> = {
    app_store: 'import_app_store',
    ad_hoc: 'import_ad_hoc',
    switch_to_create_new: 'asc_new',
  }
  const annotation = typeof tags.choice === 'string' ? annotations[tags.choice] : undefined
  return annotation
    ? { platform: 'ios', step: 'choose_destination', status: 'done', annotation, annotationType: 'note' }
    : null
}

function appStoreUpdate(tags: Record<string, string | number | boolean>): BuilderChecklistUpdate | null {
  if (tags.credential !== 'ios_app_store_connect_api_key')
    return null
  if (tags.action === 'credential_verified')
    return { platform: 'ios', step: 'connect_app_store', status: 'done' }
  if (tags.action === 'credential_verification_failed' && (tags.source === 'guided_helper' || tags.source === 'cli_verifier')) {
    return {
      platform: 'ios',
      step: 'connect_app_store',
      status: 'warning',
      annotation: 'asc_key_verification_failed',
      annotationType: 'warning',
    }
  }
  return null
}

function certificateUpdate(tags: Record<string, string | number | boolean>): BuilderChecklistUpdate | null {
  if (tags.source !== 'created' && tags.source !== 'keychain_import')
    return null
  if (tags.action === 'certificate_prepared')
    return { platform: 'ios', step: 'prepare_certificate', status: 'done' }
  if (tags.action !== 'certificate_preparation_failed')
    return null

  const annotations: Record<string, string> = {
    create_failed: 'ios_certificate_creation_failed',
    certificate_limit: 'ios_certificate_limit_reached',
    export_failed: 'ios_certificate_export_failed',
  }
  const annotation = typeof tags.reason === 'string' ? annotations[tags.reason] : undefined
  return annotation
    ? { platform: 'ios', step: 'prepare_certificate', status: 'warning', annotation, annotationType: 'warning' }
    : null
}

function profileUpdate(tags: Record<string, string | number | boolean>): BuilderChecklistUpdate | null {
  if (tags.action !== 'profile_prepared'
    || typeof tags.app_id !== 'string' || !tags.app_id.trim()
    || typeof tags.attempt_id !== 'string' || !tags.attempt_id.trim()
    || typeof tags.journey_id !== 'string' || !tags.journey_id.trim()) {
    return null
  }

  const validCreatedStep = tags.source === 'created'
    && (tags.step === 'creating-profile' || tags.step === 'import-create-profile-only')
  const validImportedStep = tags.source === 'imported' && tags.step === 'import-exporting'
  return validCreatedStep || validImportedStep
    ? { platform: 'ios', step: 'prepare_profile', status: 'done' }
    : null
}

function startSetupUpdate(tags: Record<string, string | number | boolean>): BuilderChecklistUpdate | null {
  const platform = tags.platform
  if (tags.action !== 'start_setup'
    || tags.source !== 'cli'
    || typeof tags.app_id !== 'string' || !tags.app_id
    || typeof tags.journey_id !== 'string' || !tags.journey_id
    || typeof tags.step !== 'string' || !tags.step
    || (platform !== 'ios' && platform !== 'android')) {
    return null
  }
  return platform === 'ios'
    ? { platform: 'ios', step: 'start_setup', status: 'done' }
    : { platform: 'android', step: 'start_setup', status: 'done' }
}

export function getBuilderChecklistUpdateFromAnalytics(event: Pick<TrackOptions, 'channel' | 'event' | 'tags'>): BuilderChecklistUpdate | null {
  if (event.channel !== 'builder-onboarding' || event.event !== 'Builder Onboarding Action' || !event.tags)
    return null
  if (event.tags.action === 'start_setup')
    return startSetupUpdate(event.tags)
  if (event.tags.platform !== 'ios')
    return null
  return destinationUpdate(event.tags) ?? appStoreUpdate(event.tags) ?? certificateUpdate(event.tags) ?? profileUpdate(event.tags)
}

export function applyBuilderChecklistUpdate(
  onboarding: unknown,
  update: BuilderChecklistUpdate,
  now = () => new Date().toISOString(),
): Record<string, unknown> | null {
  const patch = buildBuilderChecklistPatch(onboarding, update, now)
  return patch ? applyAppOnboardingPatch(onboarding, patch, now) : null
}

export function getBuilderBuildOutcomeUpdate(platform: 'ios' | 'android', status: string): BuilderChecklistUpdate | null {
  if (status === 'succeeded' || status === 'released')
    return { platform, step: 'successful_cloud_build', status: 'done' }
  if (status === 'failed')
    return { platform, step: 'successful_cloud_build', status: 'warning', annotation: 'cloud_build_failed', annotationType: 'warning' }
  return null
}

export function buildBuilderBuildOutcomePatch(
  onboarding: unknown,
  outcomes: Array<Pick<BuilderBuildOutcome, 'platform' | 'status'>>,
  now = () => new Date().toISOString(),
): AppOnboardingPatch | null {
  const builderSteps: NonNullable<AppOnboardingPatch['builderSteps']> = {}
  const at = now()
  for (const outcome of outcomes) {
    const update = getBuilderBuildOutcomeUpdate(outcome.platform, outcome.status)
    if (!update)
      continue
    const patch = buildBuilderChecklistPatch(onboarding, update, () => at)
    Object.assign(builderSteps, patch?.builderSteps)
  }
  return Object.keys(builderSteps).length ? { builderSteps } : null
}

function buildBuilderChecklistPatch(
  onboarding: unknown,
  update: BuilderChecklistUpdate,
  now = () => new Date().toISOString(),
): AppOnboardingPatch | null {
  if (!isRecord(onboarding) || !isRecord(onboarding.setup))
    return null
  const setup = onboarding.setup
  if (setup.todo_list_version !== 4
    || setup.builder_todo_list_version !== '1'
    || !Array.isArray(setup.paths)
    || !setup.paths.includes('builder')
    || setup.outcome === 'skipped'
    || !isRecord(setup.steps)) {
    return null
  }
  const stepPaths = setup.steps
  const builder = stepPaths.builder
  if (!isRecord(builder))
    return null
  const platform = builder[update.platform]
  if (!isRecord(platform))
    return null
  const currentStep = platform[update.step]
  if (!isRecord(currentStep) || (currentStep.status === 'done' && update.status === 'warning'))
    return null

  const nextStep: Record<string, unknown> = { ...currentStep, status: update.status }
  if (update.status === 'pending') {
    delete nextStep.at
    delete nextStep.annotation
    delete nextStep.annotation_type
  }
  else {
    nextStep.at = now()
    if (update.annotation)
      nextStep.annotation = update.annotation
    else
      delete nextStep.annotation
    if (update.annotationType)
      nextStep.annotation_type = update.annotationType
    else
      delete nextStep.annotation_type
  }

  const comparableCurrent = { ...currentStep }
  if (update.status !== 'pending' && typeof comparableCurrent.at === 'string')
    comparableCurrent.at = nextStep.at
  if (JSON.stringify(comparableCurrent) === JSON.stringify(nextStep))
    return null

  const stepId = `builder.${update.platform}.${update.step}` as AppOnboardingBuilderStepId
  const annotationType = nextStep.annotation_type === 'note' || nextStep.annotation_type === 'warning' ? nextStep.annotation_type : undefined
  const stepPatch: AppOnboardingBuilderStepState = {
    status: update.status,
    ...(typeof nextStep.at === 'string' ? { at: nextStep.at } : {}),
    ...(typeof nextStep.annotation === 'string' ? { annotation: nextStep.annotation } : {}),
    ...(annotationType ? { annotationType } : {}),
  }
  return {
    builderSteps: {
      [stepId]: stepPatch,
    },
  }
}

export async function markBuilderChecklistFromAnalytics(
  c: Context<MiddlewareKeyVariables>,
  appId: string | undefined,
  event: Pick<TrackOptions, 'channel' | 'event' | 'tags'>,
): Promise<boolean> {
  const update = getBuilderChecklistUpdateFromAnalytics(event)
  const auth = c.get('auth')
  if (!appId || !update || !auth?.userId)
    return false
  if ((event.tags?.action === 'start_setup' || event.tags?.action === 'profile_prepared') && event.tags.app_id !== appId)
    return false

  const stepId = `builder.${update.platform}.${update.step}` as AppOnboardingBuilderStepId
  try {
    const result = await persistAuthorizedOnboardingMutation(c, appId, {
      requestedSteps: [stepId],
      buildPatch: ({ currentValue, allowedSteps, at }) => allowedSteps.has(stepId)
        ? buildBuilderChecklistPatch(currentValue, update, () => at)
        : null,
    })
    if (!result)
      return false
    await emitCommittedAppOnboardingHistory(c, [result])
    return true
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'builder onboarding checklist analytics update failed',
      app_id: appId,
      step: update.step,
      error: serializeError(error),
    })
    return false
  }
}

export async function persistBuilderBuildOutcome(
  c: Context<MiddlewareKeyVariables>,
  { appId, platform, status }: BuilderBuildOutcome,
): Promise<boolean> {
  // Android persistence is intentionally deferred. The refresh repair still
  // evaluates Android evidence independently so no cross-platform evidence leaks.
  if (platform === 'android')
    return false
  const update = getBuilderBuildOutcomeUpdate(platform, status)
  if (!update)
    return false

  try {
    const result = await persistAppOnboardingMutation(c, appId, {
      buildPatch: ({ currentValue, at }) => buildBuilderChecklistPatch(currentValue, update, () => at),
    })
    if (!result)
      return false
    await emitCommittedSystemAppOnboardingHistory(c, [result])
    return true
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'builder onboarding checklist build outcome update failed',
      app_id: appId,
      platform,
      status,
      error: serializeError(error),
    })
    return false
  }
}
