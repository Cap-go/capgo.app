import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_OTA_V1_STEP_IDS, APP_ONBOARDING_V2_STEP_IDS, mergeAppOnboarding } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { getMissedStepIds, isOpenOnboardingStepStatus } from '../supabase/functions/_backend/utils/onboardingMissedSteps.ts'

describe('getMissedStepIds', () => {
  it('returns open steps that sit before the last done step', () => {
    expect(getMissedStepIds([
      { id: 'init', status: 'pending' },
      { id: 'channel', status: 'done' },
      { id: 'updater', status: undefined },
      { id: 'code', status: 'skipped' },
      { id: 'device', status: 'done' },
      { id: 'upload', status: 'pending' },
    ])).toEqual(['init', 'updater'])
  })

  it('never reports the in-order current step or the final step', () => {
    expect(getMissedStepIds([{ id: 'a', status: 'done' }, { id: 'b' }, { id: 'c' }])).toEqual([])
    expect(getMissedStepIds([{ id: 'a' }, { id: 'b', status: 'warning' }])).toEqual([])
    expect(getMissedStepIds([])).toEqual([])
  })

  it('treats a warning before a later done step as passed over', () => {
    expect(getMissedStepIds([{ id: 'a', status: 'warning' }, { id: 'b', status: 'done' }])).toEqual(['a'])
  })

  it('treats pending and warning as open for skip', () => {
    expect(isOpenOnboardingStepStatus('pending')).toBe(true)
    expect(isOpenOnboardingStepStatus(undefined)).toBe(true)
    expect(isOpenOnboardingStepStatus('done')).toBe(false)
    expect(isOpenOnboardingStepStatus('skipped')).toBe(false)
  })
})

describe('checklist outcome with explicit task skips', () => {
  it('completes a v3 checklist when every task is done or skipped', () => {
    const steps = Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: id === 'login_cli_mcp' ? 'skipped' as const : 'done' as const }]))
    expect(mergeAppOnboarding({ setup: { todo_list_version: 3 } }, { steps }).outcome).toBe('completed')
  })

  it('keeps the historical skipped outcome for v2 and explicit dismissal', () => {
    const steps = Object.fromEntries(APP_ONBOARDING_V2_STEP_IDS.map(id => [id, { status: id === 'run_device' ? 'skipped' as const : 'done' as const }]))
    expect(mergeAppOnboarding({ setup: { todo_list_version: 2 } }, { steps }).outcome).toBe('skipped')
    expect(mergeAppOnboarding({ setup: { todo_list_version: 3 } }, { outcome: 'skipped' }).outcome).toBe('skipped')
  })

  it('records explicit dismissal even when every v3 task is already present', () => {
    const steps = Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'done' as const }]))
    expect(mergeAppOnboarding({ setup: { todo_list_version: 3, steps } }, { outcome: 'skipped' }).outcome).toBe('skipped')
  })
})
