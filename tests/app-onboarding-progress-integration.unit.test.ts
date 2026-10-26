// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AppOnboardingFlow from '../src/components/dashboard/AppOnboardingFlow.vue'
import { sendOnboardingEvent } from '../src/services/onboardingTracking'

const writerMocks = vi.hoisted(() => ({
  abTestAssignments: {} as Record<string, unknown>,
  dialog: {
    lastButtonRole: null as string | null,
    onDialogDismiss: vi.fn(async () => undefined),
    openDialog: vi.fn(),
  },
  loadApp: vi.fn(),
  main: {
    auth: { id: 'user-bento-retry' },
    authGeneration: 1,
    awaitInitialLoad: vi.fn(async () => undefined),
    isAdmin: false,
    plans: [],
    user: {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: {},
    },
  },
  organization: {
    getOrgByAppId: vi.fn(),
    setCurrentOrganization: vi.fn(),
    awaitInitialLoad: vi.fn(async () => undefined),
    currentOrganization: null as { gid: string, name: string, onboarding?: unknown } | null,
    organizations: [],
    updateAppOnboarding: vi.fn(),
    upsertOrganizationApp: vi.fn(),
  },
  refreshUser: vi.fn(),
  replaceUserOnboardingIfUnchanged: vi.fn(),
  route: { query: {} as Record<string, string> },
  router: {
    push: vi.fn(),
    replace: vi.fn(async () => undefined),
  },
  sendOnboardingEvent: vi.fn(),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({
  useRoute: () => writerMocks.route,
  useRouter: () => writerMocks.router,
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../src/components/dashboard/ChannelDefaultRoutingOnboarding.vue', () => ({
  default: { template: '<div data-test="resumed-channel-routing" />' },
}))
vi.mock('../src/components/dashboard/ChannelSelfAssignOnboarding.vue', () => ({
  default: { template: '<div data-test="resumed-channel-self-assign" />' },
}))
vi.mock('../src/components/dashboard/ChannelConsoleAssignOnboarding.vue', () => ({
  default: { template: '<div data-test="resumed-channel-console-assign" />' },
}))
vi.mock('../src/components/dashboard/ChannelCreateOnboarding.vue', () => ({
  default: {
    emits: ['continue'],
    template: '<button type="button" data-test="resumed-channel-create" @click="$emit(\'continue\')" />',
  },
}))
vi.mock('~/services/apikeys', () => ({
  createDefaultApiKey: vi.fn(),
  findUsablePlainApiKey: vi.fn(async () => 'test-api-key'),
  shareInFlightApiKeyLoad: vi.fn(async (_key: unknown, load: () => Promise<unknown>) => load()),
}))
vi.mock('~/services/onboardingTracking', () => ({
  APP_ONBOARDING_READY_EVENT: 'app:onboarding_ready',
  sendOnboardingEvent: writerMocks.sendOnboardingEvent,
}))
vi.mock('~/services/capgoApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/capgoApi')>()
  return {
    ...actual,
    invokeCapgoApi: vi.fn(async () => ({ data: { assignments: writerMocks.abTestAssignments }, error: null })),
  }
})
vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.capgo.app' }),
  isLocal: () => false,
  useConsole: () => {
    return {
      from: (table: string) => {
        const query = {
          update: (payload: { onboarding: unknown }) => ({
            eq: (userId: string) => ({
              filter: (_column: string, _operator: string, expected: string) => ({
                select: () => ({ maybeSingle: () => writerMocks.replaceUserOnboardingIfUnchanged(userId, JSON.parse(expected), payload.onboarding) }),
              }),
            }),
          }),
          eq: () => query,
          maybeSingle: writerMocks.refreshUser,
          select: () => query,
          single: table === 'apps' ? writerMocks.loadApp : vi.fn(),
        }
        return query
      },
      rpc: vi.fn(async () => ({ data: null, error: null })),
    }
  },
}))
vi.mock('~/services/userOnboardingWriteQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/userOnboardingWriteQueue')>()
  return {
    ...actual,
    replaceUserOnboardingIfUnchanged: writerMocks.replaceUserOnboardingIfUnchanged,
  }
})
vi.mock('~/stores/dashboardApps', () => ({ useDashboardAppsStore: () => ({ upsertApp: vi.fn() }) }))
vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => writerMocks.dialog,
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => writerMocks.main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => writerMocks.organization }))

