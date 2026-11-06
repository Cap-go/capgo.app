import type { OrganizationApp } from '../../src/stores/organization'
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '../../src/utils/onboardingChannelAnalytics'
import gsap from 'gsap'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, onMounted, ref } from 'vue'
import { createRouter, createWebHistory, RouterView } from 'vue-router'
import AppOnboardingBuilderChecklist from '../../src/components/dashboard/AppOnboardingBuilderChecklist.vue'
import AppOnboardingCliSteps from '../../src/components/dashboard/AppOnboardingCliSteps.vue'
import AppOnboardingFlow from '../../src/components/dashboard/AppOnboardingFlow.vue'
import AppOnboardingSetupChecklist from '../../src/components/dashboard/AppOnboardingSetupChecklist.vue'
import CiCdSetupGuide from '../../src/components/dashboard/CiCdSetupGuide.vue'
import ChannelIntroduction from '../../src/components/dashboard/ChannelIntroduction.vue'
import GettingStartedNav from '../../src/components/dashboard/GettingStartedNav.vue'
import OnboardingExploreBanner from '../../src/components/dashboard/OnboardingExploreBanner.vue'
import OnboardingExploreReminder from '../../src/components/dashboard/OnboardingExploreReminder.vue'
import DialogV2 from '../../src/components/DialogV2.vue'
import BuildTable from '../../src/components/tables/BuildTable.vue'
import { i18n } from '../../src/modules/i18n'
import { install as installOnboardingSetupNavigation } from '../../src/modules/onboarding-setup'
import CiCdPage from '../../src/pages/app/[app].ci-cd.vue'
import GettingStartedPage from '../../src/pages/app/[app].getting-started.vue'
import { BUILDER_STEP_IDS } from '../../src/services/builderOnboardingChecklist'
import { useConsole } from '../../src/services/console'
import { useMainStore } from '../../src/stores/main'
import { useOrganizationStore } from '../../src/stores/organization'
import { ONBOARDING_SETUP_HANDOFF_STATE_KEY } from '../../src/utils/onboardingRedirect'
import '../../src/styles/style.css'

const params = new URLSearchParams(location.search)
// The fixture omits the main app's analytics loader, including for prod-config previews.
Object.defineProperty(window, 'posthog', { configurable: true, value: { capture: () => {} } })
const builderIntroView = params.get('view') === 'builder-intro'
const navigationView = builderIntroView || params.get('view') === 'navigation' || location.pathname.startsWith('/app/') || location.pathname === '/onboarding/app'
const builderComponentView = params.get('view') === 'builder'
const cicdView = params.get('view') === 'cicd'
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
  channels: (params.get('channel') === '1' ? [{ id: 1, app_id: previewAppId, name: 'staging', public: true, allow_device_self_set: true }] : []) as Array<{ id: number, app_id: string, name: string, public?: boolean, allow_device_self_set?: boolean, ios?: boolean, android?: boolean, electron?: boolean }>,
  channelError: params.get('channelError') === '1',
  channelRequests: 0,
  channelQueries: [] as string[],
  channelDelayMs: Number(params.get('channelDelay') ?? 0),
  channelPermissions: true,
  channelInsertError: false,
  channelInsertDelayMs: 0,
  channelInserts: [] as Record<string, unknown>[],
  appWrites: [] as Array<{ method: string, body: unknown }>,
  setupWrites: [] as Array<{ method: string, body: unknown }>,
  userWrites: [] as unknown[],
  builderActivationRequests: [] as unknown[],
  builderActivationError: false,
  builderActivationDelayMs: 0,
  builderActivated: false,
  skips: [] as string[],
  skipReasons: [] as string[],
  apikeyCreates: [] as unknown[],
  apikeyError: params.get('apikeyError'),
  encryptionError: params.get('encryptionError') === '1',
  encryptionDelayMs: Number(params.get('encryptionDelay') ?? 0),
  cicdRegistrationError: params.get('registrationError') === '1',
  cicdStatusDelayMs: 0,
  cicdStatusRequests: 0,
  cicdStatusResponses: 0,
  cicdSidebarRefreshes: [] as Array<string[] | null>,
  cicdRemoteLedger: null as Record<string, unknown> | null,
  latestBundles: (params.get('bundle') || params.get('encrypted') === '1' ? [{ name: params.get('bundle') ?? '1.0.0', created_at: '2026-11-06T10:00:00.000Z', key_id: params.get('encrypted') === '1' ? 'MIIB' : null }] : []) as Array<{ name: string | null, created_at: string, key_id: string | null }>,
}
// apps.onboarding.cicd, reactive so the sidebar follows the guide's writes.
const cicdLedger = ref<Record<string, unknown> | undefined>(params.get('cicd') === 'detected'
  ? { ota_detected_at: '2026-11-06T10:00:00.000Z', detected_via: 'ci', ci_provider: 'GitHub Actions' }
  : params.get('cicd') === 'marked'
    ? { marked_done_at: '2026-11-05T10:00:00.000Z' }
    : undefined)
