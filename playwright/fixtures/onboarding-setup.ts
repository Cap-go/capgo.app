import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '../../src/utils/onboardingChannelAnalytics'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, onMounted, ref } from 'vue'
import { createRouter, createWebHistory, RouterView } from 'vue-router'
import AppOnboardingBuilderChecklist from '../../src/components/dashboard/AppOnboardingBuilderChecklist.vue'
import AppOnboardingCliSteps from '../../src/components/dashboard/AppOnboardingCliSteps.vue'
import AppOnboardingFlow from '../../src/components/dashboard/AppOnboardingFlow.vue'
import AppOnboardingSetupChecklist from '../../src/components/dashboard/AppOnboardingSetupChecklist.vue'
import GettingStartedNav from '../../src/components/dashboard/GettingStartedNav.vue'
import OnboardingExploreBanner from '../../src/components/dashboard/OnboardingExploreBanner.vue'
import OnboardingExploreReminder from '../../src/components/dashboard/OnboardingExploreReminder.vue'
import DialogV2 from '../../src/components/DialogV2.vue'
import { i18n } from '../../src/modules/i18n'
import { install as installOnboardingSetupNavigation } from '../../src/modules/onboarding-setup'
import GettingStartedPage from '../../src/pages/app/[app].getting-started.vue'
import { BUILDER_STEP_IDS } from '../../src/services/builderOnboardingChecklist'
import { useSupabase } from '../../src/services/supabase'
import { useMainStore } from '../../src/stores/main'
import { useOrganizationStore } from '../../src/stores/organization'
import '../../src/styles/style.css'

const params = new URLSearchParams(location.search)
const navigationView = params.get('view') === 'navigation' || location.pathname.startsWith('/app/') || location.pathname === '/onboarding/app'
const builderComponentView = params.get('view') === 'builder'
const assignment = params.get('assignment')
const previewAppId = 'com.example.onboarding-preview'
const savedChannelStatus = params.get('channelStatus')
const state = {
  version: Number(params.get('version') ?? 3),
  steps: (savedChannelStatus === 'done' || savedChannelStatus === 'skipped'
    ? { add_channel: { status: savedChannelStatus } }
    : {}) as Record<string, { status: 'done' | 'skipped' }>,
  builderSteps: {
    ios: Object.fromEntries(BUILDER_STEP_IDS.ios.map(id => [id, { status: 'pending' }])) as Record<string, { status: 'pending' | 'done' | 'skipped' }>,
    android: Object.fromEntries(BUILDER_STEP_IDS.android.map(id => [id, { status: 'pending' }])) as Record<string, { status: 'pending' | 'done' | 'skipped' }>,
  },
  selectedBuilderPlatform: params.get('platform') === 'ios' || params.get('platform') === 'android' ? params.get('platform') : null,
  outcome: 'in_progress',
  error: false,
  requests: 0,
  polls: [] as Array<{ appId: string, N: number, initial: boolean }>,
  channels: (params.get('channel') === '1' ? [{ id: 1, app_id: previewAppId, name: 'staging', public: true, allow_device_self_set: true }] : []) as Array<{ id: number, app_id: string, name: string, public?: boolean, allow_device_self_set?: boolean }>,
  channelError: false,
  channelRequests: 0,
  channelQueries: [] as string[],
  channelDelayMs: Number(params.get('channelDelay') ?? 0),
  channelPermissions: true,
  channelInsertError: false,
  channelInsertDelayMs: 0,
  channelInserts: [] as Record<string, unknown>[],
  appWrites: [] as Array<{ method: string, body: unknown }>,
}
const events: string[] = []
const channelEvents: Array<{ event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties }> = []
const preview = { state, events, channelEvents, appId: ref(previewAppId), command: ref('npx @capgo/cli@latest i [API_KEY]'), hiding: ref(false), selectedOrgId: ref('') }
const previewUserOnboarding = {
  intent: assignment ? 'builder' : 'ota',
  status: 'in_progress',
  step: 'setup',
  flow: 'existing_org',
  setup_stage: 'cli',
  app_id: previewAppId,
  ...(params.get('legacyChannel') === '1' ? {} : { final_step: 'setup' }),
}
Object.assign(window, { onboardingSetupPreview: preview })

