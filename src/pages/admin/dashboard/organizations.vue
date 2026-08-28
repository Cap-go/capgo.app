<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { formatLocalDate, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

type BillingType = 'monthly' | 'yearly'
type BillingFilter = BillingType | 'all'
type SupportChannelType = 'slack' | 'discord' | 'teams'

interface OrganizationInsight {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  billing_type: BillingType | null
  upload_count: number
  build_count: number
  failed_update_count: number
  install_count: number
  update_attempt_count: number
  needs_attention: boolean
  fail_rate: number
  mau: number
  members_count: number
  apps_count: number
  last_upload_at: string | null
  last_build_at: string | null
  paid_at: string | null
  registered_at: string
  distribution_stage: string | null
  has_sso: boolean
  support_channel_type: SupportChannelType | null
  support_channel_url: string | null
}

interface OrganizationInsightsResponse {
  success: boolean
  data: {
    organizations: OrganizationInsight[]
    total: number
    plan_options: string[]
  }
}

interface EnterpriseAdoptionPoint {
  date: string
  enterprise_count: number
  sso_count: number
  channel_count: number
}

interface EnterpriseAdoptionResponse {
  trend?: EnterpriseAdoptionPoint[]
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()

const PAGE_SIZE = 50
const organizations = ref<OrganizationInsight[]>([])
const totalOrganizations = ref(0)
const currentPage = ref(1)
const isLoadingOrganizations = ref(false)
const planOptions = ref<string[]>([])
const selectedPlan = ref('Enterprise')
const selectedBilling = ref<BillingFilter>('all')
const paidOnly = ref(true)
const searchQuery = ref('')
const adoptionTrend = ref<EnterpriseAdoptionPoint[]>([])
const isLoadingAdoption = ref(false)
const channelEditorOpen = ref(false)
const channelEditorOrg = ref<OrganizationInsight | null>(null)
const channelEditorType = ref<SupportChannelType | ''>('')
const channelEditorUrl = ref('')
const isSavingChannel = ref(false)
let loadOrganizationsSequence = 0
let searchReloadTimer: ReturnType<typeof setTimeout> | undefined

function formatNumber(value: number) {
  return formatNumberValue(value)
}

function formatPercent(value: number) {
  return `${formatNumberValue(Number(value || 0), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatBillingTypeLabel(billingType: OrganizationInsight['billing_type']) {
  if (billingType === 'yearly')
    return t('yearly')
  if (billingType === 'monthly')
    return t('monthly')
  return t('unknown')
}

function formatDateOrNever(value: string | null) {
  return formatLocalDateTime(value) || t('never')
}

const DISTRIBUTION_STAGE_LABEL_KEYS: Record<string, string> = {
  no_device: 'distribution-stage-no-device',
  local_only: 'distribution-stage-local-only',
  native_unknown: 'distribution-stage-native-unknown',
  play_unknown: 'distribution-stage-play-unknown',
  testflight: 'distribution-stage-testflight',
  store_live: 'distribution-stage-store-live',
}

function formatDistributionStage(stage: string | null) {
  if (!stage)
    return t('unknown')
  const key = DISTRIBUTION_STAGE_LABEL_KEYS[stage]
  return key ? t(key) : t('unknown')
}

function formatSupportChannelType(type: SupportChannelType | null) {
  if (type === 'slack')
    return t('support-channel-slack')
  if (type === 'discord')
    return t('support-channel-discord')
  if (type === 'teams')
    return t('support-channel-teams')
  return t('support-channel-none')
}

function adoptionPercent(count: number, total: number) {
  if (total <= 0)
    return 0
  return Math.round((count / total) * 1000) / 10
}

const ssoChartSeries = computed(() => [{
  label: t('enterprise-count'),
  color: '#2563eb',
  data: adoptionTrend.value.map(point => ({ date: point.date, value: point.enterprise_count })),
}, {
  label: t('enterprise-sso-count'),
  color: '#10b981',
  data: adoptionTrend.value.map(point => ({ date: point.date, value: point.sso_count })),
}])

const channelChartSeries = computed(() => [{
  label: t('enterprise-count'),
  color: '#2563eb',
  data: adoptionTrend.value.map(point => ({ date: point.date, value: point.enterprise_count })),
}, {
  label: t('enterprise-channel-count'),
  color: '#8b5cf6',
  data: adoptionTrend.value.map(point => ({ date: point.date, value: point.channel_count })),
}])

const adoptionChartSeries = computed(() => [{
  label: t('enterprise-sso-adoption'),
  color: '#10b981',
  data: adoptionTrend.value.map(point => ({
    date: point.date,
    value: adoptionPercent(point.sso_count, point.enterprise_count),
  })),
}, {
  label: t('enterprise-channel-adoption'),
  color: '#8b5cf6',
  data: adoptionTrend.value.map(point => ({
    date: point.date,
    value: adoptionPercent(point.channel_count, point.enterprise_count),
  })),
}])

const hasAdoptionData = computed(() => adoptionTrend.value.some(point => point.enterprise_count > 0 || point.sso_count > 0 || point.channel_count > 0))

async function loadEnterpriseAdoption(forceRefresh = false) {
  isLoadingAdoption.value = true
  try {
    const payload = await adminStore.fetchStats('enterprise_adoption', forceRefresh) as EnterpriseAdoptionResponse
    adoptionTrend.value = Array.isArray(payload?.trend) ? payload.trend : []
  }
  catch (error) {
    console.error('[Admin Dashboard Organizations] Error loading enterprise adoption:', error)
    adoptionTrend.value = []
  }
  finally {
    isLoadingAdoption.value = false
  }
}

function openChannelEditor(item: OrganizationInsight) {
  channelEditorOrg.value = item
  channelEditorType.value = item.support_channel_type ?? ''
  channelEditorUrl.value = item.support_channel_url ?? ''
  channelEditorOpen.value = true
}

function closeChannelEditor() {
  channelEditorOpen.value = false
  channelEditorOrg.value = null
  channelEditorType.value = ''
  channelEditorUrl.value = ''
}

async function saveSupportChannel(clear = false) {
  const org = channelEditorOrg.value
  if (!org)
    return

  const supportChannelType = clear ? null : (channelEditorType.value || null)
  const supportChannelUrl = clear ? null : (channelEditorUrl.value.trim() || null)
  if (!clear && (!supportChannelType || !supportChannelUrl)) {
    toast.error(t('sso-fill-all-fields'))
    return
  }

  isSavingChannel.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const response = await fetch(`${defaultApiHost}/private/admin_org_support_channel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        org_id: org.org_id,
        support_channel_type: supportChannelType,
        support_channel_url: supportChannelUrl,
      }),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const index = organizations.value.findIndex(row => row.org_id === org.org_id)
    if (index !== -1) {
      organizations.value[index] = {
        ...organizations.value[index],
        support_channel_type: supportChannelType,
        support_channel_url: supportChannelUrl,
      }
    }

    toast.success(t('support-channel-saved'))
    closeChannelEditor()
    await loadEnterpriseAdoption(true)
  }
  catch (error) {
    console.error('[Admin Dashboard Organizations] Error saving support channel:', error)
    toast.error(t('sso-error-updating'))
  }
  finally {
    isSavingChannel.value = false
  }
}