const cicdSetupCalls: Array<Record<string, unknown>> = []
if (cicdView && params.get('defaultChannel') !== '0') {
  // `defaultChannels=a|b` gives each platform its own default channel.
  const names = params.get('defaultChannels')?.split('|') ?? [params.get('defaultChannel') ?? 'production']
  for (const [index, name] of names.entries())
    state.channels.push({ id: index + 1, app_id: previewAppId, name, public: true, ios: index % 2 === 0, android: index % 2 !== 0, electron: false })
}
if (params.get('disabledPublicChannel') === '1')
  state.channels.push({ id: state.channels.length + 1, app_id: previewAppId, name: 'disabled-public', public: true, ios: false, android: false, electron: false })
if (params.get('checklistState') === 'completed') {
  for (const id of ['login_cli_mcp', 'add_updater', 'add_code', 'add_channel', 'run_device', 'upload_bundle', 'test_update'])
    state.steps[id] = { status: id === 'add_code' ? 'skipped' : 'done' }
  state.channels.push({ id: 1, app_id: previewAppId, name: 'production' })
  for (const platform of ['ios', 'android'] as const) {
    for (const id of BUILDER_STEP_IDS[platform])
      state.builderSteps[platform][id] = { status: id === 'connect_google_play' ? 'skipped' : 'done' }
  }
  state.outcome = 'completed'
}
else if (params.get('checklistState') === 'dismissed') {
  state.steps.login_cli_mcp = { status: 'done' }
  state.steps.add_updater = { status: 'skipped' }
  state.builderSteps.android.start_setup = { status: 'done' }
  state.builderSteps.android.connect_google_play = { status: 'skipped' }
}
const events: string[] = []
const copyAiPlacements: Array<'start' | 'checklist'> = []
if (params.get('otaProgress') === '1')
  state.steps.login_cli_mcp = { status: 'done' }
