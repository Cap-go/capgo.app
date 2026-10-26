import type { AppOnboardingStepHistoryChange } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAppOnboardingMilestoneBentoEvent, emitCommittedAppOnboardingBento } from '../supabase/functions/_backend/utils/app_onboarding_bento.ts'
import { emitCommittedAppOnboardingHistory, emitCommittedSystemAppOnboardingHistory } from '../supabase/functions/_backend/utils/app_onboarding_posthog.ts'
import { refreshAppOnboardingTodoBatch } from '../supabase/functions/_backend/utils/app_onboarding_todo_refresh.ts'

const mocks = vi.hoisted(() => ({ names: vi.fn(), send: vi.fn(), close: vi.fn(), track: vi.fn(), batch: vi.fn(), log: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: async () => ({}), getDrizzleClient: () => ({ execute: mocks.names }), closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({ sendEventToTracking: mocks.send }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track, trackPosthogEventBatch: mocks.batch }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlogErr: mocks.log, serializeError: String }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: async (_c: unknown, task: Promise<unknown>) => await task }))

const input = { appId: 'com.example.app', orgId: 'org-id', appName: 'Example app', orgName: 'Example org' }
const change = (stepId: AppOnboardingStepHistoryChange['stepId'], status: AppOnboardingStepHistoryChange['status'] = 'done'): AppOnboardingStepHistoryChange => ({ stepId, status, at: '2026-10-25T10:00:00Z', historyLength: 1, historyFull: false })
const committed = (historyChanges: AppOnboardingStepHistoryChange[]) => ({ appId: input.appId, orgId: input.orgId, onboarding: {}, historyChanges })
const c = { get: (key: string) => key === 'auth' ? { authType: 'jwt', userId: 'user-id' } : 'request-id' } as any

beforeEach(() => {
  vi.clearAllMocks()
  mocks.names.mockResolvedValue({ rows: [{ app_id: input.appId, owner_org: input.orgId, app_name: input.appName, org_name: input.orgName }] })
})

describe('onboarding milestone Bento payloads', () => {
  it.concurrent('uses the existing CLI OTA signal and de-duplication key', () => {
    expect(buildAppOnboardingMilestoneBentoEvent({ ...input, change: change('test_update') })).toEqual({
      cron: '* * * * *', event: 'app:updated', preferenceKey: 'onboarding', uniqId: `app:updated:${input.appId}`,
      data: { org_id: input.orgId, org_name: input.orgName, app_name: input.appName },
    })
  })

  it.concurrent.each(['ios', 'android'] as const)('uses the existing Builder completion payload for %s', (platform) => {
    expect(buildAppOnboardingMilestoneBentoEvent({ ...input, change: change(`builder.${platform}.successful_cloud_build`) })).toEqual({
      cron: '* * * * *', event: 'builder_onboarding_completed', preferenceKey: 'builder_onboarding',
      uniqId: `builder_onboarding_completed:${input.appId}:${platform}`,
      data: { org_id: input.orgId, org_name: input.orgName, app_id: input.appId, app_name: input.appName, platform, step: 'build-complete' },
    })
  })

  it.concurrent.each([
    ['test_update', 'skipped'], ['test_update', 'blocked'],
    ['builder.ios.successful_cloud_build', 'warning'], ['builder.android.successful_cloud_build', 'skipped'],
    ['add_code', 'done'], ['add_updater', 'done'], ['upload_bundle', 'done'], ['builder.ios.prepare_profile', 'done'],
    ['builder.web.successful_cloud_build', 'done'],
  ])('ignores %s with status %s', (stepId, status) => {
    expect(buildAppOnboardingMilestoneBentoEvent({ ...input, change: change(stepId as any, status as any) })).toBeUndefined()
  })
})

