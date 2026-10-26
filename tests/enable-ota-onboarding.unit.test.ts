import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { enableOtaChecklist, UnsupportedOnboardingVersion } from '../supabase/functions/_backend/utils/enableAppOnboarding.ts'

const at = '2026-10-24T10:00:00.000Z'
const builder = { ios: { prepare_certificate: { status: 'done', at } }, android: { prepare_keystore: { status: 'warning', annotation: 'keep', at } } }

describe('OTA checklist activation', () => {
  it.concurrent('adds OTA to Builder-only without changing its progress, features, or experiment assignment', () => {
    const original = {
      custom: 'keep', abtests: { builder_todo_list_v4: { branch: 'A' } },
      features: { builder: { stage: 'build_succeeded' } }, getting_started_dismissed_at: at,
      setup: { todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_path: 'builder', selected_builder_platform: 'android', outcome: 'completed', completed_at: at, steps: { builder } },
    }
    const snapshot = structuredClone(original)
    const result = enableOtaChecklist(original) as any
    expect(original).toEqual(snapshot)
    expect(result.setup).toMatchObject({ todo_list_version: 4, ota_todo_list_version: '1', builder_todo_list_version: '1', paths: ['builder', 'ota'], selected_path: 'ota', selected_builder_platform: 'android', outcome: 'in_progress' })
    expect(result.setup.steps.builder).toEqual(builder)
    expect(result.setup.steps.ota).toEqual(Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'pending' }])))
    expect(result.features).toEqual(original.features)
    expect(result.abtests).toEqual(original.abtests)
    expect(result.custom).toBe('keep')
    expect(result.setup).not.toHaveProperty('completed_at')
    expect(result).not.toHaveProperty('getting_started_dismissed_at')
    expect(enableOtaChecklist(result)).toEqual(result)
  })

  it.concurrent.each(['in_progress', 'completed', 'skipped'])('does not reopen or reset an existing OTA checklist (%s)', (outcome) => {
    const ota = { add_code: { status: 'done', at, annotation: 'keep' }, upload_bundle: { status: 'skipped', at } }
    for (const version of [3, 4]) {
      const original = { getting_started_dismissed_at: at, setup: { todo_list_version: version, outcome, completed_at: at, ...(version === 4 ? { ota_todo_list_version: '1', paths: ['ota', 'builder'], selected_path: 'builder' } : {}), steps: version === 4 ? { ota, builder } : ota } }
      expect(enableOtaChecklist(original)).toEqual(original)
    }
  })

  it.concurrent.each([null, {}, { features: { cli_install: { succeeded_at: at } } }])('initializes an app without a checklist: %j', (original) => {
    const result = enableOtaChecklist(original) as any
    expect(result.setup.paths).toEqual(['ota'])
    expect(Object.keys(result.setup.steps.ota)).toEqual(APP_ONBOARDING_OTA_V1_STEP_IDS)
    expect(result.setup.steps.builder).toBeUndefined()
    expect(enableOtaChecklist(result)).toEqual(result)
  })

  it.concurrent.each(['completed', 'skipped'])('normalizes a numeric OTA version without reopening %s setup', (outcome) => {
    const original = { getting_started_dismissed_at: at, setup: { todo_list_version: 4, ota_todo_list_version: 1, paths: ['ota', 'builder'], selected_path: 'builder', outcome, completed_at: at, steps: { ota: { add_code: { status: 'done', at } }, builder } } }
    const snapshot = structuredClone(original)
    const result = enableOtaChecklist(original)
    expect(result).toEqual({ ...original, setup: { ...original.setup, ota_todo_list_version: '1' } })
    expect(original).toEqual(snapshot)
    expect(enableOtaChecklist(result)).toEqual(result)
  })

  it.concurrent.each([1, 2])('carries legacy v%s step history into the OTA checklist', (version) => {
    const login = { status: 'done', at, annotation: 'keep' }
    const steps = { [version === 1 ? 'add_app' : 'login_cli_mcp']: login, add_code: { status: 'skipped', at } }
    const result = enableOtaChecklist({ setup: { todo_list_version: version, steps } }) as any
    expect(result.setup.steps.ota.login_cli_mcp).toEqual(login)
    expect(result.setup.steps.ota.add_code).toEqual(steps.add_code)
    expect(result.setup.steps.ota.test_update).toEqual({ status: 'pending' })
  })

  it.concurrent.each([{ todo_list_version: 5 }, { todo_list_version: 4, ota_todo_list_version: '2' }, { todo_list_version: 4, builder_todo_list_version: '2' }])('rejects unsupported checklist versions: %j', (setup) => {
    expect(() => enableOtaChecklist({ setup })).toThrow(UnsupportedOnboardingVersion)
  })
})
