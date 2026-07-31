<script setup lang="ts">
import type { Tab, TableColumn } from '~/components/comp_def'
import type { Database } from '~/types/supabase.types'
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconCode from '~icons/heroicons/code-bracket'
import IconMegaphone from '~icons/heroicons/megaphone'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconCheckCircle from '~icons/lucide/check-circle-2'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSearch from '~icons/lucide/search'
import IconSend from '~icons/lucide/send'
import IconZap from '~icons/lucide/zap'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

interface NotificationProviderConfig {
  id: string
  platform: string
  status: string
  config: Record<string, unknown>
  secret_ref?: string | null
}

interface NotificationCampaign {
  id: string
  created_at: string
  updated_at?: string
  name: string
  kind: string
  status: string
  audience: Record<string, unknown>
  payload: Record<string, unknown>
  scheduled_at?: string | null
  queued_at?: string | null
  completed_at?: string | null
  counters?: Record<string, unknown> | null
}

interface NotificationDevice {
  deviceKey: string
  recipientKey: string
  platform: string
  appVersion: string
  pluginVersion: string
  badge: number
  permission: number
  updatedAt: string
}

interface NotificationStat {
  event: string
  count: number
}

interface NotificationSettings {
  appId: string
  pushUpdateEnabled: boolean
  pushUpdateInstallMode: 'next' | 'set'
  pushUpdateChannel: string | null
}

interface NotificationQueueResponse {
  queued?: boolean
  campaignId?: string
}

type NotificationTab = 'dashboard' | 'broadcasts' | 'api'

const { t } = useI18n()
const route = useRoute()
const supabase = useSupabase()
const displayStore = useDisplayStore()

const id = ref('')
const isLoading = ref(false)
const isSaving = ref(false)
const app = ref<Database['public']['Tables']['apps']['Row']>()
const providers = ref<NotificationProviderConfig[]>([])
const campaigns = ref<NotificationCampaign[]>([])
const stats = ref<NotificationStat[]>([])
const devices = ref<NotificationDevice[]>([])
const activeNotificationTab = ref<NotificationTab>('dashboard')
const broadcastSearch = ref('')
const apiSearch = ref('')
const broadcastCurrentPage = ref(1)
const apiCurrentPage = ref(1)
const selectedCampaign = ref<NotificationCampaign | null>(null)
const selectedCampaignStats = ref<NotificationStat[]>([])
const selectedCampaignStatsLoading = ref(false)
const settings = ref<NotificationSettings>({
  appId: '',
  pushUpdateEnabled: false,
  pushUpdateInstallMode: 'next',
  pushUpdateChannel: null,
})

const providerForm = ref({
  platform: 'android',
  status: 'draft',
  secretRef: '',
  config: '{\n  "projectId": "",\n  "serviceAccountEmail": ""\n}',
})
const campaignForm = ref({
  name: '',
  kind: 'alert',
  title: '',
  body: '',
})
const lookupExternalId = ref('')
const sendExternalId = ref('')
const sendTitle = ref('')
const sendBody = ref('')
const pushUpdateChannel = ref('')
const notificationTabs: Tab[] = [
  { label: 'notification-dashboard', icon: IconChartBar, key: 'dashboard' },
  { label: 'notification-broadcasts', icon: IconMegaphone, key: 'broadcasts' },
  { label: 'notification-api-sends', icon: IconCode, key: 'api' },
]

function setNotificationTab(tab: Tab) {
  activeNotificationTab.value = tab.key as NotificationTab
}

function normalizeSecretRefSegment(value: string): string {
  let normalized = ''
  let needsSeparator = false
  for (const char of value.toUpperCase()) {
    const code = char.charCodeAt(0)
    const isAlpha = code >= 65 && code <= 90
    const isDigit = code >= 48 && code <= 57
    if (isAlpha || isDigit) {
      if (needsSeparator && normalized)
        normalized += '_'
      normalized += char
      needsSeparator = false
      if (normalized.length >= 96)
        break
    }
    else if (normalized) {
      needsSeparator = true
    }
  }
  return normalized || 'APP'
}

