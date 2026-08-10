<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatLocalDate, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

type BillingType = 'monthly' | 'yearly'

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
const isLoading = ref(true)

const PAGE_SIZE = 100
const organizations = ref<OrganizationInsight[]>([])
const isLoadingOrganizations = ref(false)
let loadOrganizationsSequence = 0

function formatNumber(value: number) {
  return formatNumberValue(value)
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

function isInactiveOrganization(item: OrganizationInsight) {
  return Number(item.mau || 0) === 0 || Number(item.upload_count || 0) === 0
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
      offset: 0,
      paid_only: true,
    }

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

    const allOrgs = payload.data.organizations || []
    organizations.value = allOrgs.filter(isInactiveOrganization)
  }
  catch (error) {
    if (sequence !== loadOrganizationsSequence)
      return

    console.error('[Admin Dashboard Retention Inactive] Error loading organization insights:', error)
    organizations.value = []
  }
  finally {
    if (sequence === loadOrganizationsSequence)
      isLoadingOrganizations.value = false
  }
}

const inactiveOrganizationsTotal = computed(() => organizations.value.length)

const organizationColumns = computed<TableColumn[]>(() => [
  {
    label: t('org-name'),
    key: 'org_name',
    mobile: true,
    head: true,
    sortable: false,
    renderFunction: (item: OrganizationInsight) => {
      return h('div', { class: 'min-w-0' }, [
        h('p', { class: 'truncate font-medium text-slate-900 dark:text-white' }, item.org_name),
        h('p', { class: 'truncate text-xs font-normal text-slate-500 dark:text-slate-400' }, item.management_email),
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
    label: t('last-upload'),
    key: 'last_upload_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: OrganizationInsight) => formatDateOrNever(item.last_upload_at),
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
  loadOrganizations()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadOrganizations()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin retention inactive dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadOrganizations()
  isLoading.value = false

  displayStore.NavTitle = t('admin-retention-inactive')
})

displayStore.NavTitle = t('admin-retention-inactive')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <div class="flex flex-col gap-1 mb-5">
              <h3 class="text-lg font-semibold">
                {{ t('admin-retention-inactive') }}
              </h3>
              <p class="text-sm text-slate-600 dark:text-slate-400">
                {{ t('admin-retention-inactive-description') }}
              </p>
            </div>

            <DataTable
              :is-loading="isLoadingOrganizations"
              :total="inactiveOrganizationsTotal"
              :current-page="1"
              :columns="organizationColumns"
              :element-list="organizations"
              :auto-reload="false"
              @reload="loadOrganizations"
              @reset="loadOrganizations"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