for (const platform of ['ios', 'android'] as const) {
  if (params.get('builderProgress') === platform)
    state.builderSteps[platform].start_setup = { status: 'done' }
  if (params.get('builderComplete') === platform) {
    for (const step of Object.values(state.builderSteps[platform]))
      step.status = 'done'
  }
}
if (params.get('otaComplete') === '1') {
  for (const id of ['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'run_device', 'upload_bundle', 'test_update'])
    state.steps[id] = { status: 'done' }
  state.outcome = 'completed'
  state.channels.push({ id: 1, app_id: previewAppId, name: 'staging', public: true })
}
const channelEvents: Array<{ event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties }> = []
const preview = { state, cicdLedger, events, copyAiPlacements, channelEvents, cicdSetupCalls, gsap, sidebarApps: ref<OrganizationApp[]>([]), appId: ref(previewAppId), command: ref('npx @capgo/cli@latest i [API_KEY]'), hiding: ref(false), selectedOrgId: ref('') }
const previewUserOnboarding = {
  profile_completed_at: '2026-09-25T00:00:00.000Z',
  abtests: {
    ...(params.get('channelTreatment') === '1' ? { new_channel: { assigned_at: '2026-09-25T00:00:00.000Z', branch: 'A' } } : {}),
    ...(params.get('todoListTreatment') === '1' ? { ota_todo_list_v3: { assigned_at: '2026-09-25T00:00:00.000Z', branch: 'A' } } : {}),
  },
  intent: assignment ? 'builder' : 'ota',
  status: params.get('checklistState') === 'completed' ? 'completed' : 'in_progress',
  step: 'setup',
  flow: 'existing_org',
  setup_stage: params.get('setupStage') ?? 'cli',
  app_id: previewAppId,
  ...(params.get('legacyChannel') === '1' ? {} : { final_step: 'setup' }),
}
Object.assign(window, { onboardingSetupPreview: preview })
if (params.get('preOrg') === '1') {
  window.history.replaceState({
    ...window.history.state,
    [ONBOARDING_SETUP_HANDOFF_STATE_KEY]: {
      appId: previewAppId,
      attemptId: 'preview-attempt',
      runId: 'preview-run',
      flow: 'pre_org',
      previousStep: 'organization',
    },
  }, '')
}

function previewOnboarding() {
  const features = params.get('otaInstalled') === '1'
    ? { ota: { succeeded_at: '2026-09-01T00:00:00.000Z' } }
    : {}
  const dismissal = !state.builderActivated && params.get('checklistState') === 'dismissed' ? { getting_started_dismissed_at: '2026-10-01T00:00:00.000Z' } : {}
  const selectedPath = assignment === 'both-ota' || assignment === 'ota-only' ? 'ota' : 'builder'
  const hasBuilder = state.builderActivated || builderComponentView || assignment === 'builder-only' || assignment === 'both-builder' || assignment === 'both-ota'
  const hasOta = (state.builderActivated && state.version === 3) || assignment === 'ota-only' || assignment === 'both-builder' || assignment === 'both-ota'
  const cicd = cicdLedger.value ? { cicd: cicdLedger.value } : {}
  if (hasBuilder || hasOta) {
    return { ...dismissal, ...cicd, features, setup: {
      todo_list_version: 4,
      ...(hasBuilder ? { builder_todo_list_version: '1' } : {}),
      ...(hasOta ? { ota_todo_list_version: '1' } : {}),
      paths: [hasOta ? 'ota' : null, hasBuilder ? 'builder' : null].filter(Boolean),
      ...(assignment === 'builder-only' ? {} : { selected_path: selectedPath }),
      ...(state.selectedBuilderPlatform ? { selected_builder_platform: state.selectedBuilderPlatform } : {}),
      steps: {
        ...(hasOta ? { ota: state.steps } : {}),
        ...(hasBuilder ? { builder: state.builderSteps } : {}),
      },
      outcome: state.outcome,
      source: params.has('checklistState') ? 'cli' : undefined,
    } }
  }
  return { ...dismissal, ...cicd, features, setup: { todo_list_version: state.version, steps: state.steps, outcome: state.outcome, source: params.has('checklistState') ? 'cli' : undefined } }
}

// This isolated component fixture never sends requests to production.
const fixtureFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = init?.method?.toUpperCase() ?? 'GET'
  if (url.pathname.endsWith('/users') && method === 'PATCH')
    state.userWrites.push(JSON.parse(String(init?.body)))
  if ((url.pathname.endsWith('/apps') || url.pathname.endsWith('/rpc/mark_onboarding_feature_started') || url.pathname.endsWith('/rpc/verify_getting_started') || url.pathname.includes('/app/')) && method !== 'GET' && method !== 'HEAD') {
    state.setupWrites.push({
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
  }
  // Existing component tests track app-table edits separately from setup RPCs.
  if (url.pathname.endsWith('/apps') && method !== 'GET' && method !== 'HEAD') {
    state.appWrites.push({
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
  }
  if (url.pathname.endsWith('/onboarding_progress/skip_step')) {
    const { step, reason } = JSON.parse(String(init?.body)) as { step: string, reason: string }
    state.skips.push(step)
    state.skipReasons.push(reason)
    const [path, first, second] = step.split('.')
    if (path === 'ota')
      state.steps[first!] = { status: 'skipped' }
    else
      state.builderSteps[first as 'ios' | 'android'][second!] = { status: 'skipped' }
    return new Response(JSON.stringify({ onboarding: previewOnboarding() }), { headers: { 'Content-Type': 'application/json' } })
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
          onboarding: previewOnboarding(),
          ...(checkChannel && !channelError ? { hasChannel } : {}),
          checkErrors: checkChannel && channelError ? ['add_channel'] : [],
        }), { status: state.error ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.endsWith('/rpc/verify_getting_started')) {
    events.push('getting-started-verified')
    return new Response(JSON.stringify(previewOnboarding()), { headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.endsWith(`/app/${previewAppId}/onboarding/builder`)) {
    if (method === 'GET')
      return new Response(JSON.stringify({ canEnable: true }), { headers: { 'Content-Type': 'application/json' } })
    state.builderActivationRequests.push({ method: init?.method, appId: previewAppId })
    if (state.builderActivationDelayMs)
      await new Promise(resolve => setTimeout(resolve, state.builderActivationDelayMs))
    if (state.builderActivationError)
      return new Response(JSON.stringify({ message: 'Activation unavailable' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    state.builderActivated = true
    state.outcome = 'in_progress'
    return new Response(JSON.stringify({ onboarding: previewOnboarding() }), { headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.endsWith('/build_requests'))
    return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } })
  if (url.pathname.endsWith('/app_versions')) {
    if (state.encryptionDelayMs)
      await new Promise(resolve => setTimeout(resolve, state.encryptionDelayMs))
    return new Response(JSON.stringify(state.encryptionError ? { message: 'Encryption unavailable' } : state.latestBundles), { status: state.encryptionError ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  // The CI/CD guide creates app-scoped secure keys through the API key endpoint.
  if (url.pathname.endsWith('/apikey') && method === 'POST') {
    const body = JSON.parse(String(init?.body))
    state.apikeyCreates.push(body)
    if (state.apikeyError)
      return new Response(JSON.stringify({ error: state.apikeyError }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ key: `cap_ci_preview_key_${state.apikeyCreates.length}`, id: state.apikeyCreates.length, rbac_id: `00000000-0000-4000-8000-${String(state.apikeyCreates.length).padStart(12, '0')}` }), { headers: { 'Content-Type': 'application/json' } })
  }
  if (url.pathname.endsWith('/rpc/record_app_cicd_setup')) {
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    cicdSetupCalls.push(args)
    if (args.p_event === 'key_created' && state.cicdRegistrationError)
      return new Response(JSON.stringify({ message: 'CI registration unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    const at = '2026-11-06T12:00:00.000Z'
    if (args.p_event === 'marked_done')
      cicdLedger.value = { ...cicdLedger.value, marked_done_at: at }
    else
      cicdLedger.value = { ...cicdLedger.value, keys: [args.p_apikey_rbac_id], key_created_at: at }
    return new Response(JSON.stringify(previewOnboarding()), { headers: { 'Content-Type': 'application/json' } })
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
  if (url.pathname.endsWith('/apps')) {
    state.cicdStatusRequests += 1
    const snapshot = { ...previewOnboarding(), ...(state.cicdRemoteLedger ? { cicd: state.cicdRemoteLedger } : {}) }
    if (state.cicdStatusDelayMs)
      await new Promise(resolve => setTimeout(resolve, state.cicdStatusDelayMs))
    state.cicdStatusResponses += 1
    if (cicdView)
      return new Response(JSON.stringify([{ id: '00000000-0000-4000-8000-000000000003', app_id: previewAppId, owner_org: '00000000-0000-4000-8000-000000000002', onboarding: snapshot }]), { headers: { 'Content-Type': 'application/json' } })
  }
  if (params.get('view') === 'flow' || navigationView) {
    if (url.pathname.endsWith('/apps') && params.get('unavailable') === '1')
      return new Response(JSON.stringify({ message: 'App unavailable' }), { status: 406, headers: { 'Content-Type': 'application/json' } })
    const app = { id: '00000000-0000-4000-8000-000000000003', app_id: previewAppId, name: 'My Capacitor app', icon_url: '', owner_org: '00000000-0000-4000-8000-000000000002', need_onboarding: true, onboarding: previewOnboarding() }
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.com', first_name: 'Preview', last_name: 'User', onboarding: previewUserOnboarding }
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

// Console data queries arrive as recorded builder chains; translate them back to
// the PostgREST-style fixture requests above.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (!url.pathname.endsWith('/private/console/query'))
    return fixtureFetch(input, init)
  const query = JSON.parse(String(init?.body))
  const fixtureURL = new URL(`/${query.kind === 'rpc' ? 'rpc/' : ''}${query.name}`, location.origin)
  let method = query.kind === 'rpc' ? 'POST' : 'GET'
  let body = query.kind === 'rpc' ? JSON.stringify(query.args[0]) : undefined
  const headers = new Headers(init?.headers)
  for (const { method: operation, args } of query.operations) {
    if (['eq', 'neq', 'is'].includes(operation)) {
      fixtureURL.searchParams.set(args[0], `${operation}.${args[1]}`)
    }
    else if (operation === 'limit') {
      fixtureURL.searchParams.set('limit', String(args[0]))
    }
    else if (['single', 'maybeSingle'].includes(operation)) {
      headers.set('Accept', 'application/vnd.pgrst.object+json')
    }
    else if (['insert', 'update', 'delete'].includes(operation)) {
      method = operation === 'insert' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE'
      body = args[0] ? JSON.stringify(args[0]) : undefined
    }
  }
  const response = await fixtureFetch(fixtureURL.href, { ...init, headers, method, body })
  let data = await response.json().catch(() => null)
  if (Array.isArray(data) && query.operations.some((op: { method: string }) => ['single', 'maybeSingle'].includes(op.method)))
    data = data[0] ?? null
  return new Response(JSON.stringify({
    data: response.ok ? data : null,
    error: response.ok ? null : data,
    status: response.status,
    count: null,
  }), { headers: { 'Content-Type': 'application/json' } })
}

// Supply a fixture-only session. All fetch calls above are intercepted.
useConsole().auth.getSession = async () => ({ data: { session: { access_token: 'fixture-token' } as any }, error: null })

const app = createApp(defineComponent({
  setup() {
    return () => h('main', {
      class: 'min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8 dark:bg-slate-950',
    }, [
      h('div', { class: 'mx-auto max-w-6xl' }, [
        navigationView
          ? h(RouterView)
          : params.get('view') === 'channel-introduction'
            ? h(ChannelIntroduction, {
                canCreate: params.get('readOnly') !== '1',
                onCreate: () => events.push('channel-create-requested'),
              })
            : params.get('view') === 'flow'
            ? h(AppOnboardingFlow, { onboarding: true, setupAppId: params.get('resume') ?? undefined })
            : cicdView
            ? h(CiCdSetupGuide, {
                appId: preview.appId.value,
                initialProduct: params.get('product') === 'builder' ? 'builder' : undefined,
                initialPlatform: params.get('platform') === 'ios' || params.get('platform') === 'android' ? params.get('platform') as 'ios' | 'android' : undefined,
              })
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
                    onCopyAi: (placement?: 'checklist') => {
                      events.push('copy-ai')
                      copyAiPlacements.push(placement ?? 'start')
                    },
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
Object.defineProperty(useMainStore(pinia), 'user', { value: { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.com', first_name: 'Preview', last_name: 'User', onboarding: previewUserOnboarding } })
Object.defineProperty(useMainStore(pinia), 'auth', { value: { id: '00000000-0000-4000-8000-000000000001' } })
useMainStore(pinia).awaitInitialLoad = async () => true
const organization = useOrganizationStore(pinia)
const previewOrganization = { gid: '00000000-0000-4000-8000-000000000002', name: 'Preview organization', ...(builderIntroView ? { paying: true } : {}) }
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
organization.refreshAppsOnboarding = async (_orgId, options) => {
  state.cicdStatusRequests += 1
  state.cicdSidebarRefreshes.push(options ? [...options.appIds] : null)
  if (state.cicdRemoteLedger) {
    if (!options || options.appIds.includes(previewAppId))
      cicdLedger.value = state.cicdRemoteLedger
    preview.sidebarApps.value = preview.sidebarApps.value.map((app) => {
      if (options && !options.appIds.includes(app.app_id))
        return app
      const onboarding = app.onboarding && typeof app.onboarding === 'object' && !Array.isArray(app.onboarding) ? app.onboarding : {}
      return { ...app, onboarding: { ...onboarding, cicd: state.cicdRemoteLedger } }
    })
  }
}
organization.getAppsByOrgId = orgId => orgId === previewOrganization.gid ? [{ app_id: previewAppId, owner_org: orgId, name: 'My Capacitor app', icon_url: '', need_onboarding: true, onboarding: previewOnboarding() }, ...preview.sidebarApps.value] : []
if (builderIntroView) {
  const builderApp = ref({ app_id: previewAppId, owner_org: previewOrganization.gid, name: 'My Capacitor app', icon_url: '', need_onboarding: true, onboarding: previewOnboarding() })
  organization.getAppByAppId = appId => appId === previewAppId ? builderApp.value as any : undefined
  organization.updateAppOnboarding = (appId, onboarding) => {
    if (appId === previewAppId && onboarding)
      builderApp.value.onboarding = onboarding as ReturnType<typeof previewOnboarding>
  }
}
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
        { path: '/app/:app/ci-cd', name: '/app/[app].ci-cd', component: defineComponent({ setup: () => () => h('div', [h(GettingStartedNav), h(CiCdPage)]) }) },
        // A resume id renders the setup UI the way Getting started embeds it.
        { path: '/:pathMatch(.*)*', component: defineComponent({ setup: () => () => builderIntroView ? h(BuildTable, { appId: previewAppId }) : h(AppOnboardingFlow, { onboarding: true, setupAppId: params.get('resume') ?? undefined }) }) },
      ]
    : [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
})
installOnboardingSetupNavigation({ app, router, routes: router.options.routes })
app.use(router)
Object.assign(preview, { navigate: (path: string) => router.push(path) })
void router.isReady().then(() => app.mount('#app'))