const totalEvents = computed(() => stats.value.reduce((total, item) => total + Number(item.count || 0), 0))
const configuredProviders = computed(() => providers.value.filter(provider => provider.status === 'configured').length)
const hasStats = computed(() => stats.value.length > 0)
const selectedCampaignTotalEvents = computed(() => selectedCampaignStats.value.reduce((total, item) => total + Number(item.count || 0), 0))
const broadcastCampaigns = computed(() => campaigns.value.filter(isBroadcastCampaign).filter(campaign => campaignMatchesSearch(campaign, broadcastSearch.value)))
const apiCampaigns = computed(() => campaigns.value.filter(campaign => !isBroadcastCampaign(campaign)).filter(campaign => campaignMatchesSearch(campaign, apiSearch.value)))
const expectedProviderSecretRef = computed(() => {
  const normalizedAppId = normalizeSecretRefSegment(id.value)
  return `NOTIFICATIONS_${normalizedAppId}_${providerSecretRefSegment(providerForm.value.platform)}`
})
const providerConfigPlaceholder = computed(() => {
  if (providerForm.value.platform === 'ios') {
    return '{\n  "teamId": "",\n  "keyId": "",\n  "bundleId": "",\n  "environment": "production"\n}'
  }
  return '{\n  "projectId": "",\n  "serviceAccountEmail": ""\n}'
})

function providerSecretRefSegment(platform: string) {
  return platform === 'ios' ? 'IOS' : 'ANDROID'
}

function notificationPlatformLabel(platform?: string) {
  if (platform === 'android')
    return t('notification-platform-android')
  if (platform === 'ios')
    return t('notification-platform-ios')
  return platform?.toUpperCase() || t('unknown')
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function campaignMatchesSearch(campaign: NotificationCampaign, search: string) {
  const normalized = search.trim().toLowerCase()
  if (!normalized)
    return true
  return [campaign.name, campaign.kind, campaign.status, campaign.id]
    .some(value => String(value || '').toLowerCase().includes(normalized))
}

function isBroadcastCampaign(campaign: NotificationCampaign) {
  return campaign.audience?.broadcast === true && campaign.kind !== 'update_check'
}

function campaignStatusCell(campaign: NotificationCampaign) {
  return h('span', {
    class: `inline-flex items-center px-2 py-1 text-xs font-medium border rounded-full ${statusClass(campaign.status)}`,
  }, campaign.status)
}

function campaignNameCell(campaign: NotificationCampaign) {
  return h('button', {
    type: 'button',
    class: 'd-btn d-btn-ghost d-btn-sm h-auto min-h-0 max-w-full justify-start px-0 text-left font-medium text-slate-950 hover:underline dark:text-white',
    onClick: () => selectCampaign(campaign),
  }, campaign.name)
}

const campaignColumns = ref<TableColumn[]>([
  {
    label: t('name'),
    key: 'name',
    mobile: true,
    head: true,
    renderFunction: campaignNameCell,
  },
  {
    label: t('type'),
    key: 'kind',
    mobile: true,
  },
  {
    label: t('status'),
    key: 'status',
    mobile: true,
    renderFunction: campaignStatusCell,
  },
  {
    label: t('date'),
    key: 'created_at',
    mobile: false,
    displayFunction: (campaign: NotificationCampaign) => formatShortDate(campaign.created_at),
  },
  {
    key: 'action',
    label: t('action'),
    mobile: true,
    actions: [
      {
        icon: IconSearch,
        title: () => t('notification-view-stats'),
        onClick: (campaign: NotificationCampaign) => selectCampaign(campaign),
      },
    ],
  },
])

let activeRefreshId = 0

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new Error(t('not-authenticated'))
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function notificationFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await authHeaders()
  const requestHeaders = new Headers(init.headers)
  Object.entries(headers).forEach(([key, value]) => requestHeaders.set(key, value))
  const response = await fetch(`${defaultApiHost}/notifications${path}`, {
    ...init,
    headers: requestHeaders,
  })
  if (!response.ok)
    throw new Error(await response.text())
  return response.json() as Promise<T>
}

function parseJson(value: string, fallback: Record<string, unknown>) {
  if (!value.trim())
    return fallback
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('invalid')
    return parsed as Record<string, unknown>
  }
  catch {
    throw new Error(t('notification-invalid-json'))
  }
}

function statusClass(status: string) {
  if (status === 'configured' || status === 'sent')
    return 'border-vista-blue-500/40 bg-vista-blue-500/10 text-vista-blue-700 dark:text-vista-blue-200'
  if (status === 'disabled' || status === 'failed' || status === 'cancelled')
    return 'border-pumpkin-orange-500/40 bg-pumpkin-orange-500/10 text-pumpkin-orange-700 dark:text-pumpkin-orange-200'
  if (status === 'queued' || status === 'sending' || status === 'scheduled')
    return 'border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200'
  return 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300'
}

function formatShortDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortKey(value: string) {
  return value ? value.slice(0, 18) : ''
}