describe('committed milestone hooks', () => {
  it.each([emitCommittedAppOnboardingHistory, emitCommittedSystemAppOnboardingHistory])('sends milestones through %s without adding PostHog events', async (emit) => {
    await emit(c, [committed([change('test_update'), change('builder.android.successful_cloud_build'), change('add_code')])])
    expect(mocks.names).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.track).toHaveBeenCalledTimes(3)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.send).toHaveBeenCalledWith(c, expect.objectContaining({
      groups: { organization: input.orgId }, sentToBento: true,
      bento: buildAppOnboardingMilestoneBentoEvent({ ...input, change: change('test_update') }),
    }), { posthog: false, background: false })
    expect(mocks.send).toHaveBeenCalledWith(c, expect.objectContaining({
      bento: buildAppOnboardingMilestoneBentoEvent({ ...input, change: change('builder.android.successful_cloud_build') }),
    }), { posthog: false, background: false })
  })

  it('does no lookup or sending for unchanged history or unrelated steps', async () => {
    await emitCommittedAppOnboardingBento(c, [committed([]), committed([change('add_code'), change('builder.ios.successful_cloud_build', 'warning')])])
    expect(mocks.names).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('keeps committed progress and PostHog delivery when the name lookup fails', async () => {
    mocks.names.mockRejectedValueOnce(new Error('lookup unavailable'))
    await emitCommittedSystemAppOnboardingHistory(c, [committed([change('test_update')])])
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledOnce()
  })

  it.each(['ota', 'builder'])('sends the %s cron milestones after commit with one lookup for 25 apps, and no signals on replay', async (path) => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      app_id: `com.example.batch.${i}`, owner_org: input.orgId,
      onboarding: { setup: {
        todo_list_version: 4, outcome: 'in_progress', paths: [path],
        ...(path === 'ota' ? { ota_todo_list_version: '1', steps: { ota: {} } } : { builder_todo_list_version: '1', steps: { builder: { ios: { successful_cloud_build: { status: 'pending' } } } } }),
      } },
    }))
    let didCommit = false
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    tx.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows })
    const database = {
      execute: vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: path === 'ota' ? [] : rows.map(row => ({ app_id: row.app_id, platform: 'ios', succeeded: true, failed: false })) }),
      transaction: async (fn: any) => { const result = await fn(tx); didCommit = true; return result },
    } as any
    mocks.names.mockImplementation(async () => {
      expect(didCommit).toBe(true)
      return { rows: rows.map(row => ({ ...row, app_name: input.appName, org_name: input.orgName })) }
    })
    const body = { appIds: rows.map(row => row.app_id), queuedAt: '2026-10-25T10:00:00Z' }
    const options = { gatherEvidence: async () => ({ channel: new Set<string>(), device: new Set<string>(), bundle: new Set<string>(), update: new Set(path === 'ota' ? body.appIds : []), errors: [] }) }
    expect(await refreshAppOnboardingTodoBatch(c, database, body, options)).toMatchObject({ updated: 25 })
    expect(mocks.names).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledTimes(25)
    expect(mocks.send.mock.calls[0][1].bento).toMatchObject({
      event: path === 'ota' ? 'app:updated' : 'builder_onboarding_completed',
      data: { app_name: input.appName, org_name: input.orgName, ...(path === 'builder' ? { platform: 'ios', step: 'build-complete' } : {}) },
    })
    expect(mocks.batch).toHaveBeenCalledOnce()
    // Read the actual persisted JSON on replay so no transition is fabricated.
    const updateQuery = tx.execute.mock.calls[2][0]
    const updates = JSON.parse(updateQuery.queryChunks.find((chunk: any) => typeof chunk === 'string' && chunk.startsWith('[{')))
    const replayRows = rows.map(row => ({ ...row, onboarding: updates.find((update: any) => update.app_id === row.app_id).onboarding }))
    database.execute.mockResolvedValueOnce({ rows: replayRows })
    tx.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: replayRows })
    expect(await refreshAppOnboardingTodoBatch(c, database, body, options)).toMatchObject({ steps: 0 })
    expect(mocks.names).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledTimes(25)
  })
})
