import type { LifecycleAppRow } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import { describe, expect, it } from 'vitest'
import { buildAppEvidence, nextTask } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

const CREATED = '2026-10-01T10:00:00.000Z'
const DONE = '2026-10-01T10:01:00.000Z'

function app(setup: Record<string, unknown>): LifecycleAppRow {
  return { app_id: 'com.example.lifecycle', id: '11111111-1111-4111-8111-111111111111', created_at: CREATED, name: 'Example app', onboarding: { setup }, need_onboarding: false }
}

function ota(steps: Record<string, unknown> = {}) {
  return app({
    todo_list_version: 4,
    ota_todo_list_version: '1',
    paths: ['ota'],
    selected_path: 'ota',
    steps: { ota: { ...Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'pending' }])), ...steps } },
  })
}

function builder(platform: unknown = 'ios', steps: Record<string, unknown> = {}) {
  return app({ todo_list_version: 4, builder_todo_list_version: '1', paths: ['builder'], selected_builder_platform: platform, steps: { builder: steps } })
}

describe('organization lifecycle app evidence', () => {
  it.concurrent('rejects unsupported checklists, missing incarnations and invalid creation identity', () => {
    expect(buildAppEvidence(app({ todo_list_version: 2 }), 'ota')).toBeNull()
    expect(buildAppEvidence({ ...ota(), id: '' }, 'ota')).toBeNull()
    expect(buildAppEvidence({ ...ota(), created_at: 'bad date' }, 'ota')).toBeNull()
    expect(buildAppEvidence(app({ todo_list_version: 4, ota_todo_list_version: 'future', paths: ['ota'] }), 'ota')).toBeNull()
    expect(buildAppEvidence(app({ todo_list_version: 4, builder_todo_list_version: '1', paths: ['ota'] }), 'builder')).toBeNull()
  })

  it.concurrent('keeps independent statuses and does not infer previous tasks from later completion', () => {
    const evidence = buildAppEvidence(ota({ upload_bundle: { status: 'done', at: DONE }, add_code: { status: 'skipped' }, add_updater: { status: 'future' } }), 'ota')!
    expect(evidence.tasks).toMatchObject({ upload_bundle: 'done', run_device: 'pending', add_code: 'skipped', add_updater: 'unknown' })
    expect(evidence.facts.map(fact => fact.step)).toEqual(['upload_bundle'])
    expect(evidence.healthy).toBe(false)
    expect(evidence.checklistComplete).toBe(false)
  })

  it.concurrent('never describes inferred integration as a manual code edit', () => {
    const evidence = buildAppEvidence(ota({ add_code: { status: 'done', at: DONE, annotation: 'inferred_from_test_update' } }), 'ota')!
    expect(evidence.facts[0]?.acknowledgement).toBe('Confirmed the updater integration')
  })

  it.concurrent('matches canonical done-or-skipped completion without claiming skipped achievements or real value', () => {
    const row = ota(Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'done', at: DONE }])))
    const evidence = buildAppEvidence(row, 'ota')!
    expect(evidence.checklistComplete).toBe(true)
    expect(evidence.firstValue).toBeNull()
    expect(evidence.facts.every(fact => fact.kind === 'task')).toBe(true)
    expect(nextTask(evidence)).toBeNull()
    const skipped = ota(Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: id === 'add_code' ? 'skipped' : 'done', at: DONE }])))
    const skippedEvidence = buildAppEvidence(skipped, 'ota')!
    expect(skippedEvidence.checklistComplete).toBe(true)
    expect(skippedEvidence.facts.some(fact => fact.step === 'add_code')).toBe(false)
    expect(skippedEvidence.firstValue).toBeNull()
    expect(nextTask(skippedEvidence)).toBeNull()
  })

  it.concurrent('accepts independent real outcome after checklist completion and deduplicates its identity', () => {
    const row = ota(Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'done', at: DONE }])))
    const verified = { otaAppliedAt: '2026-10-01T10:10:00Z', otaBundleId: 'bundle-23' }
    const first = buildAppEvidence(row, 'ota', verified)!
    const again = buildAppEvidence(row, 'ota', verified)!
    expect(first.firstValue).toMatchObject({ kind: 'value', step: 'test_update', at: '2026-10-01T10:10:00.000Z' })
    expect(first.firstValue?.id).toBe(again.firstValue?.id)
    expect(first.firstValue?.id).not.toBe(first.facts.find(fact => fact.kind === 'task' && fact.step === 'test_update')?.id)
  })

  it.concurrent('rejects demo value, unidentified outcomes and facts preceding the current incarnation', () => {
    const row = ota({ run_device: { status: 'done', at: '2026-09-01T00:00:00Z' } })
    expect(buildAppEvidence(row, 'ota')?.facts).toEqual([])
    expect(buildAppEvidence(row, 'ota', { otaAppliedAt: DONE })?.firstValue).toBeNull()
    expect(buildAppEvidence(row, 'ota', { otaAppliedAt: '2026-09-01T00:00:00Z', otaBundleId: 'old' })?.firstValue).toBeNull()
    expect(buildAppEvidence({ ...row, need_onboarding: true }, 'ota', { otaAppliedAt: DONE, otaBundleId: 'demo' })?.firstValue).toBeNull()
    const original = buildAppEvidence(row, 'ota', { otaAppliedAt: DONE, otaBundleId: '23' })!
    const replacement = buildAppEvidence({ ...row, id: '22222222-2222-4222-8222-222222222222' }, 'ota', { otaAppliedAt: DONE, otaBundleId: '23' })!
    expect(original.firstValue?.id).not.toBe(replacement.firstValue?.id)
  })

  it.concurrent('keeps iOS and Android facts, warnings and completion separate', () => {
    const steps = { ios: { start_setup: { status: 'done', at: DONE }, prepare_certificate: { status: 'warning', at: DONE } }, android: { prepare_keystore: { status: 'done', at: DONE }, successful_cloud_build: { status: 'done', at: DONE } } }
    const ios = buildAppEvidence(builder('ios', steps), 'builder')!
    const android = buildAppEvidence(builder('android', steps), 'builder')!
    expect(ios.tasks.prepare_certificate).toBe('warning')
    expect(ios.facts.map(fact => fact.step)).toEqual(['start_setup'])
    expect(ios.tasks).not.toHaveProperty('prepare_keystore')
    expect(android.facts.map(fact => fact.step)).toEqual(['prepare_keystore', 'successful_cloud_build'])
    expect(android.firstValue).toBeNull()
    expect(ios.fundingBlocked).toBe(false)
  })

  it.concurrent('does not guess a Builder platform or infer a failure cause', () => {
    const evidence = buildAppEvidence(builder('web'), 'builder')!
    expect(evidence.healthy).toBe(false)
    expect(evidence.platform).toBeNull()
    expect(evidence.tasks).toEqual({})
    expect(nextTask(evidence)?.id).toBe('select_builder_platform')
    expect(evidence.fundingBlocked).toBe(false)
  })

  it.concurrent.each([null, undefined])('recognizes a valid Builder platform-selection task without inventing completion (%s)', (platform) => {
    const row = builder(null)
    const setup = (row.onboarding as { setup: Record<string, unknown> }).setup
    if (platform === undefined)
      delete setup.selected_builder_platform
    const evidence = buildAppEvidence(row, 'builder')!
    expect(evidence.healthy).toBe(true)
    expect(evidence.platform).toBeNull()
    expect(evidence.tasks).toEqual({})
    expect(evidence.facts).toEqual([])
    expect(evidence.firstValue).toBeNull()
    expect(evidence.checklistComplete).toBe(false)
    expect(nextTask(evidence)?.ctaLabel).toBe('Choose my platform')
  })

  it.concurrent('allows a verified real Builder result while the OTA demo splash remains pending', () => {
    const row = { ...builder('android'), need_onboarding: true }
    const verified = { builderSucceededAt: DONE, builderJobId: 'job-real-23' }
    expect(buildAppEvidence(row, 'builder', verified)?.firstValue?.acknowledgement).toBe('Completed a successful Android cloud build ✨')
    expect(buildAppEvidence(row, 'builder', { ...verified, demoApp: true })?.firstValue).toBeNull()
    expect(buildAppEvidence(row, 'builder', { ...verified, builderJobId: 'demo-job-23' })?.firstValue).toBeNull()
    expect(buildAppEvidence(builder(null), 'builder', verified)?.firstValue).toBeNull()
  })

  it.concurrent('accepts an OTA outcome with explicit non-demo provenance while rejecting known demo outcomes', () => {
    const row = { ...ota(), need_onboarding: true }
    const verified = { otaAppliedAt: DONE, otaBundleId: 'bundle-real-23' }
    expect(buildAppEvidence(row, 'ota', verified)?.firstValue).toBeNull()
    expect(buildAppEvidence(row, 'ota', { ...verified, demoApp: false })?.firstValue?.kind).toBe('value')
    expect(buildAppEvidence({ ...row, need_onboarding: false }, 'ota', { ...verified, demoApp: true })?.firstValue).toBeNull()
  })

  it.concurrent('distinguishes running the app from testing an already connected uploaded update', () => {
    const row = ota(Object.fromEntries(['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'upload_bundle'].map(id => [id, { status: 'done', at: DONE }])))
    expect(nextTask(buildAppEvidence(row, 'ota')!)?.ctaLabel).toBe('Run my app')
    const connected = ota(Object.fromEntries(['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'upload_bundle', 'run_device'].map(id => [id, { status: 'done', at: DONE }])))
    const action = nextTask(buildAppEvidence(connected, 'ota')!)!
    expect(action.ctaLabel).toBe('Test my update')
    expect(action.explanation).toContain('channel')
    expect(action.explanation).toContain('download and install')
  })

  it.concurrent('does not turn historical reselection, timestamps or skips into new earned facts', () => {
    const row = ota({ add_channel: { status: 'done', at: DONE }, add_code: { status: 'skipped', at: DONE } })
    const initial = buildAppEvidence(row, 'ota')!
    const observedAgain = buildAppEvidence(row, 'ota')!
    expect(initial.facts).toEqual(observedAgain.facts)
    expect(initial.facts).toHaveLength(1)
    expect(buildAppEvidence(ota({ add_channel: { status: 'done' } }), 'ota')?.facts).toEqual([])
  })
})