describe('app onboarding progress analytics integration', () => {
  it('automatically resumes the saved channel screen without opening a dialog in both flows', async () => {
    const previousUser = writerMocks.main.user
    const previousAuthGeneration = writerMocks.main.authGeneration
    const previousRouteQuery = writerMocks.route.query
    const previousOrganization = writerMocks.organization.currentOrganization
    const previousAssignments = writerMocks.abTestAssignments
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const attemptId = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'
    const previousRunId = 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276'
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) })

    try {
      for (const [preOrg, openedFromGettingStarted, stage] of [
        [true, false, 'channel-create'],
        [true, true, 'channel-self-assign'],
        [false, true, 'channel-console-assign'],
      ] as const) {
        const appId = `com.example.resume.${stage}`
        const abtests = { new_channel: { assigned_at: '2026-09-21T00:00:00.000Z', branch: 'A' } }
        writerMocks.abTestAssignments = abtests
        writerMocks.route.query = {}
        writerMocks.router.replace.mockClear()
        writerMocks.organization.currentOrganization = { gid: 'test-org', name: 'Test Org' }
        writerMocks.main.user = {
          id: 'user-bento-retry',
          image_url: 'avatar.png',
          first_name: 'Example',
          last_name: 'User',
          onboarding: {
            profile_completed_at: '2026-10-20T10:00:00.000Z',
            abtests,
            app_id: appId,
            final_step: preOrg ? 'setup' : 'install',
            flow: preOrg ? 'pre_org' : 'existing_org',
            last_run_id: previousRunId,
            onboarding_attempt_id: attemptId,
            setup_stage: stage,
            status: 'in_progress',
            step: 'channel',
            updated_at: '2026-09-21T00:00:00.000Z',
          },
        }
        writerMocks.loadApp.mockResolvedValue({
          data: {
            android_store_url: null,
            app_id: appId,
            existing_app: true,
            icon_url: null,
            ios_store_url: null,
            name: 'Test App',
            onboarding: { setup: { todo_list_version: 3, steps: {} } },
            owner_org: 'test-org',
          },
          error: null,
        })
        writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
          data: { ...writerMocks.main.user, onboarding },
          error: null,
        }))
        writerMocks.dialog.openDialog.mockClear()
        if (!openedFromGettingStarted) {
          // The pre-org creation page forwards a saved setup resume to Getting started.
          vi.mocked(sendOnboardingEvent).mockClear()
          const creationContainer = document.createElement('div')
          const creationApp = createApp(AppOnboardingFlow, { onboarding: true, preOrg })
          creationApp.config.warnHandler = () => undefined
          try {
            creationApp.mount(creationContainer)
            await vi.waitFor(() => expect(writerMocks.router.replace).toHaveBeenCalledWith(`/app/${appId}/getting-started`))
            expect(creationContainer.querySelector(`[data-test="resumed-${stage}"]`)).toBeNull()
            expect(writerMocks.dialog.openDialog).not.toHaveBeenCalled()
            expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_resume_dialog_viewed')).toBe(false)
            expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed')).toBe(false)
          }
          finally {
            creationApp.unmount()
            await new Promise(resolve => setTimeout(resolve, 0))
          }
          writerMocks.main.authGeneration += 1
        }
        vi.mocked(sendOnboardingEvent).mockClear()
        const container = document.createElement('div')
        const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg, setupAppId: appId })
        app.config.warnHandler = () => undefined
        try {
          app.mount(container)
          await vi.waitFor(() => expect(container.querySelector(`[data-test="resumed-${stage}"]`), `Expected ${stage} in ${preOrg ? 'pre_org' : 'existing_org'} resume`).not.toBeNull())
          await vi.waitFor(() => expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'channel')).toBe(true))
          expect(writerMocks.dialog.openDialog).not.toHaveBeenCalled()
          const skipped = vi.mocked(sendOnboardingEvent).mock.calls.filter(call => call[0] === 'onboarding_resume_dialog_skipped')
          expect(skipped).toHaveLength(1)
          expect(skipped[0]?.[1]).toMatchObject({
            channel_stage: stage,
            flow: preOrg ? 'pre_org' : 'existing_org',
            onboarding_attempt_id: attemptId,
            resumed_from_run_id: previousRunId,
            saved_step: 'channel',
          })
          const channelView = vi.mocked(sendOnboardingEvent).mock.calls.find(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'channel')
          expect(channelView?.[1]).toMatchObject({
            onboarding_attempt_id: attemptId,
            onboarding_run_id: skipped[0]?.[1]?.onboarding_run_id,
            resumed: true,
          })
          expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_resume_dialog_viewed')).toBe(false)
        }
        finally {
          app.unmount()
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        writerMocks.main.authGeneration += 1
      }
    }
    finally {
      writerMocks.main.user = previousUser
      writerMocks.main.authGeneration = previousAuthGeneration
      writerMocks.route.query = previousRouteQuery
      writerMocks.organization.currentOrganization = previousOrganization
      writerMocks.abTestAssignments = previousAssignments
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('records a final setup view only after the saved setup screen renders', async () => {
    const previousUser = writerMocks.main.user
    const previousRouteQuery = writerMocks.route.query
    const previousOrganization = writerMocks.organization.currentOrganization
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    writerMocks.route.query = {}
    writerMocks.organization.currentOrganization = { gid: 'test-org', name: 'Test Org' }
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: {
        profile_completed_at: '2026-10-20T10:00:00.000Z',
        app_id: 'com.example.final',
        final_step: 'setup',
        flow: 'pre_org',
        setup_stage: 'cli',
        status: 'in_progress',
        step: 'setup',
        updated_at: '2026-09-21T00:00:00.000Z',
      },
    }
    writerMocks.loadApp.mockResolvedValue({
      data: {
        android_store_url: null,
        app_id: 'com.example.final',
        existing_app: true,
        icon_url: null,
        ios_store_url: null,
        name: 'Test App',
        onboarding: { setup: { todo_list_version: 3, steps: {} } },
        owner_org: 'test-org',
      },
      error: null,
    })
    writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
      data: { ...writerMocks.main.user, onboarding },
      error: null,
    }))
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) })
    vi.mocked(sendOnboardingEvent).mockClear()
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: true, setupAppId: 'com.example.final' })
    app.config.warnHandler = () => undefined
    try {
      app.mount(container)
      await vi.waitFor(() => expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'setup')).toBe(true))
      expect(container.querySelector('[data-test="onboarding-setup-cli"]')).not.toBeNull()
      expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'channel')).toBe(false)
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      writerMocks.route.query = previousRouteQuery
      writerMocks.organization.currentOrganization = previousOrganization
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it.each([true, false])('leaves Getting started for the app page when its app cannot load (preOrg=%s)', async (preOrg) => {
    const previousUser = writerMocks.main.user
    const previousOrganization = writerMocks.organization.currentOrganization
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    writerMocks.organization.currentOrganization = { gid: 'test-org', name: 'Test Org' }
    // Saved setup for another app must not hijack Getting started for this one.
    writerMocks.main.user = {
      id: 'user-missing-app',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: {
        profile_completed_at: '2026-10-20T10:00:00.000Z',
        app_id: 'com.example.other',
        final_step: 'setup',
        flow: 'pre_org',
        setup_stage: 'cli',
        status: 'in_progress',
        step: 'setup',
        updated_at: '2026-09-21T00:00:00.000Z',
      },
    }
    writerMocks.loadApp.mockResolvedValue({ data: null, error: { message: 'not found' } })
    writerMocks.router.replace.mockClear()
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg, setupAppId: 'com.example.missing' })
    app.config.warnHandler = () => undefined
    try {
      app.mount(container)
      await vi.waitFor(() => expect(writerMocks.router.replace).toHaveBeenCalledWith('/app/com.example.missing'))
      expect(writerMocks.router.replace).not.toHaveBeenCalledWith('/app/com.example.other/getting-started')
      expect(container.querySelector('[data-test="app-onboarding-name"]')).toBeNull()
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      writerMocks.organization.currentOrganization = previousOrganization
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('continues the creation attempt when Getting started receives the setup handoff', async () => {
    const previousUser = writerMocks.main.user
    const previousOrganization = writerMocks.organization.currentOrganization
    const previousAssignments = writerMocks.abTestAssignments
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const previousHistoryState: unknown = window.history.state
    const appId = 'com.example.handoff'
    const attemptId = '0c8f5d4e-7a1b-4c3d-9e2f-1a2b3c4d5e6f'
    const runId = 'ir_5f1e2d3c-4b5a-4968-8776-655443322110'
    const abtests = { new_channel: { assigned_at: '2026-09-21T00:00:00.000Z', branch: 'A' } }
    writerMocks.abTestAssignments = abtests
    writerMocks.organization.currentOrganization = { gid: 'test-org', name: 'Test Org' }
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: {
        profile_completed_at: '2026-10-20T10:00:00.000Z',
        abtests,
        app_id: appId,
        flow: 'existing_org',
        last_run_id: runId,
        onboarding_attempt_id: attemptId,
        setup_stage: 'channel-routing',
        status: 'in_progress',
        step: 'channel',
        updated_at: '2026-09-21T00:00:00.000Z',
      },
    }
    writerMocks.loadApp.mockReset()
    writerMocks.loadApp.mockResolvedValue({
      data: {
        android_store_url: null,
        app_id: appId,
        existing_app: true,
        icon_url: null,
        ios_store_url: null,
        name: 'Handoff App',
        onboarding: { setup: { todo_list_version: 3, steps: {} } },
        owner_org: 'test-org',
      },
      error: null,
    })
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
      data: { ...writerMocks.main.user, onboarding },
      error: null,
    }))
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) })
    window.history.replaceState({
      capgoOnboardingSetupHandoff: { appId, attemptId, flow: 'existing_org', previousStep: 'app_icon', runId },
      unrelated: 'kept',
    }, '')
    vi.mocked(sendOnboardingEvent).mockClear()
    writerMocks.dialog.openDialog.mockClear()
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: false, setupAppId: appId })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(container.querySelector('[data-test="resumed-channel-routing"]')).not.toBeNull())
      await vi.waitFor(() => expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'channel')).toBe(true))

      const channelView = vi.mocked(sendOnboardingEvent).mock.calls.find(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === 'channel')
      expect(channelView?.[1]).toMatchObject({
        flow: 'existing_org',
        onboarding_attempt_id: attemptId,
        onboarding_run_id: runId,
        previous_step: 'app_icon',
        resumed: false,
      })
      expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_resume_dialog_skipped')).toBe(false)
      expect(writerMocks.dialog.openDialog).not.toHaveBeenCalled()
      // A reload of Getting started is a new visit, not the creation handoff.
      expect(window.history.state).toEqual({ unrelated: 'kept' })
    }
    finally {
      app.unmount()
      await new Promise(resolve => setTimeout(resolve, 0))
      window.history.replaceState(previousHistoryState, '')
      writerMocks.main.user = previousUser
      writerMocks.main.authGeneration += 1
      writerMocks.organization.currentOrganization = previousOrganization
      writerMocks.abTestAssignments = previousAssignments
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('uses the explicit todo-list override when resuming either onboarding flow', async () => {
    const previousUser = writerMocks.main.user
    const previousAuthGeneration = writerMocks.main.authGeneration
    const previousRouteQuery = writerMocks.route.query
    const previousOrganization = writerMocks.organization.currentOrganization
    const previousAssignments = writerMocks.abTestAssignments
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })

    try {
      for (const preOrg of [true, false]) {
        for (const [channelBranch, todoBranch, expectsChannel] of [
          ['A', undefined, true],
          ['A', 'A', false],
          ['A', 'B', true],
          ['B', 'A', false],
        ] as const) {
          const appId = `com.example.channel.${preOrg ? 'pre' : 'existing'}.${channelBranch}.${todoBranch ?? 'none'}`
          const abtests = {
            new_channel: { assigned_at: '2026-09-21T00:00:00.000Z', branch: channelBranch },
            ...(todoBranch ? { ota_todo_list_v3: { assigned_at: '2026-09-21T00:00:00.000Z', branch: todoBranch } } : {}),
          }
          writerMocks.route.query = {}
          writerMocks.organization.currentOrganization = { gid: 'test-org', name: 'Test Org' }
          writerMocks.abTestAssignments = abtests
          writerMocks.main.user = {
            id: 'user-bento-retry',
            image_url: 'avatar.png',
            first_name: 'Example',
            last_name: 'User',
            onboarding: {
              profile_completed_at: '2026-10-20T10:00:00.000Z',
              abtests,
              app_id: appId,
              final_step: preOrg ? 'setup' : 'install',
              flow: preOrg ? 'pre_org' : 'existing_org',
              setup_stage: 'channel-routing',
              status: 'in_progress',
              step: 'channel',
              updated_at: '2026-09-21T00:00:00.000Z',
            },
          }
          writerMocks.loadApp.mockResolvedValue({
            data: {
              android_store_url: null,
              app_id: appId,
              existing_app: true,
              icon_url: null,
              ios_store_url: null,
              name: 'Test App',
              onboarding: { setup: { todo_list_version: todoBranch === 'A' ? 4 : 2, ota_todo_list_version: todoBranch === 'A' ? '1' : undefined, steps: {} } },
              owner_org: 'test-org',
            },
            error: null,
          })
          writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
            data: { ...writerMocks.main.user, onboarding },
            error: null,
          }))
          vi.mocked(sendOnboardingEvent).mockClear()
          const container = document.createElement('div')
          const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg, setupAppId: appId })
          app.config.warnHandler = () => undefined
          try {
            app.mount(container)
            await vi.waitFor(() => expect(vi.mocked(sendOnboardingEvent).mock.calls.some(call => call[0] === 'onboarding_step_viewed' && call[1]?.step === (expectsChannel ? 'channel' : 'setup'))).toBe(true))
            const viewed = vi.mocked(sendOnboardingEvent).mock.calls.filter(call => call[0] === 'onboarding_step_viewed')
            expect(viewed.some(call => call[1]?.step === 'channel')).toBe(expectsChannel)
            expect(viewed.some(call => call[1]?.step === 'setup')).toBe(!expectsChannel)
            expect(viewed.some(call => call[1]?.step === 'install')).toBe(false)
            expect(container.querySelector('[data-test="resumed-channel-routing"]') !== null).toBe(expectsChannel)
            expect(vi.mocked(sendOnboardingEvent).mock.calls.filter(call => call[0] === 'onboarding_resume_dialog_skipped')).toHaveLength(1)
          }
          finally {
            app.unmount()
            await new Promise(resolve => setTimeout(resolve, 0))
          }

          writerMocks.main.authGeneration += 1
        }
      }
    }
    finally {
      writerMocks.main.user = previousUser
      writerMocks.main.authGeneration = previousAuthGeneration
      writerMocks.route.query = previousRouteQuery
      writerMocks.organization.currentOrganization = previousOrganization
      writerMocks.abTestAssignments = previousAssignments
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('preserves server-owned state from the refreshed CAS snapshot on retry', async () => {
    const previousUser = writerMocks.main.user
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const initialBentoEvents = {
      'cli:command_invoked': {
        details: [{ observed_at: '2026-08-22T10:00:00.000Z' }],
        occurrence_count: 1,
        sent_at: '2026-08-22T10:00:01.000Z',
      },
    }
    const refreshedBentoEvents = {
      'cli:command_invoked': {
        details: [
          { observed_at: '2026-08-22T10:00:00.000Z' },
          { observed_at: '2026-08-22T10:05:00.000Z' },
        ],
        occurrence_count: 2,
        sent_at: '2026-08-22T10:05:01.000Z',
      },
    }
    const initialABTests = {
      new_emails: {
        assigned_at: '2026-08-23T13:15:06.300Z',
        branch: 'A',
      },
    }
    const refreshedABTests = {
      new_emails: {
        assigned_at: '2026-08-23T13:15:06.300Z',
        branch: 'B',
      },
    }
    const initialOnboarding = {
      profile_completed_at: '2026-10-20T10:00:00.000Z',
      abtests: initialABTests,
      bento_events: initialBentoEvents,
      future_server_state: { revision: 1 },
    }
    const refreshedOnboarding = {
      abtests: refreshedABTests,
      bento_events: refreshedBentoEvents,
      future_server_state: { revision: 2 },
    }
    writerMocks.refreshUser.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: initialOnboarding,
    }
    writerMocks.refreshUser.mockResolvedValueOnce({
      data: { ...writerMocks.main.user, onboarding: refreshedOnboarding },
      error: null,
    })
    writerMocks.replaceUserOnboardingIfUnchanged
      .mockResolvedValueOnce({ data: null, error: null })
      .mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
        data: { ...writerMocks.main.user, onboarding },
        error: null,
      }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: true })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(writerMocks.replaceUserOnboardingIfUnchanged).toHaveBeenCalledTimes(2))

      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        abtests: initialABTests,
        bento_events: initialBentoEvents,
        future_server_state: { revision: 1 },
      }))
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[1]).toEqual(refreshedOnboarding)
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
        abtests: refreshedABTests,
        bento_events: refreshedBentoEvents,
        future_server_state: { revision: 2 },
      }))
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]?.abtests).not.toEqual(initialABTests)
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]?.bento_events).not.toEqual(initialBentoEvents)
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('preserves the saved user intent and channel assignment when resuming the first app', async () => {
    const previousUser = writerMocks.main.user
    const previousRouteQuery = writerMocks.route.query
    const previousOrganization = writerMocks.organization.currentOrganization
    const previousAssignments = writerMocks.abTestAssignments
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const assignedAt = '2026-09-11T10:00:00.000Z'
    const currentOnboarding = {
      profile_completed_at: '2026-10-20T10:00:00.000Z',
      abtests: {
        new_channel: {
          assigned_at: assignedAt,
          branch: 'A',
        },
      },
      flow: 'pre_org',
      intent: 'ota',
      status: 'in_progress',
      step: 'organization',
      updated_at: '2026-09-11T10:01:00.000Z',
    }
    writerMocks.route.query = {}
    writerMocks.organization.currentOrganization = {
      gid: 'resumed-org',
      name: 'Resumed Org',
      onboarding: { intent: 'builder' },
    }
    writerMocks.abTestAssignments = currentOnboarding.abtests
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: currentOnboarding,
    }
    writerMocks.loadApp.mockReset()
    writerMocks.loadApp.mockResolvedValue({
      data: {
        android_store_url: null,
        app_id: 'com.example.resumed',
        existing_app: true,
        icon_url: null,
        ios_store_url: null,
        name: 'Resumed App',
        owner_org: 'resumed-org',
      },
      error: null,
    })
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
      data: { ...writerMocks.main.user, onboarding },
      error: null,
    }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: true, setupAppId: 'com.example.resumed' })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(writerMocks.replaceUserOnboardingIfUnchanged).toHaveBeenCalled())

      const persistedOnboarding = writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[0]?.[2]
      expect(persistedOnboarding).toEqual(expect.objectContaining({
        abtests: currentOnboarding.abtests,
        intent: 'ota',
      }))
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      writerMocks.route.query = previousRouteQuery
      writerMocks.organization.currentOrganization = previousOrganization
      writerMocks.abTestAssignments = previousAssignments
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('clears the persisted intent when the user explicitly restarts onboarding', async () => {
    const previousUser = writerMocks.main.user
    const previousDialogRole = writerMocks.dialog.lastButtonRole
    const previousAssignments = writerMocks.abTestAssignments
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const currentOnboarding = {
      profile_completed_at: '2026-10-20T10:00:00.000Z',
      abtests: {
        new_channel: {
          assigned_at: '2026-09-11T10:00:00.000Z',
          branch: 'A',
        },
      },
      flow: 'pre_org',
      intent: 'ota',
      status: 'in_progress',
      step: 'organization',
      updated_at: '2026-09-11T10:01:00.000Z',
    }
    writerMocks.dialog.lastButtonRole = 'onboarding-resume-restart'
    writerMocks.abTestAssignments = currentOnboarding.abtests
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: currentOnboarding,
    }
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
      data: { ...writerMocks.main.user, onboarding },
      error: null,
    }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: true })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(writerMocks.replaceUserOnboardingIfUnchanged).toHaveBeenCalled())

      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[0]?.[2]).not.toHaveProperty('intent')
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      writerMocks.dialog.lastButtonRole = previousDialogRole
      writerMocks.abTestAssignments = previousAssignments
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('emits the pending app ready event only after the final setup screen renders', async () => {
    const previousUser = writerMocks.main.user
    const previousRouteQuery = writerMocks.route.query
    const previousOrganization = writerMocks.organization.currentOrganization
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const pendingApp = {
      android_store_url: null,
      app_id: 'com.example.pending-ready',
      existing_app: true,
      icon_url: null,
      ios_store_url: null,
      name: 'Pending ready app',
      need_onboarding: true,
      onboarding: {},
      owner_org: 'ready-org',
    }
    const abtests = { new_channel: { assigned_at: '2026-09-21T00:00:00.000Z', branch: 'A' } }
    writerMocks.route.query = {}
    writerMocks.organization.currentOrganization = {
      gid: pendingApp.owner_org,
      name: 'Ready Org',
      onboarding: { intent: 'ota' },
    }
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      first_name: 'Example',
      last_name: 'User',
      onboarding: {
        profile_completed_at: '2026-10-20T10:00:00.000Z',
        abtests,
        app_id: pendingApp.app_id,
        flow: 'existing_org',
        setup_stage: 'channel-create',
        status: 'in_progress',
        step: 'channel',
        updated_at: '2026-09-21T00:00:00.000Z',
      },
    }
    writerMocks.loadApp.mockReset()
    writerMocks.loadApp.mockResolvedValue({ data: pendingApp, error: null })
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
      data: { ...writerMocks.main.user, onboarding },
      error: null,
    }))
    writerMocks.sendOnboardingEvent.mockClear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    const clipboardWrite = vi.fn(async () => undefined)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: false, setupAppId: pendingApp.app_id })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(container.querySelector('[data-test="resumed-channel-create"]')).not.toBeNull())
      await nextTick()

      expect(writerMocks.sendOnboardingEvent.mock.calls.filter(([event]) => event === 'app:onboarding_ready')).toHaveLength(0)

      container.querySelector<HTMLButtonElement>('[data-test="resumed-channel-create"]')!.click()
      await nextTick()

      await vi.waitFor(() => expect(container.querySelector('[data-test="onboarding-setup-cli"]')).not.toBeNull())
      await vi.waitFor(() => expect(writerMocks.sendOnboardingEvent).toHaveBeenCalledWith('app:onboarding_ready', {
        app_id: pendingApp.app_id,
        org_id: pendingApp.owner_org,
      }))
      expect(clipboardWrite).not.toHaveBeenCalled()
      expect(writerMocks.sendOnboardingEvent.mock.calls.filter(([event]) => event === 'app:onboarding_ready')).toHaveLength(1)
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      writerMocks.route.query = previousRouteQuery
      writerMocks.organization.currentOrganization = previousOrganization
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
      if (clipboardDescriptor)
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      else
        Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
})
