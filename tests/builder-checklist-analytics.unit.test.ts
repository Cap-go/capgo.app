import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBuilderChecklistUpdate,
  getBuilderChecklistUpdateFromAnalytics,
  markBuilderChecklistFromAnalytics,
} from '../supabase/functions/_backend/utils/builder_onboarding_checklist.ts'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  execute: vi.fn(),
  permission: vi.fn(),
  track: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: mocks.close,
  getDrizzleClient: () => ({ transaction: mocks.transaction }),
  getPgClient: () => ({}),
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermissionPg: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: async (_c: unknown, task: Promise<unknown>) => await task }))

const FIXED_NOW = '2026-09-22T12:00:00.000Z'
function event(tags: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    channel: 'builder-onboarding',
    event: 'Builder Onboarding Action',
    tags: { platform: 'ios', ...tags },
    ...overrides,
  } as any
}

function onboarding(step = 'choose_destination', state: Record<string, unknown> = { status: 'pending' }) {
  return {
    feature_flag: { keep: true },
    setup: {
      todo_list_version: 4,
      builder_todo_list_version: '1',
      paths: ['builder'],
      selected_path: 'builder',
      outcome: 'in_progress',
      steps: {
        ota: { login_cli_mcp: { status: 'pending' } },
        builder: {
          ios: {
            start_setup: { status: 'pending' },
            choose_destination: { status: 'pending' },
            connect_app_store: { status: 'pending' },
            prepare_certificate: { status: 'pending' },
            prepare_profile: { status: 'pending' },
            successful_cloud_build: { status: 'pending' },
            [step]: state,
          },
          android: { prepare_keystore: { status: 'pending' } },
        },
      },
    },
  }
}

function context() {
  return ({
    env: {},
    get: (key: string) => {
      if (key === 'auth')
        return { authType: 'apikey', userId: '11111111-1111-4111-8111-111111111111', apikey: { key: 'fixture-key' } }
      if (key === 'capgkey')
        return 'header-key'
      if (key === 'requestId')
        return 'request-id'
      return undefined
    },
  }) as Context<MiddlewareKeyVariables>
}

function lockedRow(value: unknown) {
  mocks.execute
    .mockResolvedValueOnce({ rows: [{ owner_org: '22222222-2222-4222-8222-222222222222' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ onboarding: value, owner_org: '22222222-2222-4222-8222-222222222222', need_onboarding: true }] })
    .mockResolvedValue({ rows: [] })
}

describe('builder checklist analytics mapping', () => {
  it.each([
    [{ action: 'question_answered', question_id: 'ios_setup_method', choice: 'create-new' }, { step: 'choose_destination', status: 'done', annotation: 'asc_new', annotationType: 'note' }],
    [{ action: 'question_answered', question_id: 'ios_setup_method', choice: 'import-existing' }, { step: 'choose_destination', status: 'pending' }],
    [{ action: 'question_skipped', question_id: 'ios_setup_method', choice: 'create-new', reason: 'non_macos_auto_create_new' }, { step: 'choose_destination', status: 'skipped', annotation: 'asc_new_auto', annotationType: 'note' }],
    [{ action: 'question_answered', question_id: 'ios_import_distribution', choice: 'app_store' }, { step: 'choose_destination', status: 'done', annotation: 'import_app_store', annotationType: 'note' }],
    [{ action: 'question_answered', question_id: 'ios_import_distribution', choice: 'ad_hoc' }, { step: 'choose_destination', status: 'done', annotation: 'import_ad_hoc', annotationType: 'note' }],
    [{ action: 'question_answered', question_id: 'ios_import_distribution', choice: 'switch_to_create_new' }, { step: 'choose_destination', status: 'done', annotation: 'asc_new', annotationType: 'note' }],
    [{ action: 'credential_verified', credential: 'ios_app_store_connect_api_key' }, { step: 'connect_app_store', status: 'done' }],
    [{ action: 'credential_verification_failed', credential: 'ios_app_store_connect_api_key', source: 'guided_helper' }, { step: 'connect_app_store', status: 'warning', annotation: 'asc_key_verification_failed', annotationType: 'warning' }],
    [{ action: 'certificate_prepared', source: 'created' }, { step: 'prepare_certificate', status: 'done' }],
    [{ action: 'certificate_preparation_failed', source: 'created', reason: 'certificate_limit' }, { step: 'prepare_certificate', status: 'warning', annotation: 'ios_certificate_limit_reached', annotationType: 'warning' }],
    [{ action: 'certificate_preparation_failed', source: 'created', reason: 'create_failed' }, { step: 'prepare_certificate', status: 'warning', annotation: 'ios_certificate_creation_failed', annotationType: 'warning' }],
    [{ action: 'certificate_preparation_failed', source: 'keychain_import', reason: 'export_failed' }, { step: 'prepare_certificate', status: 'warning', annotation: 'ios_certificate_export_failed', annotationType: 'warning' }],
  ])('maps %j', (tags, expected) => {
    expect(getBuilderChecklistUpdateFromAnalytics(event(tags))).toEqual({ platform: 'ios', ...expected })
  })

  it.each([
    event({ action: 'question_shown', question_id: 'ios_setup_method' }),
    event({ action: 'question_answered', question_id: 'ios_import_distribution', choice: '__cancel__' }),
    event({ action: 'credential_verified', credential: 'different_key' }),
    event({ action: 'certificate_preparation_failed', source: 'created', reason: 'unknown' }),
    event({ action: 'certificate_prepared', source: 'manual' }),
    event({ action: 'certificate_prepared', source: 'created' }, { channel: 'other' }),
    event({ action: 'certificate_prepared', source: 'created' }, { event: 'Builder Onboarding Step' }),
    event({ action: 'certificate_prepared', source: 'created' }, { tags: { platform: 'android', action: 'certificate_prepared', source: 'created' } }),
  ])('ignores unrelated or incomplete analytics %#', (input) => {
    expect(getBuilderChecklistUpdateFromAnalytics(input)).toBeNull()
  })
})