function getOrganizationAttentionLabel(item: OrganizationInsight) {
  const failRate = Number(item.fail_rate || 0)
  const failedUpdateCount = Number(item.failed_update_count || 0)
  const updateAttemptCount = Number(item.update_attempt_count || 0)

  if (!item.needs_attention)
    return null

  return t('organization-attention-high-fail-rate', {
    failRate: formatPercent(failRate),
    failed: formatNumber(failedUpdateCount),
    total: formatNumber(updateAttemptCount),
  })
}

async function loadOrganizations() {
  const sequence = ++loadOrganizationsSequence
  isLoadingOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const { start, end } = adminStore.activeDateRange
    const body: Record<string, unknown> = {
      metric_category: 'organization_insights',
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      limit: PAGE_SIZE,
      offset: (currentPage.value - 1) * PAGE_SIZE,
    }

    if (selectedPlan.value)
      body.plan_name = selectedPlan.value
    if (selectedBilling.value !== 'all')
      body.billing_type = selectedBilling.value
    if (paidOnly.value)
      body.paid_only = true
    if (searchQuery.value.trim())
      body.search = searchQuery.value.trim()

    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const payload = await response.json() as OrganizationInsightsResponse
    if (!payload.success)
      throw new Error('Failed to fetch organization insights')

    if (sequence !== loadOrganizationsSequence)
      return

    organizations.value = payload.data.organizations || []
    totalOrganizations.value = payload.data.total || 0
    planOptions.value = payload.data.plan_options || []
  }
  catch (error) {
    if (sequence !== loadOrganizationsSequence)
      return

    console.error('[Admin Dashboard Organizations] Error loading organization insights:', error)
    organizations.value = []
    totalOrganizations.value = 0
    planOptions.value = selectedPlan.value ? [selectedPlan.value] : []
  }
  finally {
    if (sequence === loadOrganizationsSequence)
      isLoadingOrganizations.value = false
  }
}

