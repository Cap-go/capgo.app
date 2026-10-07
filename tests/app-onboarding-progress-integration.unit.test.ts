// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { URL as NodeUrl } from 'node:url'
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
vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app', supaKey: 'anon-key' }),
  isLocal: () => false,
  useSupabase: () => {
    return {
      from: (table: string) => {
        const query = {
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

const onboardingSource = readFileSync(new NodeUrl('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const optionsSource = readFileSync(new NodeUrl('../src/components/dashboard/onboardingDevelopmentEnvironmentOptions.ts', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new NodeUrl('../src/composables/useAppNavigation.ts', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new NodeUrl('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

function sourceBetween(start: string, end: string) {
  const startIndex = onboardingSource.indexOf(start)
  const endIndex = onboardingSource.indexOf(end)
  if (startIndex === -1)
    throw new Error(`Missing start marker in AppOnboardingFlow.vue: ${start}`)
  if (endIndex === -1 || endIndex < startIndex)
    throw new Error(`Missing end marker in AppOnboardingFlow.vue: ${end}`)
  return onboardingSource.slice(startIndex, endIndex)
}

function expectSourceOrder(source: string, markers: string[]) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1)
    expect(index, `Expected source marker after previous marker: ${marker}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

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
          onboarding: {
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
      onboarding: {
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
      onboarding: {
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
      onboarding: {
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
            onboarding: {
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

  it.concurrent('forwards document visibility changes and removes the listener on teardown', () => {
    const visibilityHandler = sourceBetween('function trackOnboardingVisibilityChange()', 'function initializeProgressTracking(')
    expect(visibilityHandler).toContain('const visibilityChange = { state: document.visibilityState, occurredAt: Date.now() }')
    expectSourceOrder(visibilityHandler, [
      'if (!progressTracker)',
      'if (isHydratingOnboarding.value || onboardingInitialPersistInFlight)',
      'pendingVisibilityChanges.push(visibilityChange)',
      'return',
    ])
    expect(visibilityHandler).toContain('progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)')
    expect(onboardingSource).toContain(`document.addEventListener('visibilitychange', trackOnboardingVisibilityChange)`)
    expect(onboardingSource).toContain(`document.removeEventListener('visibilitychange', trackOnboardingVisibilityChange)`)

    const initializer = sourceBetween('function initializeProgressTracking(', 'function completeAndViewStep(')
    expectSourceOrder(initializer, [
      'progressTracker.viewStep(initialStep, handoffPreviousStep)',
      'for (const visibilityChange of pendingVisibilityChanges)',
      'progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)',
      'pendingVisibilityChanges = []',
    ])
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

  it.concurrent('initializes tracking once the real initial or resumed step is resolved', () => {
    const analyticsImport = sourceBetween(
      'import {\n  createOnboardingDetailsFieldDebouncer,',
      'import { createOnboardingProgressPersistence',
    )
    expect(analyticsImport).toContain('createOnboardingProgressTracker,')
    expect(analyticsImport).toContain('createOnboardingTelemetryIdentity,')
    expect(analyticsImport).toContain(`} from '~/utils/onboardingProgressAnalytics'`)

    const initializer = sourceBetween('function initializeProgressTracking(', 'function completeAndViewStep(')
    expect(initializer).toContain(`flow: props.preOrg ? 'pre_org' : 'existing_org'`)
    expect(initializer).toContain(`const initialStep: OnboardingAnalyticsStep = showPreOrgWelcome.value ? 'welcome' : analyticsStepFor(flowStep.value)`)
    expect(initializer).toContain('trackedAnalyticsSteps = appOnboardingSteps.value.flatMap<OnboardingAnalyticsStep>')
    expect(initializer).toContain('return Object.values(APP_DETAILS_ANALYTICS_STEPS)')
    expect(initializer).toContain(`trackedAnalyticsSteps.unshift('welcome')`)
    expect(initializer).toContain(`if (initialStep === 'setup' || initialStep === 'install')`)
    expect(initializer).toContain('void viewFinalStepWhenRendered(initialStep, handoffPreviousStep)')
    expect(initializer).toContain('ensurePublishAppQuestionStepTracked()')
    expect(initializer).toContain('steps: trackedAnalyticsSteps')
    // A creation handoff continues the same attempt, so it is not a resume.
    expect(initializer).toContain('resumed: resumed && !setupHandoff,')
    expect(initializer).toContain('onboardingAttemptId: onboardingTelemetry.attemptId')
    expect(initializer).toContain('onboardingRunId: onboardingTelemetry.runId')
    expect(initializer).toContain('const handoffPreviousStep = setupHandoff?.previousStep')
    expect(initializer).toContain('progressTracker.viewStep(initialStep, handoffPreviousStep)')
    expect(initializer.match(/\.viewStep\(/g)).toHaveLength(1)
    expectSourceOrder(onboardingSource, [
      'const setupHandoff = props.setupAppId ? consumeSetupHandoff(props.setupAppId) : null',
      'const onboardingTelemetry = createOnboardingTelemetryIdentity({',
      'continueFrom: setupHandoff,',
    ])

    const resumeDialog = sourceBetween('async function maybeResumeSavedOnboarding()', 'function whiteCardToggleButtonClass(')
    expect(resumeDialog).toContain('onboardingTelemetry.prepareResumeCandidate({')
    expect(resumeDialog).toContain('steps: resumeCandidateSteps(resumableStep)')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeDialogViewed()')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeContinued()')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeRestarted()')
    expect(resumeDialog).not.toContain('.viewStep(')
    expectSourceOrder(resumeDialog, [
      'if (resumableStep === \'channel\' && saved.app_id)',
      'if (await loadResumeApp(saved.app_id))',
      'recordSkippedChannelResumeDialog(saved)',
      'return true',
      'await resetOnboardingForm()',
      'showWelcomeOnDesktop()',
      'return false',
      'onboardingTelemetry.prepareResumeCandidate({',
    ])
    expectSourceOrder(resumeDialog, [
      'onboardingTelemetry.prepareResumeCandidate({',
      'dialogStore.openDialog({',
      'onboardingTelemetry.recordResumeDialogViewed()',
      'await dialogStore.onDialogDismiss()',
    ])

    const restartCheck = `if (dialogStore.lastButtonRole === 'onboarding-resume-restart')`
    expectSourceOrder(resumeDialog, [
      'await dialogStore.onDialogDismiss()',
      'if (onboardingFlowDisposed)',
      'return null',
      restartCheck,
    ])
    const restartBranchStart = resumeDialog.indexOf(restartCheck)
    const restartBranchEnd = resumeDialog.indexOf('\n  }\n', restartBranchStart)
    expect(restartBranchStart).toBeGreaterThan(resumeDialog.indexOf('await dialogStore.onDialogDismiss()'))
    expect(restartBranchEnd).toBeGreaterThan(restartBranchStart)
    const restartBranch = resumeDialog.slice(restartBranchStart, restartBranchEnd)
    expectSourceOrder(restartBranch, [
      restartCheck,
      'onboardingTelemetry.recordResumeRestarted()',
      'await resetOnboardingForm()',
      'return false',
    ])
    const continueCheck = `if (dialogStore.lastButtonRole !== 'onboarding-resume-continue')`
    expectSourceOrder(resumeDialog.slice(restartBranchEnd), [
      continueCheck,
      'return null',
      'onboardingTelemetry.recordResumeContinued()',
      'applyOnboardingProgress(saved)',
      'return true',
    ])
    expect(resumeDialog.match(/return null/g)).toHaveLength(2)

    const resumeLoader = sourceBetween('async function loadResumeApp(', 'async function importStoreMetadata()')
    expect(resumeLoader).not.toContain('initializeProgressTracking')
    expect(resumeLoader).not.toContain('viewStep')
    expect(resumeLoader).not.toContain('finalOnboardingStep')
    expect(resumeLoader).toContain('flowStep.value = resumeFinalStep ? \'setup\' : \'channel\'')
    expectSourceOrder(resumeLoader, [
      'const savedProgress = parseUserOnboardingProgress(main.user?.onboarding)',
      'applyOnboardingProgress(savedProgress)',
      'if (!savedProgress?.intent)',
      'hydrateIntentFromCurrentOrg()',
    ])

    const mountedFlow = sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')
    expect(onboardingSource).toContain(`import { createOnboardingProgressPersistence, shouldInitializeOnboardingProgressTracking } from '~/utils/onboardingProgressPersistence'`)
    expect(mountedFlow).toContain('let resumedFlow = false')
    expectSourceOrder(mountedFlow, [
      'if (props.preOrg)',
      'if (resumeAppId.value)',
      'await organizationStore.awaitInitialLoad()',
      'await waitForOnboardingABTests()',
      'const resumed = await loadResumeApp()',
      'resumedFlow = true',
      'startApiKeyLoading()',
      'return',
      'const resumeResult = await maybeResumeSavedOnboarding()',
    ])
    expectSourceOrder(mountedFlow, [
      'const resumeResult = await maybeResumeSavedOnboarding()',
      'if (resumeResult === null)',
      'onboardingProgressPersistence.abort()',
      'return',
      'if (createdApp.value && (flowStep.value === \'channel\' || flowStep.value === \'setup\'))',
      'onboardingProgressPersistence.abort()',
      'await router.replace(getAppGettingStartedPath(createdApp.value.app_id))',
      'return',
      'resumedFlow = resumeResult',
    ])
    expect(mountedFlow.match(/recordSkippedChannelResumeDialog\(/g)).toHaveLength(2)
    expect(mountedFlow.match(/if \(!setupHandoff\)\n\s+recordSkippedChannelResumeDialog\(/g)).toHaveLength(1)
    expect(mountedFlow).toContain('if (resumed && !setupHandoff)\n      recordSkippedChannelResumeDialog(')
    expect(mountedFlow).toContain('const resumed = await loadResumeApp()')
    expect(mountedFlow).toContain('resumedFlow = resumed')
    expect(mountedFlow).not.toContain('.viewStep(')
    expect(mountedFlow.match(/initializeProgressTracking\(resumedFlow\)/g)).toHaveLength(1)
    expect(mountedFlow.match(/persistOnboardingProgress\(\)/g)).toHaveLength(2)
    const finallyBlock = mountedFlow.slice(mountedFlow.indexOf('finally {'))
    expect(finallyBlock).toContain('initializeProgressTracking(resumedFlow)')
    expectSourceOrder(mountedFlow, [
      'resumedFlow = resumeResult',
      'finally {',
      'isHydratingOnboarding.value = false',
      'await persistOnboardingProgress()',
      'isLoading.value = false',
      'initializeProgressTracking(resumedFlow)',
    ])
  })

  it.concurrent('clears intent directly inside the reset operation and nowhere else', () => {
    const reset = sourceBetween('async function resetOnboardingForm()', 'function showWelcomeOnDesktop()')
    expectSourceOrder(reset, [
      'selectedIntent.value = null',
      `await persistOnboardingProgress('in_progress', { clearIntent: true })`,
    ])
    expect(reset.match(/persistOnboardingProgress\('in_progress', \{ clearIntent: true \}\)/g)).toHaveLength(2)

    const outsideReset = onboardingSource.replace(reset, '')
    expect(outsideReset).not.toContain('clearIntent: true')
    expect(outsideReset).not.toContain('clearIntentOnInitialPersist')
    expect(sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')).not.toContain('clearIntent')
  })

  it.concurrent('persists telemetry identity metadata with each progress snapshot', () => {
    const snapshot = sourceBetween('function snapshotOnboardingProgress(', 'async function persistOnboardingProgress(')
    expect(snapshot).toContain('const telemetry = onboardingTelemetry.getProgressMetadata()')
    expect(snapshot).toContain('onboardingAttemptId: telemetry.onboardingAttemptId')
    expect(snapshot).toContain('lastRunId: telemetry.lastRunId')
  })

  it.concurrent('delegates persistence serialization and barriers to the tested controller', () => {
    expect(onboardingSource).toContain(`import type { OnboardingPersistOptions, OnboardingPersistResult } from '~/utils/onboardingProgressPersistence'`)
    expect(onboardingSource).not.toContain(`type OnboardingPersistResult = 'persisted' | 'retryable_failure' | 'conflict' | 'skipped'`)
    expect(onboardingSource).not.toContain('let persistChain')
    expect(onboardingSource).not.toContain('let onboardingMountAborted')
    expect(onboardingSource).not.toContain('let onboardingPersistenceBlocked')
    expect(onboardingSource).toContain('const onboardingProgressPersistence = createOnboardingProgressPersistence({')
    expect(onboardingSource).toContain('replaceUserOnboardingIfUnchanged,')
    expect(onboardingSource).toContain('serializeUserOnboardingWrite,')
    expect(onboardingSource).toContain('write: writeOnboardingProgress,')
    expect(onboardingSource).toContain(`onError: error => console.error('Failed to persist onboarding progress', error),`)

    const persistenceQueue = sourceBetween('async function persistOnboardingProgress(', 'function schedulePersistOnboardingProgress(')
    expect(persistenceQueue).toContain(`status: UserOnboardingStatus = 'in_progress'`)
    expect(persistenceQueue).toContain('options: OnboardingPersistOptions = {}')
    expect(persistenceQueue).toContain('clearScheduledOnboardingProgress()')
    expect(persistenceQueue).toContain('return onboardingProgressPersistence.persist(status, options)')
    expect(persistenceQueue).not.toContain('writeOnboardingProgress(status)')
    expect(persistenceQueue).not.toContain('initializeProgressTracking')

    const writer = sourceBetween('async function writeOnboardingProgress(', 'async function resetOnboardingForm(')
    expect(writer).toContain(`if (!userId || (isHydratingOnboarding.value && !options.clearIntent))\n    return 'skipped'`)
    expect(writer).toContain('return serializeUserOnboardingWrite(userId, async () => {')
    expect(writer).toContain('main.authGeneration !== authGeneration')
    expect(writer).toContain('(onboardingFlowDisposed && !options.allowDisposed)')
    expect(writer).toContain('attempt < MAX_USER_ONBOARDING_WRITE_ATTEMPTS')
    expect(writer).toContain(`if (current?.status === 'completed' && status !== 'completed')`)
    expect(writer).toContain('{ clearIntent: options.clearIntent }')
    expect(writer).toContain('await replaceUserOnboardingIfUnchanged(')
    expectSourceOrder(writer, [
      'const onboarding = mergeUserOnboardingProgress(',
      'await replaceUserOnboardingIfUnchanged(',
    ])
    expect(writer).toContain('if (error) {')
    expect(writer).toContain('isUsersOnboardingCheckConstraintError(error)')
    expect(writer).toContain('fallbackUsersOnboardingProgressForLegacyConstraint(persistableProgress)')
    expectSourceOrder(writer, [
      'if (error) {',
      `console.error('Failed to persist onboarding progress', error)`,
      `return 'retryable_failure'`,
    ])
    expect(writer).toContain('if (data) {')
    expect(writer).toContain('main.user = { ...data, image_url: main.user.image_url }')
    expect(writer).toContain(`return 'persisted'`)
    expect(writer).toContain(`return status === 'completed' ? 'skipped' : 'conflict'`)

    const noRowRefresh = writer.slice(writer.indexOf('const { data: latest, error: latestError }'))
    expect(writer).not.toContain('onboardingProgressPersistence')
    expectSourceOrder(noRowRefresh, [
      'const { data: latest, error: latestError }',
      'if (latestError) {',
      'if (!latest)',
      'currentOnboarding = latest.onboarding',
      `return 'conflict'`,
    ])
    expect(writer.trimEnd().endsWith(`return 'conflict'\n  })\n}`)).toBe(true)
  })

  it.concurrent('initializes tracking after exhausted retryable initial writes while blocking skipped and conflict outcomes', () => {
    expect(onboardingSource).toContain('let onboardingFlowDisposed = false')
    expect(onboardingSource).toContain('let onboardingInitialPersistInFlight = false')
    expect(onboardingSource).not.toContain('pendingProgressTrackingResumed')

    const mountedFlow = sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')
    const persistenceGuard = 'if (!onboardingFlowDisposed && !onboardingProgressPersistence.isAborted()) {'
    const persistenceGuardStart = mountedFlow.indexOf(persistenceGuard)
    const persistenceGuardEnd = mountedFlow.indexOf('\n    }\n', persistenceGuardStart)
    expect(persistenceGuardStart).toBeGreaterThan(mountedFlow.indexOf('isHydratingOnboarding.value = false'))
    expect(persistenceGuardEnd).toBeGreaterThan(persistenceGuardStart)
    const initialPersistence = mountedFlow.slice(persistenceGuardStart, persistenceGuardEnd)
    expect(initialPersistence.match(/persistOnboardingProgress\(\)/g)).toHaveLength(2)
    expect(mountedFlow).toContain('function finishOnboardingMount()')
    expectSourceOrder(mountedFlow, [
      `let onboardingPersistResult: OnboardingPersistResult = 'skipped'`,
      persistenceGuard,
      'onboardingInitialPersistInFlight = true',
      'onboardingPersistResult = await persistOnboardingProgress()',
      `if (onboardingPersistResult === 'retryable_failure' && !onboardingFlowDisposed)`,
      `onboardingPersistResult = await persistOnboardingProgress()`,
      'onboardingInitialPersistInFlight = false',
      'if (onboardingFlowDisposed || onboardingProgressPersistence.isAborted())',
      'return',
      'isLoading.value = false',
      'shouldInitializeOnboardingProgressTracking(',
      'aborted: onboardingProgressPersistence.isAborted()',
      'disposed: onboardingFlowDisposed',
      'initializeProgressTracking(resumedFlow)',
      'finishOnboardingMount()',
    ])
    expect(mountedFlow).toContain(`if (shouldInitializeProgressTracking)
        initializeProgressTracking(resumedFlow)`)
    expect(mountedFlow).toContain(`else
        pendingVisibilityChanges = []`)

    const scheduledPersistence = sourceBetween('function schedulePersistOnboardingProgress(', 'async function writeOnboardingProgress(')
    expect(onboardingSource).toContain('const ONBOARDING_PROGRESS_PERSIST_DEBOUNCE_MS = 500')
    expectSourceOrder(scheduledPersistence, [
      'if (isHydratingOnboarding.value || onboardingProgressPersistence.isBlocked() || onboardingProgressPersistence.isAborted())',
      'return',
      'persistFieldsQueuedAt ??= now',
      'Math.max(0, ONBOARDING_PROGRESS_PERSIST_DEBOUNCE_MS - (now - persistFieldsQueuedAt))',
      'persistFieldsTimer = setTimeout',
      'void persistOnboardingProgress()',
    ])

    const unmountFlow = sourceBetween('onBeforeUnmount(() => {', 'watch(existingApp,')
    expectSourceOrder(unmountFlow, [
      'onboardingFlowDisposed = true',
      'if (!isHydratingOnboarding.value && !onboardingInitialPersistInFlight && !onboardingProgressPersistence.isBlocked() && !onboardingProgressPersistence.isAborted())',
      `void persistOnboardingProgress('in_progress', { allowDisposed: true })`,
    ])
  })

  it.concurrent('retains the existing intent compatibility event', () => {
    expect(onboardingSource).toContain(`sendOnboardingEvent('onboarding_intent_selected', {`)
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
      onboarding: {
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

  it.concurrent('keeps Maker+ invitations inside the organization progress step before the eligible next step', () => {
    const appCreation = sourceBetween('async function completePreOrgAppCreation(', 'function onOrganizationInviteOpened()')
    expect(appCreation).toContain(`await createAppRecord(shouldInvite ? { nextStep: 'organization' } : undefined)`)
    expectSourceOrder(appCreation, [
      'if (!shouldInvite) {',
      'await handOffToGettingStarted(completionProperties)',
      'return',
      'showOrganizationInvite.value = true',
      `trackOrganizationEvent('onboarding_organization_invite_viewed')`,
    ])
    const recordCreation = sourceBetween('async function createAppRecord(', 'async function createAppAndHandOff()')
    expect(recordCreation).toContain('if (options?.nextStep)\n      completeAndViewStep(options.nextStep, completionProperties)')

    const inviteContinuation = sourceBetween('function continueFromOrganizationInvite(', 'function resolveSetupStage(')
    expectSourceOrder(inviteContinuation, [
      `trackOrganizationEvent('onboarding_organization_invite_continued', {`,
      'void handOffToGettingStarted({ appId: createdApp.value.app_id })',
    ])
    expect(sourceBetween('async function handOffToGettingStarted(', 'async function copyText(')).toContain('const nextStep = nextStepAfterChannelEligibility()')
  })

  it.concurrent('routes both flows through channel only when its effective treatment is enabled', () => {
    const preOrgSteps = sourceBetween('const appOnboardingSteps = computed', 'const stepperStepId = computed')
    expect(preOrgSteps).toContain('const channelStep: Array<{ id: OnboardingFlowStep, label: string }> = newChannelTreatment.value')
    expect(preOrgSteps.match(/\.\.\.channelStep/g)).toHaveLength(2)
    expect(onboardingSource).toContain('return newChannelTreatment.value ? \'channel\' : \'setup\'')
    expect(onboardingSource).not.toContain('finalOnboardingStep')
    const handOff = sourceBetween('async function handOffToGettingStarted(', 'async function copyText(')
    expectSourceOrder(handOff, [
      'const nextStep = nextStepAfterChannelEligibility()',
      'setupStage.value = nextStep === \'channel\' ? resolveSetupStage() : \'cli\'',
      'flowStep.value = nextStep',
      'await persistOnboardingProgress()',
    ])

    const channel = sourceBetween('function continueFromChannelDefaultRouting()', 'function onTechnicalInviteOpened()')
    expectSourceOrder(channel, [
      'setSetupStage(\'channel-self-assign\')',
      'setSetupStage(\'channel-console-assign\')',
      'setSetupStage(\'channel-create\')',
      'completeAndViewStep(\'setup\'',
    ])
    expect(channel).toContain('if (flowStep.value !== \'channel\' || setupStage.value !== \'channel-create\' || !createdApp.value)')
    expect(channel).toContain('trackChannelStageTransition(\'setup\', \'forward\')')

    const renderedChannel = sourceBetween('flowStep === \'channel\' && newChannelTreatment && createdApp', 'flowStep === \'setup\' && createdApp')
    expectSourceOrder(renderedChannel, [
      '<ChannelDefaultRoutingOnboarding',
      '<ChannelSelfAssignOnboarding',
      '<ChannelConsoleAssignOnboarding',
      '<ChannelCreateOnboarding',
    ])
    expect(renderedChannel).toContain('newChannelTreatment')
    expect(onboardingSource).toContain('const showSetupChecklist = computed(() => flowStep.value === \'setup\' && usesOtaTodoList.value && !showBuilderChecklist.value)')
    expect(onboardingSource).toContain('progressTracker?.trackStepEvent(name, \'channel\', {')
    expect(onboardingSource).toContain('void viewFinalStepWhenRendered(nextStep, previousAnalyticsStep)')
    expect(onboardingSource).toContain('if (!isLoading.value && createdApp.value && flowStep.value === step)')
  })

  it.concurrent('keeps a persisted channel position in resume telemetry after the todo list disables channel', () => {
    const resumeSteps = sourceBetween('function resumeCandidateSteps(', 'function recordSkippedChannelResumeDialog(')
    const skippedResume = sourceBetween('function recordSkippedChannelResumeDialog(', 'async function maybeResumeSavedOnboarding()')
    expect(resumeSteps).toContain('if (savedStep !== \'channel\' || steps.includes(\'channel\'))')
    expect(resumeSteps).toContain('const finalStepIndex = steps.indexOf(\'setup\')')
    expect(resumeSteps).toContain('steps.splice(finalStepIndex < 0 ? steps.length : finalStepIndex, 0, \'channel\')')
    expect(skippedResume).toContain('steps: resumeCandidateSteps(\'channel\')')
  })

  it.concurrent('keeps the unload warning scoped to unfinished pre-org onboarding', () => {
    // Getting started renders the setup for an existing app, so it never warns.
    expect(onboardingSource).toContain('useBeforeUnloadWarning(Boolean(props.preOrg && !props.setupAppId))')
    const creation = sourceBetween('async function createOrganizationAndApp()', 'async function createAppRecord(')
    expectSourceOrder(creation, [
      'if (!completionProperties || !createdApp.value)',
      'removeBeforeUnloadWarning()',
      'await handOffToGettingStarted(completionProperties)',
    ])
    const handOff = sourceBetween('async function handOffToGettingStarted(', 'async function copyText(')
    expectSourceOrder(handOff, [
      'removeBeforeUnloadWarning()',
      'await router.replace({',
    ])
  })

  it.concurrent('tracks only successful forward transitions with approved context', () => {
    const transitionHelpers = sourceBetween('function completeAndViewStep(', 'function whiteCardToggleButtonClass(')
    expect(transitionHelpers).toContain('progressTracker?.completeStep(previousAnalyticsStep, {')
    expect(transitionHelpers).toContain('nextStep: nextAnalyticsStep,')
    expect(transitionHelpers).toContain('progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)')
    expect(transitionHelpers).toContain('void persistOnboardingProgress()')

    const intentTransition = sourceBetween('function continueFromIntent()', 'function continuePreOrgDetails()')
    expect(intentTransition).toContain(`intent: selectedIntent.value`)
    expect(intentTransition).toContain(`?? (webNativeDevelopmentEnvironmentTreatment.value ? undefined : 'skipped')`)

    const appNameTransition = sourceBetween('function continueFromAppName()', 'function continueFromAppId()')
    expect(appNameTransition).toContain(`completeAndViewAppDetailsStep('app_id', { appId: generatedAppId.value, appName: appName.value.trim() })`)

    const preOrgDetailsTransition = sourceBetween('function continuePreOrgDetails()', 'async function createOrganizationAndApp()')
    expect(preOrgDetailsTransition).toContain(`completeAndViewStep('organization', {`)
    expect(preOrgDetailsTransition).toContain('storeImportUsed: hasImportedStoreMetadata.value')

    const appCreation = sourceBetween('async function createAppRecord(', 'async function createAppAndHandOff()')
    expect(appCreation).toContain('appId,')
    expect(appCreation).toContain('completionProperties.storeImportUsed = hasImportedStoreMetadata.value')
    expect(appCreation).toContain('completeAndViewStep(options.nextStep, completionProperties)')
    expect(appCreation).toContain('return completionProperties')
    expect(appCreation).not.toContain('\'choice\'')

    // Standard creation completes details and continues on Getting started.
    expect(sourceBetween('function finishAppDetails()', 'function returnToAppIdAfterConflict()')).toContain('void createAppAndHandOff()')
    const createAndHandOff = sourceBetween('async function createAppAndHandOff()', 'async function handOffToGettingStarted(')
    expectSourceOrder(createAndHandOff, [
      'const completionProperties = await createAppRecord()',
      'if (completionProperties)',
      'await handOffToGettingStarted(completionProperties)',
    ])
    const handOff = sourceBetween('async function handOffToGettingStarted(', 'async function copyText(')
    expect(handOff).toContain('if (!app || isHandingOff.value)')
    expectSourceOrder(handOff, [
      'const previousAnalyticsStep = analyticsStepFor(flowStep.value)',
      'progressTracker?.completeStep(previousAnalyticsStep, {',
      '...completionProperties,',
      'nextStep,',
      'flowStep.value = nextStep',
    ])
    expect(handOff).not.toContain('viewStep(')
    expect(onboardingSource).not.toContain('function goToInstallStep()')
  })

  it.concurrent('loads stable backend flags and applies the A and C onboarding treatments', () => {
    const workerSource = readFileSync(new NodeUrl('../cloudflare_workers/api/index.ts', import.meta.url), 'utf8')
    expect(onboardingSource).toContain(`invokeCapgoApi<OnboardingABTestsResponse>('private/onboarding_ab_tests'`)
    expect(workerSource).toContain('appPrivate.route(\'/onboarding_ab_tests\', onboarding_ab_tests)')
    expect(onboardingSource).toContain('const ONBOARDING_AB_TEST_WAIT_TIMEOUT_MS = 3_000')
    expect(onboardingSource).toContain('void refreshOnboardingABTests()')
    expect(onboardingSource).toContain('await waitForOnboardingABTests()')
    expect(onboardingSource).toContain('Promise.race([refreshOnboardingABTests(options), timeout])')
    expect(onboardingSource).toContain('if (props.preOrg && !welcomePending.value)')
    expect(onboardingSource).toContain('function refreshOnboardingABTests(options: { force?: boolean } = {})')
    expect(onboardingSource).toContain('reconcileOnboardingABTestAssignments(')
    expect(onboardingSource).toContain('if (onboardingABTestsRequest === request)')
    expect(onboardingSource).toContain('onboardingABTestsRequest = null')
    expect(onboardingSource).toContain(`webNativePublishIntentTreatment.value`)
    expect(onboardingSource).toContain(`webNativeDevelopmentEnvironmentTreatment.value`)
    expect(onboardingSource).toContain(`shouldShowWebNativeRecommendation({`)
    expect(onboardingSource).toContain(`developmentEnvironment: selectedDevelopmentEnvironment.value`)
    expect(onboardingSource).toContain(`intent: selectedIntent.value`)
    expect(onboardingSource).toContain(`startingOut: selectedUserCountStop.value?.startingOut === true`)
    expect(onboardingSource).toContain('developmentEnvironment: selectedDevelopmentEnvironment.value ?? \'skipped\'')
    expect(onboardingSource).toContain('completeAndViewStep(\'publish_app_question\'')
    expect(onboardingSource).toContain(`?? (webNativeDevelopmentEnvironmentTreatment.value ? undefined : 'skipped')`)
    expect(onboardingSource).toContain(`resolveOnboardingAnalyticsVersion(onboardingForABTests.value, selectedIntent.value)`)
    expect(onboardingSource).not.toContain(`if (props.preOrg) {\n      await main.awaitInitialLoad()`)
    expect(onboardingSource).toContain(`const WEBNATIVE_APP_URL = 'https://webnativeapp.com/?ref=capgo'`)
    expect(onboardingSource).toContain(`const publishIntentOption = { value: 'publish'`)
    expect(onboardingSource).toContain(`data-test="\`onboarding-development-environment-\${option.value}\`"`)
    expect(onboardingSource).toContain(`:data-test="\`onboarding-intent-\${option.value}\`"`)
    expect(onboardingSource).toContain('async function continueFromGoal()')
    expect(onboardingSource).toContain('completeAndViewStep(\'publish_app_question\'')
    expect(onboardingSource).toContain('trackStepEvent(\'onboarding_development_environment_selected\', \'publish_app_question\'')
    expect(onboardingSource).toContain('function continueFromDevelopmentEnvironment()')
    expect(onboardingSource).toContain('function skipPublishAppQuestion()')
    expect(onboardingSource).toContain('function continueFromCurrentPublishAppQuestion()')
    expect(onboardingSource).toContain('developmentEnvironment: \'skipped\'')
    expect(onboardingSource).toContain(`:data-test="hasSelectedDevelopmentEnvironment ? 'app-onboarding-continue-development-environment' : 'app-onboarding-skip-development-environment'"`)
    expect(onboardingSource).toContain('developmentEnvironment: persistedDevelopmentEnvironment()')
    expect(onboardingSource).toContain('d-btn-ghost onboarding-development-environment-option')
    expect(onboardingSource).toContain('sm:grid-cols-2')
    expect(onboardingSource).toContain('<OnboardingToolPattern v-if="option.icons.length" :icons="option.icons" :muted="option.muted" />')
    expect(optionsSource).toContain('value: \'hosted_builder\'')
    expect(optionsSource).toContain('value: \'ai_assistant\'')
    expect(optionsSource).toContain('value: \'hand_coded\'')
    expect(optionsSource).toContain('value: \'other\'')
    expect(optionsSource).toContain('icons: []')
    expect(onboardingSource).toContain(':aria-pressed="selectedDevelopmentEnvironment === option.value"')
    const persistEnv = sourceBetween('function persistedDevelopmentEnvironment()', 'function snapshotOnboardingProgress(')
    expect(persistEnv).toContain('if (selected && selected !== \'skipped\')')
    expect(persistEnv).toContain('return selected')
    expect(sourceBetween('function applyOnboardingProgress(', 'function applyDefaultPreOrgDetails()')).toContain('resumableOnboardingFlowStep(progress, flow)')
    expect(sourceBetween('function applyOnboardingProgress(', 'function applyDefaultPreOrgDetails()')).toContain('if (progress.development_environment === \'skipped\')')
    expect(sourceBetween('function applyOnboardingProgress(', 'function applyDefaultPreOrgDetails()')).toContain('selectedDevelopmentEnvironment.value = progress.development_environment')
    expect(onboardingSource).toContain('publishAppQuestion: flowStep.value === \'publish_app_question\'')
    expect(onboardingSource).toContain('const showDevelopmentEnvironmentQuestion = computed(() => flowStep.value === \'publish_app_question\')')
    expect(sourceBetween('function selectDevelopmentEnvironment(', 'function continueWithCapgoFromWebNativeRecommendation(')).toContain('schedulePersistOnboardingProgress()')
    expect(onboardingSource).toContain('viewPreviousStep(\'intent\')')
    expect(onboardingSource).toContain('viewPreviousStep(webNativeDevelopmentEnvironmentTreatment ? \'publish_app_question\' : \'intent\')')
    expect(onboardingSource).not.toContain('showCapgoIntentQuestion')
    expect(onboardingSource).toContain('data-test="onboarding-webnative-check-website"')
    expect(onboardingSource).toContain('data-test="onboarding-webnative-continue-capgo"')
    const goalTransition = sourceBetween('async function continueFromGoal()', 'function continueFromDevelopmentEnvironment()')
    expectSourceOrder(goalTransition, [
      'await persistOnboardingProgress()',
      'await waitForOnboardingABTests({ force: true })',
      'completeAndViewStep(',
    ])
    expect(englishMessages['organization-onboarding-intent-option-publish-label']).toBe('Convert my webapp to a mobile app')
    expect(englishMessages['organization-onboarding-intent-option-publish-desc']).toBe('Turn my existing website into an iOS and Android app.')
    expect(englishMessages['organization-onboarding-development-environment-question']).toBe('What do you use to build your app?')
    expect(englishMessages['organization-onboarding-development-environment-option-hosted_builder-label']).toBe('Hosted AI builder')
    expect(englishMessages['organization-onboarding-development-environment-option-ai_assistant-label']).toBe('AI coding assistant')
    expect(englishMessages['organization-onboarding-development-environment-option-hand_coded-label']).toBe('I write the code myself')
    expect(englishMessages['organization-onboarding-development-environment-option-other-label']).toBe('Other')
    expect(englishMessages['organization-onboarding-development-environment-skip']).toBe('Skip')
    expect(englishMessages['organization-onboarding-webnative-title']).toBe('WebNativeApp may be a better fit')
    expect(englishMessages['organization-onboarding-webnative-description']).toContain('WebNativeApp can package it for iOS and Android')
    expect(englishMessages['organization-onboarding-webnative-check-website']).toBe('Check WebNativeApp')
    expect(englishMessages['organization-onboarding-webnative-continue-capgo']).toBe('Continue with Capgo')
  })

  it.concurrent('reports back navigation as a new view without completing the abandoned step', () => {
    const backNavigation = sourceBetween('function viewPreviousStep(', 'function snapshotOnboardingProgress(')
    expect(backNavigation).not.toContain('completeStep')
    expect(backNavigation).toContain('progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)')
    expect(onboardingSource).not.toContain('viewPreviousStep(\'choice\')')
    expect(onboardingSource).toContain('@click="viewPreviousStep(\'details\')"')
    expect(onboardingSource).toContain(`props.preOrg ? viewPreviousStep(webNativeDevelopmentEnvironmentTreatment ? 'publish_app_question' : 'intent') : router.push('/apps')`)
    expect(onboardingSource).not.toContain('@click="flowStep = \'details\'"')
    expect(onboardingSource).not.toContain('@click="flowStep = \'choice\'"')
    expect(onboardingSource).not.toContain(`props.preOrg ? (flowStep = 'intent') : router.push('/apps')`)
  })

  it.concurrent('completes only the terminal setup exit and hands creation off to Getting started', () => {
    // The existing-org real vs demo choice and install step were removed.
    expect(onboardingSource).not.toContain('async function seedDemoData()')
    expect(onboardingSource).not.toContain('\'app/demo\'')
    expect(onboardingSource).not.toContain('data-test="onboarding-install-cli"')

    const handOff = sourceBetween('async function handOffToGettingStarted(', 'async function copyText(')
    expectSourceOrder(handOff, [
      'progressTracker?.completeStep(previousAnalyticsStep, {',
      'await persistOnboardingProgress()',
      'removeBeforeUnloadWarning()',
      'onboardingProgressPersistence.abort()',
      'await router.replace({',
      'path: getAppGettingStartedPath(app.app_id),',
      '[ONBOARDING_SETUP_HANDOFF_STATE_KEY]: {',
      'appId: app.app_id,',
      'attemptId: onboardingTelemetry.attemptId,',
      'flow: props.preOrg ? \'pre_org\' : \'existing_org\',',
      'previousStep: previousAnalyticsStep,',
      'runId: onboardingTelemetry.runId,',
      'if (failure)',
      'isHandingOff.value = false',
    ])
    expect(handOff).not.toContain('persistOnboardingProgress(\'completed\')')

    const dashboardExit = sourceBetween('function openDashboard()', 'onMounted(async () => {')
    expect(dashboardExit).toContain(`if (flowStep.value === 'setup')`)
    expect(dashboardExit).toContain('progressTracker?.completeStep(flowStep.value, {')
    expect(dashboardExit).toContain('appId: createdApp.value.app_id')
    expect(dashboardExit).toContain(`await persistOnboardingProgress('completed')`)
    expect(dashboardExit).toContain('router.push(`/app/')
    expect(dashboardExit).not.toContain('/getting-started')
    expect(dashboardExit.indexOf('completeStep')).toBeLessThan(dashboardExit.indexOf('router.push'))
    expect(dashboardExit).toContain('window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))')
    expect(onboardingSource).toContain('progressTracker?.trackDashboardExplored(createdApp.value?.app_id)')
    expect(onboardingSource).toContain('window.addEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)')
    expect(onboardingSource).toContain('window.removeEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)')
    expect(onboardingSource).toContain('pendingDashboardExplored = true')
    expect(onboardingSource).toContain('if (pendingDashboardExplored)')

    const splashDismiss = sourceBetween('async function skipOnboardingSplash()', 'async function leaveSplashIfAlreadySetup()')
    expect(splashDismiss).toContain('dismiss_getting_started')
    expect(splashDismiss).toContain('updateAppOnboarding')
    expect(onboardingSource).toContain('data-test="app-onboarding-dont-show-again"')

    const confirmedSidebarExit = sidebarSource.slice(sidebarSource.indexOf('if (requiresOnboardingExplorationConfirmation)'), sidebarSource.indexOf('if (tab.onClick)'))
    expect(confirmedSidebarExit.indexOf(`lastButtonRole !== 'primary'`)).toBeLessThan(confirmedSidebarExit.indexOf('window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))'))
  })
})
