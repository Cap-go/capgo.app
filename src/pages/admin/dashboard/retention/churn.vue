<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatLocalDate } from '~/services/date'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

interface CancelledOrganization {
  org_id: string
  org_name: string
  management_email: string
  canceled_at: string
  plan_name: string | null
  billing_type: 'monthly' | 'yearly' | null
  subscription_or_signup_date: string
  cancellation_reason: string | null
}

interface CancelledOrganizationsResponse {
  success: boolean
  data: {
    organizations: CancelledOrganization[]
    total: number
  }
}

const cancelledOrganizations = ref<CancelledOrganization[]>([])
const cancelledOrganizationsTotal = ref(0)
const cancelledOrganizationsCurrentPage = ref(1)
const isLoadingCancelledOrganizations = ref(false)
const CANCELLED_PAGE_SIZE = 20
let loadCancelledOrganizationsSequence = 0

function formatBillingTypeLabel(billingType: CancelledOrganization['billing_type']) {
  if (billingType === 'yearly')
    return t('yearly')
  if (billingType === 'monthly')
    return t('monthly')
  return t('unknown')
}

const cancelledOrganizationsColumns = computed<TableColumn[]>(() => [
  { label: t('org-name'), key: 'org_name', mobile: true, head: true, sortable: false },
  { label: t('email'), key: 'management_email', mobile: false, sortable: false },
  {
    label: t('cancellation-date'),
    key: 'canceled_at',
    mobile: true,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => {
      if (!item.canceled_at)
        return t('unknown')
      return formatLocalDate(item.canceled_at)
    },
  },
  {
    label: t('plan'),
    key: 'plan_name',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => item.plan_name || t('unknown'),
  },
  {
    label: t('billing-cycle'),
    key: 'billing_type',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => formatBillingTypeLabel(item.billing_type),
  },
  {
    label: t('subscription-or-signup-date'),
    key: 'subscription_or_signup_date',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => formatLocalDate(item.subscription_or_signup_date) || t('unknown'),
  },
  {
    label: t('cancellation-reason'),
    key: 'cancellation_reason',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => item.cancellation_reason || t('unknown'),
  },
])

async function loadCancelledOrganizations() {
  const sequence = ++loadCancelledOrganizationsSequence
  isLoadingCancelledOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const offset = (cancelledOrganizationsCurrentPage.value - 1) * CANCELLED_PAGE_SIZE

    const { start, end } = adminStore.activeDateRange
    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        metric_category: 'cancelled_users',
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        limit: CANCELLED_PAGE_SIZE,
        offset,
      }),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const data = await response.json() as CancelledOrganizationsResponse
    if (!data.success)
      throw new Error('Failed to fetch cancelled organizations')

    if (sequence !== loadCancelledOrganizationsSequence)
      return

    cancelledOrganizations.value = data.data.organizations || []
    cancelledOrganizationsTotal.value = data.data.total || 0
  }
  catch (error) {
    if (sequence !== loadCancelledOrganizationsSequence)
      return

    console.error('[Admin Dashboard Retention Churn] Error loading cancelled organizations:', error)
    cancelledOrganizations.value = []
    cancelledOrganizationsTotal.value = 0
  }
  finally {
    if (sequence === loadCancelledOrganizationsSequence)
      isLoadingCancelledOrganizations.value = false
  }
}

watch(
  () => [
    adminStore.dateRangeMode,
    adminStore.customDateRange.start.getTime(),
    adminStore.customDateRange.end.getTime(),
  ] as const,
  () => {
    if (!mainStore.isAdmin)
      return
    cancelledOrganizationsCurrentPage.value = 1
    void loadCancelledOrganizations()
  },
)

watch(() => adminStore.refreshTrigger, () => {
  if (!mainStore.isAdmin)
    return
  void loadCancelledOrganizations()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadCancelledOrganizations()
  isLoading.value = false

  displayStore.NavTitle = t('admin-retention-churn')
})

displayStore.NavTitle = t('admin-retention-churn')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- Cancelled Organizations Table -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('cancelled-organizations-list') }}
            </h3>
            <DataTable
              :is-loading="isLoadingCancelledOrganizations"
              :total="cancelledOrganizationsTotal"
              :current-page="cancelledOrganizationsCurrentPage"
              :offset="CANCELLED_PAGE_SIZE"
              :columns="cancelledOrganizationsColumns"
              :element-list="cancelledOrganizations"
              :auto-reload="false"
              @reload="loadCancelledOrganizations"
              @reset="loadCancelledOrganizations"
              @update:current-page="(page: number) => { cancelledOrganizationsCurrentPage = page; loadCancelledOrganizations() }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