function resetToFirstPageAndLoad() {
  currentPage.value = 1
  loadOrganizations()
}

function cancelDebouncedSearchReload() {
  if (!searchReloadTimer)
    return

  clearTimeout(searchReloadTimer)
  searchReloadTimer = undefined
}

function loadOrganizationsImmediately() {
  cancelDebouncedSearchReload()
  loadOrganizations()
}

function resetToFirstPageAndLoadImmediately() {
  currentPage.value = 1
  loadOrganizationsImmediately()
}

function scheduleSearchReload() {
  cancelDebouncedSearchReload()
  searchReloadTimer = setTimeout(() => {
    searchReloadTimer = undefined
    resetToFirstPageAndLoad()
  }, 350)
}

const organizationColumns = computed<TableColumn[]>(() => [
  {
    label: t('org-name'),
    key: 'org_name',
    mobile: true,
    head: true,
    sortable: false,
    renderFunction: (item: OrganizationInsight) => {
      const attentionLabel = getOrganizationAttentionLabel(item)

      return h('div', { class: 'flex min-w-0 items-start gap-2' }, [
        attentionLabel
          ? h('span', { class: 'inline-flex shrink-0 items-start' }, [
              h('span', {
                'class': 'mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-500 ring-4 ring-amber-500/10 dark:bg-amber-300 dark:ring-amber-300/10',
                'aria-hidden': 'true',
              }),
              h('span', { class: 'sr-only' }, attentionLabel),
            ])
          : null,
        h('div', { class: 'min-w-0' }, [
          h('p', { class: 'truncate font-medium text-slate-900 dark:text-white' }, item.org_name),
          h('p', { class: 'truncate text-xs font-normal text-slate-500 dark:text-slate-400' }, item.management_email),
        ]),
      ])
    },
  },
  {
    label: t('plan'),
    key: 'plan_name',
    mobile: true,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => item.plan_name || t('unknown'),
  },
  {
    label: t('billing-cycle'),
    key: 'billing_type',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatBillingTypeLabel(item.billing_type),
  },
  {
    label: t('total-mau-period'),
    key: 'mau',
    mobile: true,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: OrganizationInsight) => formatNumber(item.mau),
  },
  {
    label: t('uploads-period'),
    key: 'upload_count',
    mobile: false,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: OrganizationInsight) => formatNumber(item.upload_count),
  },
  {
    label: t('builds-period'),
    key: 'build_count',
    mobile: false,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: OrganizationInsight) => formatNumber(item.build_count),
  },
  {
    label: t('fail-rate'),
    key: 'fail_rate',
    mobile: false,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: OrganizationInsight) => formatPercent(item.fail_rate),
  },
  {
    label: t('last-upload'),
    key: 'last_upload_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatDateOrNever(item.last_upload_at),
  },
  {
    label: t('distribution-stage'),
    key: 'distribution_stage',
    mobile: true,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatDistributionStage(item.distribution_stage),
  },
  {
    label: t('sso-configured'),
    key: 'has_sso',
    mobile: true,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => item.has_sso ? t('yes') : t('no'),
  },
  {
    label: t('support-channel'),
    key: 'support_channel_type',
    mobile: true,
    sortable: false,
    renderFunction: (item: OrganizationInsight) => {
      return h('div', { class: 'flex min-w-0 items-center gap-2' }, [
        h('span', { class: 'truncate text-slate-700 dark:text-slate-200' }, formatSupportChannelType(item.support_channel_type)),
        h('button', {
          type: 'button',
          class: 'd-btn d-btn-ghost d-btn-xs',
          onClick: (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            openChannelEditor(item)
          },
        }, item.support_channel_url ? t('update') : t('support-channel-set')),
      ])
    },
  },
  {
    label: t('last-build'),
    key: 'last_build_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatDateOrNever(item.last_build_at),
  },
  {
    label: t('since-paying'),
    key: 'paid_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatLocalDate(item.paid_at) || t('never'),
  },
  {
    label: t('registered-at'),
    key: 'registered_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatLocalDate(item.registered_at) || t('unknown'),
  },
  {
    label: t('members'),
    key: 'members_count',
    mobile: false,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: OrganizationInsight) => formatNumber(item.members_count),
  },
])

