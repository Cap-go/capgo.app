<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import type { OrganizationInsight, OrganizationInsightsResponse } from '~/services/adminOrganizationInsights'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import PageLoader from '~/components/PageLoader.vue'
import { createSharedOrganizationInsightColumns } from '~/services/adminOrganizationInsightColumns'
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

const PAGE_SIZE = 100
const SAFETY_MAX_PAGES = 200
const organizations = ref<OrganizationInsight[]>([])
const isLoadingOrganizations = ref(false)
const loadTruncated = ref(false)
let loadOrganizationsSequence = 0

function isInactiveOrganization(item: OrganizationInsight) {
  return Number(item.mau || 0) === 0 || Number(item.upload_count || 0) === 0
}

async function loadOrganizations() {
  const sequence = ++loadOrganizationsSequence
  loadTruncated.value = false
  isLoadingOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const { start, end } = adminStore.activeDateRange
    const allOrgs: OrganizationInsight[] = []
    let hitSafetyMax = false

    for (let page = 0; ; page++) {
      if (sequence !== loadOrganizationsSequence)
        return

      if (page >= SAFETY_MAX_PAGES) {
        hitSafetyMax = true
        break
      }

      const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          metric_category: 'organization_insights',
          start_date: start.toISOString(),
          end_date: end.toISOString(),
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          paid_only: true,
        }),
      })

      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}))
        throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
      }

      const payload = await response.json() as OrganizationInsightsResponse
      if (!payload.success)
        throw new Error('Failed to fetch organization insights')

      const pageOrgs = payload.data.organizations || []
      allOrgs.push(...pageOrgs)

      if (pageOrgs.length === 0 || pageOrgs.length < PAGE_SIZE || allOrgs.length >= (payload.data.total || 0))
        break
    }

    if (sequence !== loadOrganizationsSequence)
      return

    loadTruncated.value = hitSafetyMax
    organizations.value = allOrgs.filter(isInactiveOrganization)
  }
  catch (error) {
    if (sequence !== loadOrganizationsSequence)
      return

    console.error('[Admin Dashboard Retention Inactive] Error loading organization insights:', error)
    organizations.value = []
    loadTruncated.value = false
  }
  finally {
    if (sequence === loadOrganizationsSequence)
      isLoadingOrganizations.value = false
  }
}

const inactiveOrganizationsTotal = computed(() => organizations.value.length)

const organizationColumns = computed<TableColumn[]>(() => createSharedOrganizationInsightColumns(t))

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (!mainStore.isAdmin)
      return
    void loadOrganizations()
  },
  { deep: true },
)

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
              <p
                v-if="loadTruncated"
                class="text-sm text-amber-600 dark:text-amber-400"
              >
                {{ t('admin-retention-inactive-truncated') }}
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
