import { describe, expect, it } from 'vitest'
import {
  BUILDER_STEP_IDS,
  hasSupportedBuilderTodoList,
  isBuilderTodoListSelected,
  maskBuilderCommand,
  parseBuilderOnboarding,
  startedBuilderPlatforms,
} from '../src/services/builderOnboardingChecklist'

function onboarding(setup: Record<string, unknown>) {
  return { setup }
}

const builderSteps = {
  ios: Object.fromEntries(BUILDER_STEP_IDS.ios.map(id => [id, { status: 'pending' }])),
  android: Object.fromEntries(BUILDER_STEP_IDS.android.map(id => [id, { status: 'pending' }])),
}

describe('builder onboarding checklist assignment', () => {
  it.concurrent.each([
    ['Builder-only path without a selected path', onboarding({ todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'] }), true],
    ['OTA-only path', onboarding({ todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], selected_path: 'ota' }), false],
    ['both paths with Builder selected', onboarding({ todo_list_version: 4, builder_todo_list_version: '1', ota_todo_list_version: '1', paths: ['ota', 'builder'], selected_path: 'builder' }), true],
    ['both paths with OTA selected', onboarding({ todo_list_version: 4, builder_todo_list_version: '1', ota_todo_list_version: '1', paths: ['ota', 'builder'], selected_path: 'ota' }), false],
    ['wrong todo-list version', onboarding({ todo_list_version: 3, builder_todo_list_version: '1', paths: ['builder'], selected_path: 'builder' }), false],
    ['wrong Builder list version', onboarding({ todo_list_version: 4, builder_todo_list_version: 1, paths: ['builder'], selected_path: 'builder' }), false],
    ['missing Builder path', onboarding({ todo_list_version: 4, builder_todo_list_version: '1', paths: ['ota'], selected_path: 'builder' }), false],
  ] as const)('%s', (_name, value, expected) => {
    expect(isBuilderTodoListSelected(value)).toBe(expected)
  })

  it.concurrent('requires every Builder eligibility field', () => {
    expect(hasSupportedBuilderTodoList(onboarding({
      todo_list_version: 4,
      builder_todo_list_version: '1',
      paths: ['builder'],
    }))).toBe(true)
    expect(hasSupportedBuilderTodoList(onboarding({
      todo_list_version: 4,
      builder_todo_list_version: '1',
      paths: ['ota'],
    }))).toBe(false)
  })

  it.concurrent('reads the stored platform and status for every configured step', () => {
    const parsed = parseBuilderOnboarding(onboarding({
      todo_list_version: 4,
      builder_todo_list_version: '1',
      paths: ['builder'],
      selected_builder_platform: 'ios',
      steps: { builder: builderSteps },
    }))

    expect(parsed.selectedPlatform).toBe('ios')
    expect(parsed.steps.ios).toEqual(Object.fromEntries(BUILDER_STEP_IDS.ios.map(id => [id, 'pending'])))
    expect(parsed.steps.android).toEqual(Object.fromEntries(BUILDER_STEP_IDS.android.map(id => [id, 'pending'])))
  })

  it.concurrent('ignores unsupported step ids, invalid statuses, and invalid stored platforms', () => {
    const parsed = parseBuilderOnboarding(onboarding({
      selected_builder_platform: 'web',
      steps: {
        builder: {
          ios: { ...builderSteps.ios, prepare_profile: { status: 'future' }, future_step: { status: 'pending' } },
          android: builderSteps.android,
        },
      },
    }))

    expect(parsed.selectedPlatform).toBeNull()
    expect(parsed.steps.ios.prepare_profile).toBeUndefined()
    expect(parsed.steps.ios).not.toHaveProperty('future_step')
  })
})

describe('builder setup progress card', () => {
  it.concurrent('waits until the CLI or the assistant starts a platform', () => {
    expect(startedBuilderPlatforms(parseBuilderOnboarding(onboarding({ steps: { builder: builderSteps } })))).toEqual([])
  })

  it.concurrent('lists every platform with reported progress, iOS first', () => {
    const state = parseBuilderOnboarding(onboarding({ steps: { builder: {
      ios: { ...builderSteps.ios, connect_app_store: { status: 'warning' } },
      android: { ...builderSteps.android, start_setup: { status: 'done' } },
    } } }))
    expect(startedBuilderPlatforms(state)).toEqual(['ios', 'android'])
  })

  it.concurrent('counts a skipped step as started', () => {
    const state = parseBuilderOnboarding(onboarding({ steps: { builder: { ...builderSteps, android: { prepare_keystore: { status: 'skipped' } } } } }))
    expect(startedBuilderPlatforms(state)).toEqual(['android'])
  })

  it.concurrent('masks the API key in the Builder command', () => {
    expect(maskBuilderCommand('npx @capgo/cli@latest build init -a ak_1234567890abcdef3f9a')).toBe('npx @capgo/cli@latest build init -a ak_••••••••3f9a')
    expect(maskBuilderCommand('npx @capgo/cli@latest build init -a 12345678-aaaa-bbbb-cccc-1234567890ab')).toBe('npx @capgo/cli@latest build init -a 123••••••••90ab')
    expect(maskBuilderCommand('')).toBe('')
    expect(maskBuilderCommand('npx @capgo/cli@latest build init -a ak_1234567890abcdef3f9a --verbose')).toBe('npx @capgo/cli@latest build init -a ak_••••••••3f9a --verbose')
  })
})
