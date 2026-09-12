import { describe, expect, it } from 'vitest'
import { INIT_ONBOARDING_STEP_IDS } from '../cli/src/init/onboarding-steps'
import {
  APP_ONBOARDING_STEP_IDS,
  appendAppOnboardingStepHistory,
  applyAppOnboardingPatch,
  getAppOnboardingStepHistoryChanges,
  defaultAppOnboarding,
  mergeAppOnboarding,
  parseAppOnboarding,
  parseAppOnboardingPatch,
  pickAppOnboardingSource,
} from '../supabase/functions/_backend/utils/appOnboarding.ts'

describe('app onboarding merge', () => {
  it.concurrent('keeps CLI step ids in sync with the CLI onboarding list', () => {
    // CLI titles live in cli/src/init/onboarding-steps.ts; backend ids must stay identical.
    expect([...APP_ONBOARDING_STEP_IDS]).toEqual([...INIT_ONBOARDING_STEP_IDS])
  })

  it.concurrent('defaults missing onboarding to manual in progress', () => {
    expect(parseAppOnboarding(null)).toEqual(defaultAppOnboarding())
    expect(parseAppOnboarding('nope')).toEqual(defaultAppOnboarding())
  })

  it.concurrent('reads nested setup without dropping the feature ledger', () => {
    const ledger = {
      refreshed_at: '2026-08-14T00:00:00.000Z',
      features: { ota: { stage: 'local_only' } },
      setup: {
        source: 'cli',
        outcome: 'in_progress',
        steps: { add_app: { status: 'done', at: '2026-08-14T10:00:00.000Z' } },
      },
    }

    expect(parseAppOnboarding(ledger)).toMatchObject({
      source: 'cli',
      outcome: 'in_progress',
      steps: { add_app: { status: 'done', at: '2026-08-14T10:00:00.000Z' } },
    })

    const next = applyAppOnboardingPatch(ledger, {
      steps: { add_channel: { status: 'done' } },
    }, () => '2026-08-14T10:02:00.000Z')

    expect(next.features).toEqual({ ota: { stage: 'local_only' } })
    expect(next.refreshed_at).toBe('2026-08-14T00:00:00.000Z')
    expect(parseAppOnboarding(next).steps.add_channel?.status).toBe('done')
    expect(next.source).toBeUndefined()
  })

  it.concurrent('never downgrades a stronger onboarding source', () => {
    expect(pickAppOnboardingSource('cli', 'ai')).toBe('cli')
    expect(pickAppOnboardingSource('manual', 'ai')).toBe('ai')
    expect(pickAppOnboardingSource('cli', 'mcp')).toBe('mcp')
  })

  it.concurrent('keeps a done step when a later skip arrives', () => {
    const first = mergeAppOnboarding({}, {
      source: 'cli',
      steps: { add_app: { status: 'done', at: '2026-08-14T10:00:00.000Z' } },
    }, () => '2026-08-14T10:00:00.000Z')

    const skipped = mergeAppOnboarding(first, {
      steps: { add_app: { status: 'skipped' } },
    }, () => '2026-08-14T10:01:00.000Z')

    expect(skipped.steps.add_app).toEqual({
      status: 'done',
      at: '2026-08-14T10:00:00.000Z',
    })
    expect(skipped.source).toBe('cli')
    expect(skipped.outcome).toBe('in_progress')
  })

  it.concurrent('marks completed only when every CLI step is done', () => {
    const steps = Object.fromEntries(APP_ONBOARDING_STEP_IDS.map(id => [id, { status: 'done' as const }]))
    const completed = mergeAppOnboarding({ source: 'cli' }, { steps }, () => '2026-08-14T12:00:00.000Z')
    expect(completed.outcome).toBe('completed')

    const skipped = mergeAppOnboarding({ source: 'cli' }, {
      steps: {
        ...steps,
        run_device: { status: 'skipped' },
      },
    }, () => '2026-08-14T12:00:00.000Z')
    expect(skipped.outcome).toBe('skipped')
  })

  it.concurrent('keeps the original step timestamp when a later report omits at', () => {
    const first = mergeAppOnboarding({}, {
      source: 'cli',
      steps: { add_app: { status: 'done', at: '2026-08-14T10:00:00.000Z' } },
    }, () => '2026-08-14T10:00:00.000Z')

    const again = mergeAppOnboarding(first, {
      steps: { add_app: { status: 'done' } },
    }, () => '2026-08-14T11:00:00.000Z')

    expect(again.steps.add_app).toEqual({
      status: 'done',
      at: '2026-08-14T10:00:00.000Z',
    })
  })

  it.concurrent('keeps switched_to_manual until the CLI finishes', () => {
    const switched = mergeAppOnboarding({ source: 'cli' }, {
      outcome: 'switched_to_manual',
      steps: { add_app: { status: 'done' } },
    }, () => '2026-08-14T12:00:00.000Z')
    expect(switched.outcome).toBe('switched_to_manual')
  })

  it.concurrent('ignores empty or unknown onboarding patches', () => {
    expect(parseAppOnboardingPatch({})).toBeNull()
    expect(parseAppOnboardingPatch({ source: 'web' })).toBeNull()
    expect(parseAppOnboardingPatch({ steps: { not_a_step: { status: 'done' } } })).toBeNull()
    expect(parseAppOnboardingPatch({ source: 'ai' })).toEqual({ source: 'ai' })
  })

  it.concurrent('ignores client history and caps server history with an overflow marker', () => {
    expect(parseAppOnboardingPatch({
      steps: { build_project: { status: 'done', update_history: [{ forged: true }] } },
    })).toEqual({ steps: { build_project: { status: 'done' } } })

    let current: Record<string, unknown> = {
      setup: {
        source: 'cli',
        outcome: 'in_progress',
        steps: { build_project: { status: 'done', at: 'step-0' } },
      },
    }
    for (let update = 1; update <= 11; update++) {
      const patch = { steps: { build_project: { status: 'done' as const, at: `step-${update}` } } }
      const merged = applyAppOnboardingPatch(current, patch, () => `merge-${update}`)
      current = appendAppOnboardingStepHistory(current, merged, patch, () => `server-${update}`)
    }

    const setup = current.setup as { steps: { build_project: { update_history: Array<Record<string, unknown>> } } }
    const history = setup.steps.build_project.update_history
    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ status: 'done', at: 'server-1' })
    expect(history[9]).toEqual({ type: 'update_history_full', at: 'server-11' })

    const duplicatePatch = { steps: { build_project: { status: 'done' as const, at: 'step-11' } } }
    const duplicateMerge = applyAppOnboardingPatch(current, duplicatePatch, () => 'merge-duplicate')
    const duplicate = appendAppOnboardingStepHistory(current, duplicateMerge, duplicatePatch, () => 'server-duplicate')
    const duplicateSetup = duplicate.setup as { steps: { build_project: { update_history: unknown[] } } }
    expect(duplicateSetup.steps.build_project.update_history).toEqual(history)
    expect(getAppOnboardingStepHistoryChanges(current, duplicate, duplicatePatch)).toEqual([])

    const changedPatch = { steps: { add_app: { status: 'done' as const, at: 'step-new' } } }
    const changedMerge = applyAppOnboardingPatch(current, changedPatch, () => 'merge-new')
    const changed = appendAppOnboardingStepHistory(current, changedMerge, changedPatch, () => 'server-new')
    expect(getAppOnboardingStepHistoryChanges(current, changed, changedPatch)).toEqual([{
      stepId: 'add_app',
      status: 'done',
      at: 'server-new',
      historyLength: 1,
      historyFull: false,
    }])
  })
})
