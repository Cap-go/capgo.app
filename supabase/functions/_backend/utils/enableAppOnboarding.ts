import type { Json } from './supabase.types.ts'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from './appOnboarding.ts'

interface JsonObject { [key: string]: Json | undefined }

const setupKeys = ['todo_list_version', 'ota_todo_list_version', 'builder_todo_list_version', 'paths', 'selected_path', 'selected_builder_platform', 'source', 'outcome', 'steps', 'started_at', 'completed_at', 'updated_at', 'source_updated_at', 'last_run_id']
const builderSteps = {
  ios: ['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate', 'prepare_profile', 'successful_cloud_build'],
  android: ['start_setup', 'prepare_keystore', 'connect_google_play', 'successful_cloud_build'],
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

export class UnsupportedOnboardingVersion extends Error {}

function checklistVersion(value: Json | undefined, fallback: string): string {
  if (value === null || value === undefined)
    return fallback
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new UnsupportedOnboardingVersion('Unsupported onboarding checklist version')
  return String(value)
}

function readOnboardingSetup(value: unknown) {
  const onboarding = { ...object(value) }
  const setup = { ...Object.fromEntries(setupKeys.filter(key => key in onboarding).map(key => [key, onboarding[key]])), ...object(onboarding.setup) }
  const version = checklistVersion(setup.todo_list_version, '2')
  if (!['1', '2', '3', '4'].includes(version)
    || (version === '4' && (checklistVersion(setup.ota_todo_list_version, '1') !== '1' || checklistVersion(setup.builder_todo_list_version, '1') !== '1'))) {
    throw new UnsupportedOnboardingVersion('Unsupported onboarding checklist version')
  }
  return { onboarding, setup, version }
}

export function enableOtaChecklist(value: unknown): JsonObject {
  const { onboarding, setup, version } = readOnboardingSetup(value)
  // An existing OTA checklist, including completed or dismissed setup, is unchanged.
  if (version === '3' || (version === '4' && setup.ota_todo_list_version === '1'))
    return onboarding
  if (version === '4' && setup.ota_todo_list_version === 1)
    return { ...onboarding, setup: { ...setup, ota_todo_list_version: '1' } }

  const steps = { ...object(setup.steps) }
  const previousOta = version === '4' ? object(steps.ota) : steps
  const ota = Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [
    id,
    previousOta[id] ?? (id === 'login_cli_mcp' ? previousOta.add_app : undefined) ?? { status: 'pending' },
  ]))
  const paths = Array.isArray(setup.paths) ? [...setup.paths] : []
  if (!paths.includes('ota'))
    paths.push('ota')
  delete setup.completed_at
  delete onboarding.getting_started_dismissed_at
  return {
    ...onboarding,
    setup: { ...setup, todo_list_version: 4, ota_todo_list_version: '1', paths, selected_path: 'ota', outcome: 'in_progress', steps: { ...steps, ota } },
  }
}

// Explicit opt-in only: keep legacy records and feature history, and reopen the
// existing Getting started flow without changing need_onboarding or experiments.
export function enableBuilderChecklist(value: unknown): JsonObject {
  const { onboarding, setup, version } = readOnboardingSetup(value)

  const steps = { ...object(setup.steps) }
  const builder = { ...object(steps.builder) }
  for (const [platform, ids] of Object.entries(builderSteps))
    builder[platform] = { ...Object.fromEntries(ids.map(id => [id, { status: 'pending' }])), ...object(builder[platform]) }

  let paths: Json[]
  if (version === '3') {
    paths = ['ota', 'builder']
    setup.ota_todo_list_version = '1'
    steps.ota = Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, steps[id] ?? { status: 'pending' }]))
  }
  else if (version === '4') {
    paths = Array.isArray(setup.paths) ? [...setup.paths] : []
    if (paths.includes('ota') || setup.ota_todo_list_version != null || Object.keys(object(steps.ota)).length > 0) {
      setup.ota_todo_list_version = '1'
      if (!paths.includes('ota'))
        paths.push('ota')
    }
    if (!paths.includes('builder'))
      paths.push('builder')
  }
  else {
    paths = ['builder']
    delete setup.ota_todo_list_version
  }
  delete setup.completed_at
  delete onboarding.getting_started_dismissed_at
  return {
    ...onboarding,
    setup: { ...setup, todo_list_version: 4, builder_todo_list_version: '1', paths, selected_path: 'builder', outcome: 'in_progress', steps: { ...steps, builder } },
  }
}