watch(() => adminStore.activeDateRange, () => {
  resetToFirstPageAndLoadImmediately()
  loadEnterpriseAdoption()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadOrganizationsImmediately()
  loadEnterpriseAdoption()
})

watch([selectedPlan, selectedBilling, paidOnly], () => {
  resetToFirstPageAndLoadImmediately()
})

watch(searchQuery, () => {
  scheduleSearchReload()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin organizations dashboard')
    router.push('/dashboard')
    return
  }

  await Promise.all([loadOrganizations(), loadEnterpriseAdoption()])
  displayStore.NavTitle = t('admin-organizations')
})

onBeforeUnmount(cancelDebouncedSearchReload)

displayStore.NavTitle = t('admin-organizations')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <div class="grid grid-cols-1 gap-6 mb-6">
          <ChartCard
            chart-id="enterprise-sso"
            :title="t('enterprise-sso-chart-title')"
            :is-loading="isLoadingAdoption"
            :has-data="hasAdoptionData"
            :no-data-message="t('no-data')"
          >
            <template #header>
              <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
                {{ t('enterprise-sso-chart-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('enterprise-sso-chart-description') }}
              </p>
            </template>
            <AdminMultiLineChart :series="ssoChartSeries" :is-loading="isLoadingAdoption" />
          </ChartCard>

          <ChartCard
            chart-id="enterprise-channel"
            :title="t('enterprise-channel-chart-title')"
            :is-loading="isLoadingAdoption"
            :has-data="hasAdoptionData"
            :no-data-message="t('no-data')"
          >
            <template #header>
              <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
                {{ t('enterprise-channel-chart-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('enterprise-channel-chart-description') }}
              </p>
            </template>
            <AdminMultiLineChart :series="channelChartSeries" :is-loading="isLoadingAdoption" />
          </ChartCard>

          <ChartCard
            chart-id="enterprise-adoption"
            :title="t('enterprise-adoption-chart-title')"
            :is-loading="isLoadingAdoption"
            :has-data="hasAdoptionData"
            :no-data-message="t('no-data')"
          >
            <template #header>
              <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
                {{ t('enterprise-adoption-chart-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('enterprise-adoption-chart-description') }}
              </p>
            </template>
            <AdminMultiLineChart :series="adoptionChartSeries" :is-loading="isLoadingAdoption" value-suffix="%" />
          </ChartCard>
        </div>

        <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <div class="flex flex-col gap-4 mb-5 lg:flex-row lg:items-end lg:justify-between">
            <h3 class="text-lg font-semibold">
              {{ t('organization-insights') }}
            </h3>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-w-[840px] lg:grid-cols-[minmax(180px,1fr)_minmax(140px,0.7fr)_minmax(150px,0.8fr)_auto] lg:items-center">
              <label for="admin-orgs-search" class="sr-only">{{ t('search-organizations') }}</label>
              <input
                id="admin-orgs-search"
                v-model="searchQuery"
                type="search"
                class="w-full d-input d-input-bordered d-input-sm"
                :placeholder="t('search-organizations')"
                :aria-label="t('search-organizations')"
              >

              <label for="admin-orgs-plan-filter" class="sr-only">{{ t('all-plans') }}</label>
              <select
                id="admin-orgs-plan-filter"
                v-model="selectedPlan"
                :aria-label="t('all-plans')"
                class="w-full d-select d-select-bordered d-select-sm"
              >
                <option value="">
                  {{ t('all-plans') }}
                </option>
                <option v-for="plan in planOptions" :key="plan" :value="plan">
                  {{ plan }}
                </option>
              </select>

              <label for="admin-orgs-billing-filter" class="sr-only">{{ t('all-billing-cycles') }}</label>
              <select
                id="admin-orgs-billing-filter"
                v-model="selectedBilling"
                class="w-full d-select d-select-bordered d-select-sm"
                :aria-label="t('all-billing-cycles')"
              >
                <option value="all">
                  {{ t('all-billing-cycles') }}
                </option>
                <option value="monthly">
                  {{ t('monthly') }}
                </option>
                <option value="yearly">
                  {{ t('yearly') }}
                </option>
              </select>

              <label class="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                <input
                  v-model="paidOnly"
                  type="checkbox"
                  class="d-toggle d-toggle-primary d-toggle-sm"
                >
                <span>{{ t('paid-orgs-only') }}</span>
              </label>
            </div>
          </div>

          <DataTable
            :is-loading="isLoadingOrganizations"
            :total="totalOrganizations"
            :current-page="currentPage"
            :columns="organizationColumns"
            :element-list="organizations"
            :auto-reload="false"
            @reload="loadOrganizationsImmediately"
            @reset="loadOrganizationsImmediately"
            @update:current-page="(page: number) => { currentPage = page; loadOrganizationsImmediately() }"
          />
        </div>
      </div>
    </div>

    <div
      v-if="channelEditorOpen"
      class="d-modal d-modal-open"
    >
      <div class="d-modal-box w-[calc(100vw-2rem)] max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
          {{ t('support-channel-title') }}
        </h3>
        <p v-if="channelEditorOrg" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ channelEditorOrg.org_name }}
        </p>
        <div class="mt-4 space-y-3">
          <label for="admin-support-channel-type" class="block text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ t('support-channel-type') }}
          </label>
          <select
            id="admin-support-channel-type"
            v-model="channelEditorType"
            class="w-full d-select d-select-bordered d-select-sm"
            :aria-label="t('support-channel-type')"
            :disabled="isSavingChannel"
          >
            <option value="">
              {{ t('support-channel-none') }}
            </option>
            <option value="slack">
              {{ t('support-channel-slack') }}
            </option>
            <option value="discord">
              {{ t('support-channel-discord') }}
            </option>
            <option value="teams">
              {{ t('support-channel-teams') }}
            </option>
          </select>
          <label for="admin-support-channel-url" class="block text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ t('support-channel-url') }}
          </label>
          <input
            id="admin-support-channel-url"
            v-model="channelEditorUrl"
            type="url"
            class="w-full d-input d-input-bordered d-input-sm"
            placeholder="https://"
            :aria-label="t('support-channel-url')"
            :disabled="isSavingChannel"
          >
        </div>
        <div class="d-modal-action flex-wrap gap-2">
          <button
            type="button"
            class="d-btn d-btn-ghost d-btn-sm"
            :disabled="isSavingChannel"
            @click="closeChannelEditor"
          >
            {{ t('button-cancel') }}
          </button>
          <button
            type="button"
            class="d-btn d-btn-error d-btn-outline d-btn-sm"
            :disabled="isSavingChannel || !channelEditorOrg?.support_channel_url"
            @click="saveSupportChannel(true)"
          >
            {{ t('support-channel-clear') }}
          </button>
          <button
            type="button"
            class="d-btn d-btn-primary d-btn-sm"
            :disabled="isSavingChannel"
            @click="saveSupportChannel(false)"
          >
            {{ t('support-channel-save') }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="d-modal-backdrop bg-black/50"
        :aria-label="t('cancel')"
        :disabled="isSavingChannel"
        @click="closeChannelEditor"
      />
    </div>
  </div>
</template>
