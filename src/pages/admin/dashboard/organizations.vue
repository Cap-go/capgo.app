<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import { formatLocalDate, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

type BillingType = 'monthly' | 'yearly'
type BillingFilter = BillingType | 'all'

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
}

interface OrganizationInsightsResponse {
  success: boolean
  data: {
    organizations: OrganizationInsight[]
    total: number
    plan_options: string[]
  }
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
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadOrganizationsImmediately()
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

  await loadOrganizations()
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
  </div>
</template>