async function loadAppInfo(appId: string) {
  const { data, error } = await supabase
    .from('apps')
    .select()
    .eq('app_id', appId)
    .maybeSingle()
  if (error)
    throw error
  return data ?? undefined
}

async function loadNotifications(appId = id.value) {
  const query = encodeURIComponent(appId)
  const [providerResponse, campaignResponse, statsResponse, settingsResponse] = await Promise.all([
    notificationFetch<{ data: NotificationProviderConfig[] }>(`/providers?app_id=${query}`),
    notificationFetch<{ data: NotificationCampaign[] }>(`/campaigns?app_id=${query}`),
    notificationFetch<{ data: NotificationStat[] }>(`/stats?app_id=${query}&days=30`),
    notificationFetch<NotificationSettings>(`/settings?app_id=${query}`),
  ])
  return {
    campaigns: campaignResponse.data || [],
    providers: providerResponse.data || [],
    settings: settingsResponse,
    stats: statsResponse.data || [],
  }
}

function applyNotificationData(data: Awaited<ReturnType<typeof loadNotifications>>) {
  campaigns.value = data.campaigns
  providers.value = data.providers
  settings.value = data.settings
  stats.value = data.stats
  pushUpdateChannel.value = data.settings.pushUpdateChannel || ''
}

async function reloadNotifications() {
  applyNotificationData(await loadNotifications())
}

async function refreshData(appId = id.value, refreshId = ++activeRefreshId) {
  isLoading.value = true
  try {
    const appData = await loadAppInfo(appId)
    if (refreshId !== activeRefreshId)
      return
    app.value = appData
    if (!appData)
      return

    try {
      applyNotificationData(await loadNotifications(appId))
    }
    catch (error) {
      if (refreshId !== activeRefreshId)
        return
      console.error(error)
      toast.error(t('notification-load-error'))
    }
  }
  catch (error) {
    if (refreshId !== activeRefreshId)
      return
    console.error(error)
    toast.error(t('notification-load-error'))
  }
  finally {
    if (refreshId === activeRefreshId)
      isLoading.value = false
  }
}