describe('builder checklist analytics updates', () => {
  it('updates only the existing iOS Builder step and preserves other paths', () => {
    const current = onboarding()
    const result = applyBuilderChecklistUpdate(current, {
      platform: 'ios',
      step: 'choose_destination',
      status: 'done',
      annotation: 'asc_new',
      annotationType: 'note',
    }, () => FIXED_NOW) as any

    expect(result.setup.steps.builder.ios.choose_destination).toEqual({ status: 'done', at: FIXED_NOW, annotation: 'asc_new', annotation_type: 'note' })
    expect(result.setup.steps.builder.android).toEqual(current.setup.steps.builder.android)
    expect(result.setup.steps.ota).toEqual(current.setup.steps.ota)
    expect(result.feature_flag).toEqual({ keep: true })
    expect(current.setup.steps.builder.ios.choose_destination).toEqual({ status: 'pending' })
  })

  it('clears a warning after success and preserves unknown step fields', () => {
    const result = applyBuilderChecklistUpdate(onboarding('connect_app_store', {
      status: 'warning',
      annotation: 'asc_key_verification_failed',
      annotation_type: 'warning',
      custom: 'keep',
    }), { platform: 'ios', step: 'connect_app_store', status: 'done' }, () => FIXED_NOW) as any

    expect(result.setup.steps.builder.ios.connect_app_store).toEqual({ status: 'done', at: FIXED_NOW, custom: 'keep' })
  })

  it('does not replace completed evidence with a later warning', () => {
    const current = onboarding('prepare_certificate', { status: 'done', at: 'earlier' })
    expect(applyBuilderChecklistUpdate(current, {
      platform: 'ios',
      step: 'prepare_certificate',
      status: 'warning',
      annotation: 'ios_certificate_creation_failed',
      annotationType: 'warning',
    }, () => FIXED_NOW)).toBeNull()
  })

  it('resets destination to pending when the user switches to import', () => {
    const current = onboarding('choose_destination', { status: 'done', at: 'earlier', annotation: 'asc_new', annotation_type: 'note' })
    const result = applyBuilderChecklistUpdate(current, { platform: 'ios', step: 'choose_destination', status: 'pending' }, () => FIXED_NOW) as any
    expect(result.setup.steps.builder.ios.choose_destination).toEqual({ status: 'pending' })
  })

  it('is idempotent for an identical completed state', () => {
    const current = onboarding('choose_destination', { status: 'done', at: 'earlier', annotation: 'asc_new', annotation_type: 'note' })
    expect(applyBuilderChecklistUpdate(current, {
      platform: 'ios',
      step: 'choose_destination',
      status: 'done',
      annotation: 'asc_new',
      annotationType: 'note',
    }, () => FIXED_NOW)).toBeNull()
  })

  it.each([
    { setup: { todo_list_version: 3, steps: {} } },
    { setup: { ...onboarding().setup, builder_todo_list_version: '2' } },
    { setup: { ...onboarding().setup, paths: ['ota'] } },
    { setup: { ...onboarding().setup, outcome: 'skipped' } },
    { setup: { ...onboarding().setup, steps: { builder: { ios: {} } } } },
  ])('does not create or update unsupported checklist shapes %#', (current) => {
    expect(applyBuilderChecklistUpdate(current, { platform: 'ios', step: 'choose_destination', status: 'done' }, () => FIXED_NOW)).toBeNull()
  })
})

describe('builder checklist analytics authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (fn: any) => fn({ execute: mocks.execute }))
  })

  it('checks write permissions under the app lock before updating', async () => {
    lockedRow(onboarding())
    mocks.permission.mockImplementation(async (_c, permission) => permission === 'app.update_settings')

    await expect(markBuilderChecklistFromAnalytics(context(), 'com.test.builder', event({
      action: 'question_answered',
      question_id: 'ios_setup_method',
      choice: 'create-new',
    }))).resolves.toBe(true)

    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'app.update_settings', { appId: 'com.test.builder' }, expect.anything(), expect.any(String), 'fixture-key')
    expect(mocks.execute).toHaveBeenCalledTimes(4)
    expect(mocks.track).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'App Onboarding Step Changed',
      nonPersonTags: expect.objectContaining({ step_id: 'builder.ios.choose_destination', step_status: 'done' }),
    }))
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('does not update when the caller has neither accepted write permission', async () => {
    lockedRow(onboarding())
    mocks.permission.mockResolvedValue(false)

    await expect(markBuilderChecklistFromAnalytics(context(), 'com.test.builder', event({
      action: 'credential_verified',
      credential: 'ios_app_store_connect_api_key',
    }))).resolves.toBe(false)

    expect(mocks.permission).toHaveBeenNthCalledWith(1, expect.anything(), 'app.update_settings', { appId: 'com.test.builder' }, expect.anything(), expect.any(String), 'fixture-key')
    expect(mocks.permission).toHaveBeenNthCalledWith(2, expect.anything(), 'org.create_app', { orgId: '22222222-2222-4222-8222-222222222222' }, expect.anything(), expect.any(String), 'fixture-key')
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('keeps the analytics request best-effort when persistence fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(markBuilderChecklistFromAnalytics(context(), 'com.test.builder', event({
      action: 'certificate_prepared',
      source: 'created',
    }))).resolves.toBe(false)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})