function previewOnboarding() {
  const selectedPath = assignment === 'both-ota' || assignment === 'ota-only' ? 'ota' : 'builder'
  const hasBuilder = builderComponentView || assignment === 'builder-only' || assignment === 'both-builder' || assignment === 'both-ota'
  const hasOta = assignment === 'ota-only' || assignment === 'both-builder' || assignment === 'both-ota'
  if (hasBuilder || hasOta) {
    return { setup: {
      todo_list_version: 4,
      ...(hasBuilder ? { builder_todo_list_version: '1' } : {}),
      ...(hasOta ? { ota_todo_list_version: '1' } : {}),
      paths: [hasOta ? 'ota' : null, hasBuilder ? 'builder' : null].filter(Boolean),
      ...(assignment === 'builder-only' ? {} : { selected_path: selectedPath }),
      ...(state.selectedBuilderPlatform ? { selected_builder_platform: state.selectedBuilderPlatform } : {}),
      steps: {
        ...(hasOta ? { ota: {} } : {}),
        ...(hasBuilder ? { builder: state.builderSteps } : {}),
      },
      outcome: state.outcome,
    } }
  }
  return { setup: { todo_list_version: state.version, steps: state.steps, outcome: state.outcome } }
}

// This isolated component fixture never sends requests to production.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = init?.method?.toUpperCase() ?? 'GET'
  if (url.pathname.endsWith('/apps') && method !== 'GET' && method !== 'HEAD') {
    state.appWrites.push({
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
  }
  if (url.pathname.endsWith('/onboarding_progress')) {
    const body = JSON.parse(String(init?.body))
    state.polls.push(body)
    state.requests += 1
    const checkChannel = body.initial || body.N % 5 === 0
    const hasChannel = state.channels.some(channel => channel.app_id === body.appId)
    const channelError = state.channelError
    if (checkChannel) {
      state.channelRequests += 1
      state.channelQueries.push(`eq.${body.appId}`)
      if (state.channelDelayMs)
        await new Promise(resolve => setTimeout(resolve, state.channelDelayMs))
    }
    return new Response(JSON.stringify(state.error
      ? { message: 'Progress unavailable' }
      : {
          onboarding: { setup: { todo_list_version: state.version, steps: state.steps, outcome: state.outcome } },
          ...(checkChannel && !channelError ? { hasChannel } : {}),
          checkErrors: checkChannel && channelError ? ['add_channel'] : [],
        }), { status: state.error ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.includes('/rpc/')) {
    return new Response(JSON.stringify(state.channelPermissions), { headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.endsWith('/channels')) {
    if (init?.method === 'POST') {
      const insert = JSON.parse(String(init.body))
      state.channelInserts.push(insert)
      if (state.channelInsertDelayMs)
        await new Promise(resolve => setTimeout(resolve, state.channelInsertDelayMs))
      if (state.channelInsertError)
        return new Response(JSON.stringify({ message: 'Insert unavailable' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      state.channels.push({ id: state.channels.length + 1, ...insert })
      return new Response(null, { status: 201 })
    }
    state.channelRequests += 1
    const filter = url.searchParams.get('app_id') ?? ''
    state.channelQueries.push(filter)
    const rows = state.channels.filter(channel => (
      (!filter || filter === `eq.${channel.app_id}`)
      && (!url.searchParams.get('public') || url.searchParams.get('public') === `eq.${channel.public}`)
      && (!url.searchParams.get('name') || url.searchParams.get('name') === `eq.${channel.name}`)
    )).slice(0, Number(url.searchParams.get('limit') ?? state.channels.length))
    const error = state.channelError
    if (state.channelDelayMs > 0)
      await new Promise(resolve => setTimeout(resolve, state.channelDelayMs))
    return new Response(JSON.stringify(error ? { message: 'Channels unavailable' } : rows), {
      status: error ? 503 : 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (params.get('view') === 'flow' || navigationView) {
    const app = { id: '00000000-0000-4000-8000-000000000003', app_id: previewAppId, name: 'My Capacitor app', icon_url: '', owner_org: '00000000-0000-4000-8000-000000000002', need_onboarding: true, onboarding: previewOnboarding() }
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.com', onboarding: previewUserOnboarding }
    const rows = url.pathname.endsWith('/apps') ? (!url.searchParams.get('owner_org') || url.searchParams.get('owner_org') === `eq.${app.owner_org}` ? [app] : []) : url.pathname.endsWith('/users') ? [user] : url.pathname.endsWith('/apikeys') ? [{ key: '00000000-0000-4000-8000-000000000004', rbac_id: '00000000-0000-4000-8000-000000000005', expires_at: null }] : url.pathname.endsWith('/role_bindings') ? [{ principal_id: '00000000-0000-4000-8000-000000000005', scope_type: 'org', roles: { name: 'org_super_admin' } }] : []
    const single = new Headers(init?.headers).get('Accept')?.includes('object')
    return new Response(JSON.stringify(single ? rows[0] ?? {} : rows), { headers: { 'Content-Type': 'application/json' } })
  }
  if (builderComponentView && url.pathname.endsWith('/apps')) {
    return new Response(JSON.stringify({ onboarding: previewOnboarding() }), { headers: { 'Content-Type': 'application/json' } })
  }
  state.requests += 1
  return new Response(JSON.stringify(state.error
    ? { message: 'Progress unavailable' }
    : [{
        onboarding: previewOnboarding(),
      }]), {
    status: state.error ? 503 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Supply a fixture-only session. All fetch calls above are intercepted.
useSupabase().auth.getSession = async () => ({ data: { session: { access_token: 'fixture-token' } as any }, error: null })

const app = createApp(defineComponent({
  setup() {
    return () => h('main', {
      class: 'min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8 dark:bg-slate-950',
    }, [
      h('div', { class: 'mx-auto max-w-6xl' }, [
        navigationView
          ? h(RouterView)
          : params.get('view') === 'flow'
            ? h(AppOnboardingFlow, { onboarding: true })
            : builderComponentView
              ? h(AppOnboardingBuilderChecklist, {
                  appId: preview.appId.value,
                  initialOnboarding: previewOnboarding(),
                  command: 'npx @capgo/cli@latest build init -a [API_KEY]',
                  hiding: preview.hiding.value,
                  leaving: false,
                  onCopyCommand: platform => events.push(`copy-builder-${platform}`),
                  onHide: () => events.push('hide'),
                  onExplore: () => events.push('explore'),
                  onComplete: () => events.push('complete'),
                })
              : params.get('view') === 'compact'
                ? h(AppOnboardingCliSteps, { appId: preview.appId.value })
                : h(AppOnboardingSetupChecklist, {
                    appId: preview.appId.value,
                    command: preview.command.value,
                    hiding: preview.hiding.value,
                    leaving: false,
                    onCopyCommand: async () => {
                      events.push('copy-command')
                      await navigator.clipboard.writeText(preview.command.value)
                    },
                    onCopyAi: () => events.push('copy-ai'),
                    onHide: () => events.push('hide'),
                    onExplore: () => events.push('explore'),
                    onComplete: () => events.push('complete'),
                    onInviteOpened: () => events.push('invite-opened'),
                    onChannelAnalytics: (event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) => channelEvents.push({ event, properties }),
                  }),
      ]),
      h(DialogV2),
    ])
  },
}))
const pinia = createPinia()
app.use(pinia)
// Supply identity to the real channel form without starting dashboard store watchers.
Object.defineProperty(useMainStore(pinia), 'user', { value: { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.com', onboarding: previewUserOnboarding } })
Object.defineProperty(useMainStore(pinia), 'auth', { value: { id: '00000000-0000-4000-8000-000000000001' } })
useMainStore(pinia).awaitInitialLoad = async () => true
const organization = useOrganizationStore(pinia)
const previewOrganization = { gid: '00000000-0000-4000-8000-000000000002' }
const selectedOrganization = ref(params.get('wrongOrg') === '1' ? { gid: '00000000-0000-4000-8000-000000000099' } : previewOrganization)
preview.selectedOrgId.value = selectedOrganization.value.gid
Object.defineProperty(organization, 'currentOrganization', { get: () => selectedOrganization.value })
organization.getOrgByAppId = appId => appId === previewAppId ? previewOrganization as any : undefined
organization.setCurrentOrganization = (orgId) => {
  if (orgId === previewOrganization.gid)
    selectedOrganization.value = previewOrganization
  preview.selectedOrgId.value = selectedOrganization.value.gid
}
organization.awaitInitialLoad = async () => true
organization.getAppsByOrgId = orgId => orgId === previewOrganization.gid ? [{ app_id: previewAppId, owner_org: orgId, name: 'My Capacitor app', icon_url: '', need_onboarding: true, onboarding: previewOnboarding() }] : []
app.use(i18n)
const router = createRouter({
  history: createWebHistory(),
  routes: navigationView
    ? [
        { path: '/app/:app', component: defineComponent({ setup: () => () => h('section', { 'data-test': 'preview-app-dashboard' }, [h('h1', 'App dashboard'), h(GettingStartedNav), h(OnboardingExploreBanner, { appId: previewAppId }), h(OnboardingExploreReminder, { appId: previewAppId })]) }) },
        { path: '/app/:app/getting-started', name: '/app/[app].getting-started', component: defineComponent({
          setup() {
            onMounted(() => events.push('getting-started-mounted'))
            return () => h(GettingStartedPage)
          },
        }) },
        { path: '/:pathMatch(.*)*', component: defineComponent({ setup: () => () => h(AppOnboardingFlow, { onboarding: true }) }) },
      ]
    : [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
})
installOnboardingSetupNavigation({ app, router, routes: router.options.routes })
app.use(router)
void router.isReady().then(() => app.mount('#app'))
