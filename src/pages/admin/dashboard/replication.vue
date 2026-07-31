<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import BeakerIcon from '~icons/heroicons/beaker'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { showUploadReplicationToast } from '~/services/updateReplicationToast'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface ReplicationSlotLag {
  slot_name: string
  active: boolean
  confirmed_flush_lsn: string | null
  restart_lsn: string | null
  lag_bytes: number | null
  slot_lag: string | null
  lag_seconds: number | null
  lag_seconds_est: number | null
  effective_lag_seconds: number | null
  lag_minutes: number | null
  status: 'ok' | 'ko'
  reasons: string[]
}

interface ReplicationStatusResponse {
  status: 'ok' | 'ko'
  threshold_seconds: number
  threshold_minutes: number
  checked_at: string
  slot_count: number
  active_count: number
  inactive_count: number
  max_lag_seconds: number | null
  max_lag_minutes?: number | null
  max_lag_slot: string | null
  slots: ReplicationSlotLag[]
  error?: string
  message?: string
  error_message?: string
  error_detail?: string
  error_hint?: string
  error_code?: string
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const router = useRouter()

const isLoading = ref(false)
const errorMessage = ref<string | null>(null)
const data = ref<ReplicationStatusResponse | null>(null)

const statusLabel = computed(() => {
  const status = data.value?.status
  if (!status)
    return '-'
  return status.toUpperCase()
})

const statusColor = computed(() => {
  if (!data.value)
    return 'text-slate-500'
  return data.value.status === 'ok' ? 'text-emerald-500' : 'text-rose-500'
})

const slots = computed(() => data.value?.slots ?? [])

const slotCount = computed(() => data.value?.slot_count ?? 0)

const activeCount = computed(() => data.value?.active_count ?? 0)

const thresholdMinutes = computed(() => data.value?.threshold_minutes ?? 3)

const maxLagSlot = computed(() => data.value?.max_lag_slot ?? '-')

const maxLagMinutes = computed(() => {
  if (!data.value)
    return undefined
  if (data.value.max_lag_minutes !== undefined && data.value.max_lag_minutes !== null)
    return data.value.max_lag_minutes
  if (data.value.max_lag_seconds === null || data.value.max_lag_seconds === undefined)
    return undefined
  return Math.round((data.value.max_lag_seconds / 60) * 100) / 100
})

const checkedAt = computed(() => {
  if (!data.value?.checked_at)
    return '-'
  return formatLocalDateTime(data.value.checked_at)
})

async function loadReplicationStatus() {
  isLoading.value = true
  errorMessage.value = null

  try {
    const headers: Record<string, string> = {}
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.access_token)
      throw new Error('No active session available')

    headers.Authorization = `Bearer ${session.access_token}`

    const response = await fetch(`${defaultApiHost}/replication`, {
      method: 'GET',
      headers,
    })

    const payload = await response.json().catch(() => null) as ReplicationStatusResponse | null

    if (!payload)
      throw new Error('Invalid replication status response')

    data.value = payload

    if (!response.ok && payload.error) {
      const details = [payload.error_message, payload.error_detail, payload.error_hint]
        .filter(Boolean)
        .join(' - ')
      errorMessage.value = details || payload.message || `API error: ${response.status}`
    }
  }
  catch (error) {
    console.error('[Admin Dashboard Replication] Error loading replication status:', error)
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load replication status'
  }
  finally {
    isLoading.value = false
  }
}

function triggerFakeReplicationToast() {
  showUploadReplicationToast({
    eventLabel: 'Upload was uploaded',
    route: '/admin/dashboard/replication',
    actionLabel: t('view'),
    onAction: () => router.push('/admin/dashboard/replication'),
  })
}

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin replication dashboard')
    router.push('/dashboard')
    return
  }

  await loadReplicationStatus()
  displayStore.NavTitle = t('replication')
})