async function saveProvider() {
  isSaving.value = true
  try {
    await notificationFetch('/providers', {
      method: 'PUT',
      body: JSON.stringify({
        appId: id.value,
        platform: providerForm.value.platform,
        status: providerForm.value.status,
        secretRef: providerForm.value.secretRef.trim() || (providerForm.value.status === 'configured' ? expectedProviderSecretRef.value : null),
        config: parseJson(providerForm.value.config, {}),
      }),
    })
    toast.success(t('notification-save-success'))
    await reloadNotifications()
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

async function selectCampaignById(campaignId?: string) {
  if (!campaignId)
    return
  const campaign = campaigns.value.find(item => item.id === campaignId)
  if (campaign)
    await selectCampaign(campaign)
}

async function createBroadcast() {
  if (!campaignForm.value.name.trim() || (!campaignForm.value.title.trim() && !campaignForm.value.body.trim()))
    return
  isSaving.value = true
  try {
    const payload = {
      ...(campaignForm.value.title.trim() ? { title: campaignForm.value.title.trim() } : {}),
      ...(campaignForm.value.body.trim() ? { body: campaignForm.value.body.trim() } : {}),
    }
    const response = await notificationFetch<NotificationQueueResponse>('/send', {
      method: 'POST',
      body: JSON.stringify({
        appId: id.value,
        name: campaignForm.value.name.trim(),
        kind: campaignForm.value.kind,
        target: { broadcast: true },
        payload,
      }),
    })
    if (!response.queued)
      throw new Error(t('notification-queue-unavailable'))
    campaignForm.value.name = ''
    campaignForm.value.title = ''
    campaignForm.value.body = ''
    toast.success(t('notification-broadcast-queued'))
    await reloadNotifications()
    await selectCampaignById(response.campaignId)
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

async function loadCampaignStats(campaign: NotificationCampaign) {
  selectedCampaignStatsLoading.value = true
  selectedCampaignStats.value = []
  try {
    const query = encodeURIComponent(id.value)
    const campaignId = encodeURIComponent(campaign.id)
    const response = await notificationFetch<{ data: NotificationStat[] }>(`/stats?app_id=${query}&campaign_id=${campaignId}&days=30`)
    if (selectedCampaign.value?.id === campaign.id)
      selectedCampaignStats.value = response.data || []
  }
  catch (error) {
    if (selectedCampaign.value?.id !== campaign.id)
      return
    console.error(error)
    toast.error(t('notification-load-error'))
  }
  finally {
    if (selectedCampaign.value?.id === campaign.id)
      selectedCampaignStatsLoading.value = false
  }
}

async function selectCampaign(campaign: NotificationCampaign) {
  selectedCampaign.value = campaign
  await loadCampaignStats(campaign)
}

async function lookupRecipient() {
  if (!lookupExternalId.value.trim())
    return
  isSaving.value = true
  try {
    const response = await notificationFetch<{ devices: NotificationDevice[] }>('/recipients/lookup', {
      method: 'POST',
      body: JSON.stringify({ appId: id.value, externalId: lookupExternalId.value.trim() }),
    })
    devices.value = response.devices || []
    toast.success(t('notification-lookup-success'))
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

async function saveNotificationSettings() {
  isSaving.value = true
  try {
    settings.value = await notificationFetch<NotificationSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        appId: id.value,
        pushUpdateEnabled: settings.value.pushUpdateEnabled,
        pushUpdateInstallMode: settings.value.pushUpdateInstallMode,
        pushUpdateChannel: pushUpdateChannel.value.trim() || null,
      }),
    })
    pushUpdateChannel.value = settings.value.pushUpdateChannel || ''
    toast.success(t('notification-settings-save-success'))
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

async function pushUpdateNow() {
  isSaving.value = true
  try {
    const response = await notificationFetch<NotificationQueueResponse>('/update-check', {
      method: 'POST',
      body: JSON.stringify({
        appId: id.value,
        target: { broadcast: true },
        installMode: settings.value.pushUpdateInstallMode,
        channel: pushUpdateChannel.value.trim() || null,
      }),
    })
    if (!response.queued)
      throw new Error(t('notification-queue-unavailable'))
    toast.success(t('notification-update-push-success'))
    await reloadNotifications()
    await selectCampaignById(response.campaignId)
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

async function sendTest() {
  if (!sendExternalId.value.trim())
    return
  isSaving.value = true
  try {
    const response = await notificationFetch<NotificationQueueResponse>('/send', {
      method: 'POST',
      body: JSON.stringify({
        appId: id.value,
        name: sendTitle.value.trim() || t('notification-quick-send'),
        kind: 'alert',
        target: { externalId: sendExternalId.value.trim() },
        payload: { title: sendTitle.value.trim(), body: sendBody.value.trim() },
        limit: 10,
      }),
    })
    if (!response.queued)
      throw new Error(t('notification-queue-unavailable'))
    toast.success(t('notification-send-success'))
    await reloadNotifications()
    await selectCampaignById(response.campaignId)
  }
  catch (error) {
    console.error(error)
    toast.error(error instanceof Error ? error.message : t('notification-action-error'))
  }
  finally {
    isSaving.value = false
  }
}

watch(() => {
  const params = route.params as { app?: string | string[] }
  return typeof params.app === 'string' ? params.app : ''
}, async (appParam) => {
  const refreshId = ++activeRefreshId
  id.value = appParam
  if (!appParam) {
    app.value = undefined
    providers.value = []
    campaigns.value = []
    stats.value = []
    devices.value = []
    selectedCampaign.value = null
    selectedCampaignStats.value = []
    selectedCampaignStatsLoading.value = false
    isLoading.value = false
    return
  }

  await refreshData(appParam, refreshId)
  if (refreshId === activeRefreshId) {
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
}, { immediate: true })

watch(() => providerForm.value.platform, () => {
  providerForm.value.config = providerConfigPlaceholder.value
})

watch(broadcastSearch, () => {
  broadcastCurrentPage.value = 1
})

watch(apiSearch, () => {
  apiCurrentPage.value = 1
})

watch(activeNotificationTab, () => {
  selectedCampaign.value = null
  selectedCampaignStats.value = []
  selectedCampaignStatsLoading.value = false
})
</script>

<template>
  <div>
    <div v-if="app || isLoading">
      <nav class="relative -mt-px border-t bg-blue-50 dark:bg-slate-800/40 border-blue-200/60 dark:border-blue-800/70" aria-label="Notification sections">
        <ul class="flex flex-nowrap max-w-full gap-2 px-1 py-2 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x no-scrollbar text-sm font-medium text-center text-gray-600 dark:text-gray-200">
          <li v-for="tab in notificationTabs" :key="tab.key" class="mr-2">
            <button
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50 dark:focus-visible:ring-offset-slate-900 transition-colors group"
              :class="activeNotificationTab === tab.key
                ? 'text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-800 border border-blue-200/70 dark:border-blue-800 shadow-sm hover:ring-1 hover:ring-blue-200 dark:hover:ring-blue-700 hover:bg-blue-50 dark:hover:bg-slate-900 transition-colors'
                : 'border border-transparent text-slate-500/75 dark:text-slate-400/75 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-700 dark:hover:text-slate-200 transition-colors'"
              :aria-current="activeNotificationTab === tab.key ? 'page' : undefined"
              @click="setNotificationTab(tab)"
            >
              <component :is="tab.icon" class="w-5 h-5 transition-colors" aria-hidden="true" />
              <span class="hidden text-xs font-medium transition-colors md:block md:text-sm first-letter:uppercase">{{ t(tab.label) }}</span>
            </button>
          </li>
        </ul>
      </nav>
      <div class="mt-0 md:mt-8">
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
            <div class="flex flex-col gap-4 px-4 py-4 border-b sm:flex-row sm:items-center sm:justify-between border-slate-200 dark:border-slate-700">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h1 class="text-lg font-semibold leading-6 text-gray-900 dark:text-gray-100">
                    {{ t('notification-title') }}
                  </h1>
                  <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t('beta') }}</span>
                </div>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {{ t('notification-beta-description') }}
                </p>
              </div>
              <button class="self-start d-btn d-btn-sm d-btn-outline sm:self-auto" :disabled="isLoading" @click="() => refreshData()">
                <span v-if="isLoading" class="d-loading d-loading-spinner d-loading-xs" />
                <IconRefresh v-else class="w-4 h-4" aria-hidden="true" />
                {{ t('refresh') }}
              </button>
            </div>
            <div class="grid border-b divide-y sm:grid-cols-2 lg:grid-cols-4 sm:divide-x sm:divide-y-0 divide-slate-200 border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              <div class="p-4">
                <div class="text-xs font-medium truncate text-slate-500 dark:text-slate-400">
                  {{ t('notification-configured-providers') }}
                </div>
                <div class="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ configuredProviders }}
                </div>
              </div>
              <div class="p-4">
                <div class="text-xs font-medium truncate text-slate-500 dark:text-slate-400">
                  {{ t('notification-events-30d') }}
                </div>
                <div class="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ totalEvents }}
                </div>
              </div>
              <div class="p-4">
                <div class="text-xs font-medium truncate text-slate-500 dark:text-slate-400">
                  {{ t('notification-campaigns') }}
                </div>
                <div class="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ campaigns.length }}
                </div>
              </div>
              <div class="p-4">
                <div class="text-xs font-medium truncate text-slate-500 dark:text-slate-400">
                  {{ t('notification-device-results') }}
                </div>
                <div class="mt-1 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ devices.length }}
                </div>
              </div>
            </div>

            <div v-if="activeNotificationTab === 'dashboard'" class="grid divide-y xl:grid-cols-[minmax(0,1fr)_22rem] xl:divide-x xl:divide-y-0 divide-slate-200 dark:divide-slate-700">
              <main class="min-w-0 p-4 space-y-5">
                <section class="space-y-4">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                      {{ t('notification-provider-setup') }}
                    </h2>
                    <button class="self-start d-btn d-btn-sm d-btn-primary sm:self-auto" :disabled="isSaving" @click="saveProvider">
                      <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
                      <IconCheckCircle v-else class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-save-provider') }}
                    </button>
                  </div>

                  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div class="space-y-4">
                      <div class="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                        <label class="space-y-1">
                          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-platform') }}</span>
                          <select v-model="providerForm.platform" class="w-full d-select d-select-bordered">
                            <option value="android">
                              {{ t('notification-platform-android') }}
                            </option>
                            <option value="ios">
                              {{ t('notification-platform-ios') }}
                            </option>
                          </select>
                        </label>
                        <label class="space-y-1">
                          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('status') }}</span>
                          <select v-model="providerForm.status" class="w-full d-select d-select-bordered">
                            <option value="draft">
                              {{ t('draft') }}
                            </option>
                            <option value="configured">
                              {{ t('configured') }}
                            </option>
                            <option value="disabled">
                              {{ t('disabled') }}
                            </option>
                          </select>
                        </label>
                        <label class="space-y-1 sm:col-span-2 2xl:col-span-2">
                          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-provider-secret-ref') }}</span>
                          <input v-model="providerForm.secretRef" class="w-full d-input d-input-bordered" :placeholder="expectedProviderSecretRef">
                          <span class="block text-xs leading-5 text-slate-500 dark:text-slate-400">{{ t('notification-provider-secret-ref-help') }}</span>
                        </label>
                      </div>
                      <label class="block space-y-1">
                        <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-provider-config-json') }}</span>
                        <textarea v-model="providerForm.config" class="w-full font-mono text-sm d-textarea d-textarea-bordered min-h-36" :placeholder="providerConfigPlaceholder" />
                        <span class="block text-xs leading-5 text-slate-500 dark:text-slate-400">{{ t('notification-provider-config-help') }}</span>
                      </label>
                    </div>

                    <div class="overflow-hidden border rounded-lg border-slate-200 dark:border-slate-700">
                      <div class="px-3 py-2 text-sm font-medium bg-slate-50 text-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
                        {{ t('notification-active-providers') }}
                      </div>
                      <div v-if="providers.length" class="divide-y divide-slate-200 dark:divide-slate-700">
                        <div v-for="provider in providers" :key="provider.id" class="p-3">
                          <div class="flex items-center justify-between gap-3">
                            <span class="font-medium text-slate-950 dark:text-white">{{ notificationPlatformLabel(provider.platform) }}</span>
                            <span class="inline-flex items-center px-2 py-1 text-xs font-medium border rounded-full" :class="statusClass(provider.status)">
                              {{ provider.status }}
                            </span>
                          </div>
                          <div class="mt-2 font-mono text-xs break-all text-slate-500 dark:text-slate-400">
                            {{ provider.secret_ref || t('not-set') }}
                          </div>
                        </div>
                      </div>
                      <div v-else class="p-4 text-sm text-slate-500 dark:text-slate-400">
                        {{ t('notification-no-providers') }}
                      </div>
                    </div>
                  </div>
                </section>
              </main>

              <aside class="p-4 space-y-6" aria-labelledby="notification-push-update-title">
                <section class="space-y-3">
                  <h2 id="notification-push-update-title" class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('notification-push-update') }}
                  </h2>
                  <label class="flex items-center justify-between gap-3 p-3 border rounded-lg border-slate-200 dark:border-slate-700">
                    <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-push-update-enabled') }}</span>
                    <input v-model="settings.pushUpdateEnabled" type="checkbox" class="d-toggle d-toggle-primary" :aria-label="t('notification-push-update-enabled')">
                  </label>
                  <label class="block space-y-1">
                    <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-update-install-mode') }}</span>
                    <select v-model="settings.pushUpdateInstallMode" class="w-full d-select d-select-bordered">
                      <option value="next">
                        {{ t('notification-update-install-next') }}
                      </option>
                      <option value="set">
                        {{ t('notification-update-install-now') }}
                      </option>
                    </select>
                  </label>
                  <label class="block space-y-1">
                    <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('channel') }}</span>
                    <input v-model="pushUpdateChannel" class="w-full d-input d-input-bordered" :placeholder="t('channel')">
                  </label>
                  <div class="grid grid-cols-2 gap-2">
                    <button class="d-btn d-btn-sm d-btn-outline" :disabled="isSaving" @click="saveNotificationSettings">
                      <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
                      <IconCheckCircle v-else class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-save-settings') }}
                    </button>
                    <button class="d-btn d-btn-sm d-btn-primary" :disabled="isSaving || !settings.pushUpdateEnabled" @click="pushUpdateNow">
                      <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
                      <IconZap v-else class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-push-update-now') }}
                    </button>
                  </div>
                </section>

                <section class="pt-6 space-y-3 border-t border-slate-200 dark:border-slate-700">
                  <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                    {{ t('notification-stats') }}
                  </h2>
                  <div>
                    <div class="text-3xl font-semibold text-slate-950 dark:text-white">
                      {{ totalEvents }}
                    </div>
                    <div class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {{ t('notification-events-30d') }}
                    </div>
                  </div>
                  <div v-if="hasStats" class="space-y-3">
                    <div v-for="stat in stats" :key="stat.event" class="space-y-1">
                      <div class="flex items-center justify-between gap-3 text-sm">
                        <span class="font-medium text-slate-700 dark:text-slate-200">{{ stat.event }}</span>
                        <span class="font-mono text-slate-950 dark:text-white">{{ stat.count }}</span>
                      </div>
                      <progress class="w-full h-1.5 d-progress d-progress-secondary" :value="stat.count" :max="totalEvents || 1" />
                    </div>
                  </div>
                  <div v-else class="text-sm text-slate-500 dark:text-slate-400">
                    {{ t('notification-no-stats') }}
                  </div>
                </section>
              </aside>
            </div>

            <div v-else class="grid divide-y xl:grid-cols-[minmax(0,1fr)_22rem] xl:divide-x xl:divide-y-0 divide-slate-200 dark:divide-slate-700">
              <main class="min-w-0">
                <section v-if="activeNotificationTab === 'broadcasts'" class="p-4 space-y-4 border-b border-slate-200 dark:border-slate-700">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                      {{ t('notification-create-broadcast') }}
                    </h2>
                    <button class="self-start d-btn d-btn-sm d-btn-primary sm:self-auto" :disabled="isSaving || !campaignForm.name.trim() || (!campaignForm.title.trim() && !campaignForm.body.trim())" @click="createBroadcast">
                      <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
                      <IconSend v-else class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-create-broadcast') }}
                    </button>
                  </div>

                  <div class="grid gap-4 lg:grid-cols-2">
                    <label class="space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-campaign-name') }}</span>
                      <input v-model="campaignForm.name" class="w-full d-input d-input-bordered" :placeholder="t('notification-campaign-name')">
                    </label>
                    <label class="space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('type') }}</span>
                      <select v-model="campaignForm.kind" class="w-full d-select d-select-bordered">
                        <option value="alert">
                          alert
                        </option>
                        <option value="background">
                          background
                        </option>
                      </select>
                    </label>
                    <label class="space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-message-title') }}</span>
                      <input v-model="campaignForm.title" class="w-full d-input d-input-bordered" :placeholder="t('notification-message-title')">
                    </label>
                    <label class="space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-message-body') }}</span>
                      <textarea v-model="campaignForm.body" class="w-full d-textarea d-textarea-bordered min-h-24" :placeholder="t('notification-message-body')" />
                    </label>
                  </div>
                </section>

                <section class="px-4 pt-4">
                  <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                      {{ activeNotificationTab === 'broadcasts' ? t('notification-broadcasts') : t('notification-api-sends') }}
                    </h2>
                    <span class="text-sm text-slate-500 dark:text-slate-400">
                      {{ activeNotificationTab === 'broadcasts' ? broadcastCampaigns.length : apiCampaigns.length }} {{ t('notification-campaigns') }}
                    </span>
                  </div>
                </section>
                <DataTable
                  v-if="activeNotificationTab === 'broadcasts'"
                  v-model:columns="campaignColumns"
                  v-model:current-page="broadcastCurrentPage"
                  v-model:search="broadcastSearch"
                  :total="broadcastCampaigns.length"
                  :element-list="broadcastCampaigns"
                  :is-loading="isLoading"
                  :auto-reload="false"
                  :mobile-fixed-pagination="false"
                  :search-placeholder="t('notification-search-campaigns')"
                  @reload="reloadNotifications()"
                  @reset="reloadNotifications()"
                />
                <DataTable
                  v-else
                  v-model:columns="campaignColumns"
                  v-model:current-page="apiCurrentPage"
                  v-model:search="apiSearch"
                  :total="apiCampaigns.length"
                  :element-list="apiCampaigns"
                  :is-loading="isLoading"
                  :auto-reload="false"
                  :mobile-fixed-pagination="false"
                  :search-placeholder="t('notification-search-campaigns')"
                  @reload="reloadNotifications()"
                  @reset="reloadNotifications()"
                />

                <section v-if="activeNotificationTab === 'api'" class="grid gap-6 p-4 border-t lg:grid-cols-2 border-slate-200 dark:border-slate-700">
                  <div class="space-y-3">
                    <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                      {{ t('notification-quick-send') }}
                    </h2>
                    <label class="block space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-recipient-external-id') }}</span>
                      <input v-model="sendExternalId" class="w-full d-input d-input-bordered" :placeholder="t('notification-recipient-external-id')">
                    </label>
                    <label class="block space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-message-title') }}</span>
                      <input v-model="sendTitle" class="w-full d-input d-input-bordered" :placeholder="t('notification-message-title')">
                    </label>
                    <label class="block space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-message-body') }}</span>
                      <textarea v-model="sendBody" class="w-full d-textarea d-textarea-bordered min-h-24" :placeholder="t('notification-message-body')" />
                    </label>
                    <button class="w-full d-btn d-btn-sm d-btn-primary" :disabled="isSaving || !sendExternalId.trim()" @click="sendTest">
                      <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
                      <IconSend v-else class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-send-test') }}
                    </button>
                  </div>

                  <div class="space-y-3">
                    <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                      {{ t('notification-recipient-lookup') }}
                    </h2>
                    <label class="block space-y-1">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('notification-recipient-external-id') }}</span>
                      <input v-model="lookupExternalId" class="w-full d-input d-input-bordered" :placeholder="t('notification-recipient-external-id')">
                    </label>
                    <button class="w-full d-btn d-btn-sm d-btn-outline" :disabled="isSaving || !lookupExternalId.trim()" @click="lookupRecipient">
                      <IconSearch class="w-4 h-4" aria-hidden="true" />
                      {{ t('notification-lookup') }}
                    </button>
                    <div class="overflow-x-auto border rounded-lg border-slate-200 dark:border-slate-700">
                      <table class="w-full text-sm text-left text-gray-500 d-table d-table-sm dark:text-gray-400">
                        <thead class="text-gray-700 bg-gray-50 dark:text-gray-400 dark:bg-gray-700">
                          <tr>
                            <th class="whitespace-nowrap">
                              {{ t('device') }}
                            </th>
                            <th class="whitespace-nowrap">
                              {{ t('platform') }}
                            </th>
                            <th class="whitespace-nowrap">
                              {{ t('badge') }}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="device in devices" :key="device.deviceKey">
                            <td class="font-mono text-xs">
                              {{ shortKey(device.deviceKey) }}
                            </td>
                            <td>{{ notificationPlatformLabel(device.platform) }}</td>
                            <td>{{ device.badge }}</td>
                          </tr>
                          <tr v-if="!devices.length">
                            <td colspan="3" class="text-slate-500 dark:text-slate-400">
                              {{ t('notification-no-devices') }}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              </main>

              <aside class="p-4 space-y-4" aria-labelledby="notification-campaign-stats-title">
                <h2 id="notification-campaign-stats-title" class="text-base font-semibold text-slate-950 dark:text-white">
                  {{ t('notification-campaign-stats') }}
                </h2>
                <div v-if="selectedCampaign" class="space-y-4">
                  <div>
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h3 class="font-semibold break-words text-slate-950 dark:text-white">
                          {{ selectedCampaign.name }}
                        </h3>
                        <p class="mt-1 font-mono text-xs break-all text-slate-500 dark:text-slate-400">
                          {{ selectedCampaign.id }}
                        </p>
                      </div>
                      <span class="inline-flex items-center px-2 py-1 text-xs font-medium border rounded-full shrink-0" :class="statusClass(selectedCampaign.status)">
                        {{ selectedCampaign.status }}
                      </span>
                    </div>
                    <dl class="grid grid-cols-2 gap-2 mt-3 text-sm">
                      <div class="p-2 border rounded-md border-slate-200 dark:border-slate-700">
                        <dt class="text-xs font-medium text-slate-500 dark:text-slate-400">
                          {{ t('type') }}
                        </dt>
                        <dd class="font-medium text-slate-900 dark:text-white">
                          {{ selectedCampaign.kind }}
                        </dd>
                      </div>
                      <div class="p-2 border rounded-md border-slate-200 dark:border-slate-700">
                        <dt class="text-xs font-medium text-slate-500 dark:text-slate-400">
                          {{ t('date') }}
                        </dt>
                        <dd class="font-medium text-slate-900 dark:text-white">
                          {{ formatShortDate(selectedCampaign.created_at) }}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div>
                    <div class="text-3xl font-semibold text-slate-950 dark:text-white">
                      {{ selectedCampaignTotalEvents }}
                    </div>
                    <div class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {{ t('notification-events-30d') }}
                    </div>
                  </div>

                  <div v-if="selectedCampaignStatsLoading" class="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <span class="d-loading d-loading-spinner d-loading-xs" />
                    {{ t('loading') }}
                  </div>
                  <div v-else-if="selectedCampaignStats.length" class="space-y-3">
                    <div v-for="stat in selectedCampaignStats" :key="stat.event" class="space-y-1">
                      <div class="flex items-center justify-between gap-3 text-sm">
                        <span class="font-medium text-slate-700 dark:text-slate-200">{{ stat.event }}</span>
                        <span class="font-mono text-slate-950 dark:text-white">{{ stat.count }}</span>
                      </div>
                      <progress class="w-full h-1.5 d-progress d-progress-secondary" :value="stat.count" :max="selectedCampaignTotalEvents || 1" />
                    </div>
                  </div>
                  <div v-else class="text-sm text-slate-500 dark:text-slate-400">
                    {{ t('notification-no-stats') }}
                  </div>

                  <div class="space-y-3">
                    <div>
                      <div class="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                        {{ t('notification-audience-json') }}
                      </div>
                      <pre class="max-h-40 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">{{ formatJson(selectedCampaign.audience) }}</pre>
                    </div>
                    <div>
                      <div class="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                        {{ t('notification-payload-json') }}
                      </div>
                      <pre class="max-h-40 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">{{ formatJson(selectedCampaign.payload) }}</pre>
                    </div>
                  </div>
                </div>
                <div v-else class="text-sm text-slate-500 dark:text-slate-400">
                  {{ t('notification-select-campaign') }}
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('app-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('app-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="$router.push('/apps')">
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
