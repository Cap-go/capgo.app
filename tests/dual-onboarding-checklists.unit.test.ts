// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../src/services/appOnboarding'
import { BUILDER_STEP_IDS } from '../src/services/builderOnboardingChecklist'
import { shouldShowGettingStartedNav, shouldSkipOnboardingResume } from '../src/utils/appOnboardingProgress'
import { hasDualOnboardingChecklists, loadChecklistPreference, resolveDualChecklistResume, saveChecklistPreference } from '../src/utils/dualOnboardingChecklists'

function fixture() {
  return { setup: {
    todo_list_version: 4,
    ota_todo_list_version: '1',
    builder_todo_list_version: '1',
    paths: ['ota', 'builder'],
    selected_path: 'builder',
    selected_builder_platform: 'ios',
    outcome: 'in_progress',
    steps: {
      ota: Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'pending', at: '2026-10-01T00:00:00Z' }])),
      builder: {
        ios: Object.fromEntries(BUILDER_STEP_IDS.ios.map(id => [id, { status: 'pending' }])),
        android: Object.fromEntries(BUILDER_STEP_IDS.android.map(id => [id, { status: 'pending' }])),
      },
    },
  } }
}

function complete(steps: Record<string, { status: string }>) {
  Object.values(steps).forEach(step => step.status = 'done')
}

describe('assigned dual checklists', () => {
  it.concurrent('requires both supported persisted paths and versions, regardless of intent', () => {
    const value = fixture()
    expect(hasDualOnboardingChecklists(value)).toBe(true)
    for (const setup of [
      { ...value.setup, paths: ['ota'] },
      { ...value.setup, paths: ['builder'] },
      { ...value.setup, todo_list_version: 3 },
      { ...value.setup, ota_todo_list_version: '2' },
      { ...value.setup, builder_todo_list_version: '2' },
    ]) expect(hasDualOnboardingChecklists({ intent: 'both', setup })).toBe(false)
  })

  it.concurrent('asks for a goal when all saved steps are pending, even with initialization timestamps and a local preference', () => {
    expect(resolveDualChecklistResume(fixture(), { path: 'builder', platform: 'ios' }).path).toBe(null)
  })

  it.concurrent('resumes OTA-only progress despite the assigned default or browser preference', () => {
    const value = fixture()
    value.setup.steps.ota.login_cli_mcp.status = 'done'
    expect(resolveDualChecklistResume(value, { path: 'builder' }).path).toBe('ota')
  })

  it.concurrent('resumes the Builder platform with actual progress instead of an initialized platform', () => {
    const value = fixture()
    value.setup.steps.builder.android.start_setup.status = 'done'
    expect(resolveDualChecklistResume(value)).toMatchObject({ path: 'builder', platform: 'android' })
  })

  it.concurrent('counts warnings as attempted work and preserves the last unfinished platform', () => {
    const value = fixture()
    value.setup.steps.builder.android.start_setup.status = 'warning'
    value.setup.steps.builder.ios.start_setup.status = 'done'
    expect(resolveDualChecklistResume(value, { path: 'builder', platform: 'android' }).platform).toBe('android')
  })

  it.concurrent('resumes the last-used unfinished path when both have progress without mutating saved metadata', () => {
    const value = fixture()
    value.setup.steps.ota.login_cli_mcp.status = 'done'
    value.setup.steps.builder.ios.start_setup.status = 'done'
    const before = structuredClone(value)
    expect(resolveDualChecklistResume(value, { path: 'ota' }).path).toBe('ota')
    expect(resolveDualChecklistResume(value, { path: 'builder' }).path).toBe('builder')
    expect(value).toEqual(before)
  })

  it.concurrent('prefers unfinished work over a completed path, even if the other has not started', () => {
    const value = fixture()
    complete(value.setup.steps.ota)
    value.setup.outcome = 'completed'
    expect(resolveDualChecklistResume(value, { path: 'ota' })).toMatchObject({ path: 'builder', otaComplete: true, builderComplete: false })
    expect(shouldShowGettingStartedNav(value)).toBe(true)
    expect(shouldSkipOnboardingResume(value)).toBe(false)
    value.setup.steps.ota.test_update.status = 'pending'
    complete(value.setup.steps.builder.ios)
    expect(resolveDualChecklistResume(value, { path: 'builder' }).path).toBe('ota')
  })

  it.concurrent('prefers an unfinished Builder platform over a finished platform', () => {
    const value = fixture()
    complete(value.setup.steps.builder.ios)
    value.setup.steps.builder.android.start_setup.status = 'done'
    expect(resolveDualChecklistResume(value, { path: 'builder', platform: 'ios' })).toMatchObject({ platform: 'android', builderComplete: false })
  })

  it.concurrent('finishes when OTA and relevant Builder platforms finish without requiring an untouched platform', () => {
    const value = fixture()
    complete(value.setup.steps.ota)
    complete(value.setup.steps.builder.android)
    expect(resolveDualChecklistResume(value)).toMatchObject({ path: 'builder', platform: 'android', otaComplete: true, builderComplete: true })
    expect(shouldShowGettingStartedNav(value)).toBe(false)
    expect(shouldSkipOnboardingResume(value)).toBe(true)
  })

  it.concurrent('does not treat a skipped final build as successful completion', () => {
    const value = fixture()
    complete(value.setup.steps.builder.ios)
    value.setup.steps.builder.ios.successful_cloud_build.status = 'skipped'
    expect(resolveDualChecklistResume(value).builderComplete).toBe(false)
  })
})

describe('browser checklist preference', () => {
  beforeEach(() => localStorage.clear())

  it('isolates the last-used path and platform by user and app', () => {
    saveChecklistPreference('fake-user-a', 'com.example.one', { path: 'builder', platform: 'android' })
    expect(loadChecklistPreference('fake-user-a', 'com.example.one')).toEqual({ path: 'builder', platform: 'android' })
    expect(loadChecklistPreference('fake-user-b', 'com.example.one')).toEqual({})
    expect(loadChecklistPreference('fake-user-a', 'com.example.two')).toEqual({})
    expect(loadChecklistPreference(null, 'com.example.one')).toEqual({})
  })
})