displayStore.NavTitle = t('replication')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col gap-4 mb-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 class="text-2xl font-semibold text-slate-700 dark:text-white">
              {{ t('replication') }}
            </h1>
            <p class="text-sm text-slate-500 dark:text-slate-300">
              Logical replication slot lag monitoring
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class="d-btn d-btn-primary d-btn-sm"
              type="button"
              @click="triggerFakeReplicationToast"
            >
              <BeakerIcon class="h-4 w-4" aria-hidden="true" />
              {{ t('admin-debug') }}
            </button>
            <button
              class="d-btn d-btn-outline d-btn-sm"
              type="button"
              :disabled="isLoading"
              @click="loadReplicationStatus"
            >
              {{ isLoading ? 'Refreshing...' : 'Refresh' }}
            </button>
          </div>
        </div>

        <div v-if="errorMessage && !data" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
          {{ errorMessage }}
        </div>

        <PageLoader v-else-if="isLoading && !data" />

        <div v-else-if="data" class="space-y-6">
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatsCard
              title="Status"
              :value="statusLabel"
              :color-class="statusColor"
              :subtitle="`Threshold ${formatNumberValue(thresholdMinutes)} min`"
            />
            <AdminStatsCard
              title="Max lag"
              :value="maxLagMinutes"
              :unit="maxLagMinutes === null ? '' : 'min'"
              :subtitle="maxLagSlot"
            />
            <AdminStatsCard
              title="Active slots"
              :value="activeCount"
              :subtitle="`Total ${formatNumberValue(slotCount)}`"
            />
            <AdminStatsCard
              title="Last check"
              :value="checkedAt"
            />
          </div>

          <div class="rounded-lg border border-slate-300 bg-white shadow-lg dark:border-slate-900 dark:bg-gray-800">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-6 py-4 dark:border-slate-700">
              <div>
                <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
                  Replication slots
                </h2>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  Checked at {{ checkedAt }}
                </p>
              </div>
              <div v-if="errorMessage" class="text-xs text-amber-600 dark:text-amber-400">
                {{ errorMessage }}
              </div>
            </div>

            <div v-if="slots.length === 0" class="px-6 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              No logical replication slots found.
            </div>

            <div v-else class="-mx-4 overflow-x-auto sm:mx-0">
              <table class="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
                <thead class="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th scope="col" class="px-4 py-3">
                      Slot
                    </th>
                    <th scope="col" class="px-4 py-3">
                      Active
                    </th>
                    <th scope="col" class="px-4 py-3">
                      Lag
                    </th>
                    <th scope="col" class="px-4 py-3">
                      Lag (min)
                    </th>
                    <th scope="col" class="px-4 py-3">
                      Status
                    </th>
                    <th scope="col" class="px-4 py-3">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
                  <tr
                    v-for="slot in slots"
                    :key="slot.slot_name"
                    class="transition hover:bg-slate-50 dark:hover:bg-slate-700/60"
                  >
                    <td class="whitespace-nowrap px-4 py-3 font-semibold text-gray-900 dark:text-white">
                      {{ slot.slot_name }}
                    </td>
                    <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                      <span
                        class="inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold"
                        :class="slot.active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200'"
                      >
                        {{ slot.active ? 'Active' : 'Inactive' }}
                      </span>
                    </td>
                    <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                      {{ slot.slot_lag ?? '-' }}
                    </td>
                    <td class="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-200">
                      {{ slot.lag_minutes === null || slot.lag_minutes === undefined ? '-' : formatNumberValue(slot.lag_minutes, { maximumFractionDigits: 2 }) }}
                    </td>
                    <td class="whitespace-nowrap px-4 py-3">
                      <span
                        class="badge"
                        :class="slot.status === 'ok' ? 'badge-success' : 'badge-error'"
                      >
                        {{ slot.status.toUpperCase() }}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {{ slot.reasons.length ? slot.reasons.join(', ') : '-' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
