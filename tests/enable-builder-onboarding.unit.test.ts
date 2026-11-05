import { describe, expect, it } from 'vitest'
import { hasSupportedOtaTodoList, parseAppOnboarding } from '../src/services/appOnboarding'
import { BUILDER_STEP_IDS } from '../src/services/builderOnboardingChecklist'
import { shouldShowGettingStartedNav, shouldSkipOnboardingResume } from '../src/utils/appOnboardingProgress'
import { hasDualOnboardingChecklists } from '../src/utils/dualOnboardingChecklists'
import { enableBuilderChecklist, UnsupportedOnboardingVersion } from '../supabase/functions/_backend/utils/enableAppOnboarding.ts'

const at = '2026-10-19T10:00:00.000Z'
const otaSteps = { login_cli_mcp: { status: 'done', at, source: 'cli', update_history: [{ status: 'done', at }] }, add_channel: { status: 'skipped', at, annotation: 'keep' } }

function activate(original: unknown): any {
  const snapshot = structuredClone(original)
  const data = enableBuilderChecklist(original) as any
  expect(original).toEqual(snapshot)
  expect(data.setup).toMatchObject({ todo_list_version: 4, builder_todo_list_version: '1', selected_path: 'builder', outcome: 'in_progress' })
  expect(data).not.toHaveProperty('getting_started_dismissed_at')
  expect(data.setup).not.toHaveProperty('completed_at')
  expect(shouldShowGettingStartedNav(data)).toBe(true)
  expect(shouldSkipOnboardingResume(data)).toBe(false)
  expect(enableBuilderChecklist(data)).toEqual(data)
  return data
}

describe('explicit Builder checklist activation', () => {
  it.concurrent.each([1, 2])('converts v%s into Builder-only v4 and preserves legacy history and features', (version) => {
    const features = { ota: { succeeded_at: at, stage: 'store_live' } }
    const data = activate({ features, getting_started_dismissed_at: at, setup: { todo_list_version: version, outcome: 'completed', completed_at: at, source: 'cli', steps: otaSteps } })
    expect(data.setup.paths).toEqual(['builder'])
    expect(data.setup.ota_todo_list_version).toBeUndefined()
    expect(data.features).toEqual(features)
    expect(data.setup.steps.login_cli_mcp).toEqual(otaSteps.login_cli_mcp)
    for (const platform of ['ios', 'android'] as const) {
      expect(Object.keys(data.setup.steps.builder[platform])).toEqual([...BUILDER_STEP_IDS[platform]])
      expect(Object.values(data.setup.steps.builder[platform])).toEqual(BUILDER_STEP_IDS[platform].map(() => ({ status: 'pending' })))
    }
  })

  it.concurrent.each([true, false])('upgrades root or nested v3 without losing OTA records (nested=%s)', (nested) => {
    const setup = { todo_list_version: 3, source: 'mcp', outcome: 'skipped', completed_at: at, steps: otaSteps }
    const data = activate({ ...(nested ? { setup } : setup), custom: 'keep', getting_started_dismissed_at: at })
    expect(data.setup.paths).toEqual(['ota', 'builder'])
    expect(data.setup.ota_todo_list_version).toBe('1')
    expect(data.setup.steps.ota).toMatchObject(otaSteps)
    expect(Object.keys(data.setup.steps.ota)).toHaveLength(7)
    expect(data.custom).toBe('keep')
    if (!nested)
      expect(data).toMatchObject(setup)
  })

  it.concurrent.each(['ota', 'builder', 'both'])('extends or reuses v4 %s without resetting progress', (path) => {
    const builderSteps = { ios: { prepare_certificate: { status: 'warning', annotation: 'keep', at } }, android: { prepare_keystore: { status: 'done', at } } }
    const data = activate({ setup: { todo_list_version: 4, ...(path !== 'builder' ? { ota_todo_list_version: '1' } : {}), ...(path !== 'ota' ? { builder_todo_list_version: '1' } : {}), paths: path === 'both' ? ['ota', 'builder'] : [path], selected_path: 'ota', selected_builder_platform: 'android', steps: { ...(path !== 'builder' ? { ota: otaSteps } : {}), ...(path !== 'ota' ? { builder: builderSteps } : {}) } } })
    expect(data.setup.paths).toEqual(path === 'builder' ? ['builder'] : ['ota', 'builder'])
    if (path !== 'builder')
      expect(data.setup.steps.ota).toEqual(otaSteps)
    if (path !== 'ota')
      expect(data.setup.steps.builder).toMatchObject(builderSteps)
    expect(data.setup.selected_builder_platform).toBe('android')
  })

  it.concurrent.each([null, {}, { features: { cli_install: { succeeded_at: at } } }])('initializes an app with no checklist: %j', (original) => {
    expect(activate(original).setup.paths).toEqual(['builder'])
  })

  it.concurrent('prefers nested setup over stale root fields', () => {
    const data = activate({ todo_list_version: 2, steps: {}, setup: { todo_list_version: '3', steps: otaSteps } })
    expect(data.setup.paths).toEqual(['ota', 'builder'])
    expect(data.setup.steps.ota).toMatchObject(otaSteps)
  })

  it.concurrent.each([{ todo_list_version: 5 }, { todo_list_version: 4, builder_todo_list_version: '2' }, { todo_list_version: 4, ota_todo_list_version: '2', paths: ['ota'] }])('rejects unsupported versions without changing input: %j', (setup) => {
    const original = { setup }
    const snapshot = structuredClone(original)
    expect(() => enableBuilderChecklist(original)).toThrow(UnsupportedOnboardingVersion)
    expect(original).toEqual(snapshot)
  })

  it.concurrent.each(['todo_list_version', 'ota_todo_list_version', 'builder_todo_list_version'])('rejects non-scalar %s values without changing input', (field) => {
    for (const value of [[], [1], [4], {}, true, false]) {
      const original = { setup: { todo_list_version: 4, [field]: value } }
      const snapshot = structuredClone(original)
      expect(() => enableBuilderChecklist(original)).toThrow(UnsupportedOnboardingVersion)
      expect(original).toEqual(snapshot)
    }
  })

  it.concurrent('keeps nullish defaults and numeric subversion support', () => {
    expect(activate({ setup: { todo_list_version: null } }).setup.paths).toEqual(['builder'])
    expect(activate({ setup: { todo_list_version: 4, ota_todo_list_version: 1, builder_todo_list_version: null, paths: ['ota'] } }).setup.paths).toEqual(['ota', 'builder'])
  })

  it.concurrent.each([1, '1', null, undefined].flatMap(subversion => [undefined, [], ['builder'], ['ota']].map(paths => ({ subversion, paths }))))('keeps v4 OTA progress readable after normalizing metadata %j', ({ subversion, paths }) => {
    const data = activate({ setup: { todo_list_version: 4, ota_todo_list_version: subversion, paths, steps: { ota: otaSteps } } })
    expect(data.setup.ota_todo_list_version).toBe('1')
    const parsed = parseAppOnboarding(data)
    expect(hasSupportedOtaTodoList(parsed)).toBe(true)
    expect(hasDualOnboardingChecklists(data)).toBe(true)
    expect(parsed.steps.login_cli_mcp?.status).toBe('done')
    expect(parsed.steps.add_channel?.status).toBe('skipped')
    expect(data.setup.steps.ota).toEqual(otaSteps)
  })
})
