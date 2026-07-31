<script setup lang="ts">
import type { Webhook } from '~/stores/webhooks'
import type { Database } from '~/types/supabase.types'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconRefresh from '~icons/heroicons/arrow-path'
import IconCheck from '~icons/heroicons/check-circle'
import IconChevronDown from '~icons/heroicons/chevron-down'
import IconChevronLeft from '~icons/heroicons/chevron-left'
import IconChevronRight from '~icons/heroicons/chevron-right'
import IconClock from '~icons/heroicons/clock'
import IconX from '~icons/heroicons/x-circle'
import IconXMark from '~icons/heroicons/x-mark'
import Spinner from '~/components/Spinner.vue'
import { formatLocalDateTimeWithSeconds } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useWebhooksStore } from '~/stores/webhooks'

const props = defineProps<{
  webhook: Webhook
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()
const webhooksStore = useWebhooksStore()
const { deliveries, deliveryPagination, isLoadingDeliveries } = storeToRefs(webhooksStore)

const currentPage = ref(0)
const statusFilter = ref<string | undefined>(undefined)
const expandedDeliveryId = ref<string | null>(null)
const retryingDeliveryId = ref<string | null>(null)
const modalTitleId = 'webhook-delivery-log-title'

const statusFilters = [
  { value: undefined, label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
]

onMounted(async () => {
  await loadDeliveries()
})

watch([currentPage, statusFilter], async () => {
  await loadDeliveries()
})

async function loadDeliveries() {
  await webhooksStore.fetchDeliveries(props.webhook.id, currentPage.value, statusFilter.value)
}

function handleClose() {
  emit('close')
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    handleClose()
  }
}

function toggleExpand(deliveryId: string) {
  expandedDeliveryId.value = expandedDeliveryId.value === deliveryId ? null : deliveryId
}

function getDeliveryDetailsId(deliveryId: string) {
  return `webhook-delivery-details-${deliveryId}`
}

async function retryDelivery(delivery: Database['public']['Tables']['webhook_deliveries']['Row']) {
  retryingDeliveryId.value = delivery.id
  const result = await webhooksStore.retryDelivery(delivery.id)
  retryingDeliveryId.value = null

  if (result.success) {
    toast.success(t('delivery-retry-queued'))
    await loadDeliveries()
  }
  else {
    toast.error(result.error || t('delivery-retry-failed'))
  }
}

function nextPage() {
  if (deliveryPagination.value?.has_more) {
    currentPage.value++
  }
}

function prevPage() {
  if (currentPage.value > 0) {
    currentPage.value--
  }
}

function formatDate(dateString: string | null): string {
  if (!dateString)
    return '-'
  return formatLocalDateTimeWithSeconds(dateString) || '-'
}

function formatDuration(ms: number | null): string {
  if (ms === null)
    return '-'
  if (ms < 1000)
    return `${formatNumberValue(ms)}ms`
  return `${formatNumberValue(ms / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}s`
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400'
    case 'failed':
      return 'text-red-600 bg-red-100 dark:bg-red-900/30 dark:text-red-400'
    case 'pending':
      return 'text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30 dark:text-yellow-400'
    default:
      return 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400'
  }
}

function formatJson(data: any): string {
  try {
    return JSON.stringify(data, null, 2)
  }
  catch {
    return String(data)
  }
}
</script>

<template>
  <dialog
    open
    class="fixed inset-0 z-50 flex items-center justify-center w-full h-full max-w-none max-h-none p-0 m-0 border-0 bg-black/50"
    :aria-labelledby="modalTitleId"
    @click="handleBackdropClick"
    @keydown.esc.stop.prevent="handleClose"
  >
    <div class="w-full max-w-4xl mx-4 overflow-hidden bg-white rounded-lg shadow-xl dark:bg-gray-800 max-h-[90dvh] flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div>
          <h3 :id="modalTitleId" class="text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('delivery-log') }}
          </h3>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            {{ webhook.name }}
          </p>
        </div>
        <button
          type="button"
          class="flex items-center justify-center text-gray-400 rounded-lg size-11 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-700 dark:hover:text-white"
          :aria-label="t('close')"
          @click="handleClose"
        >
          <IconXMark class="w-5 h-5" />
        </button>
      </div>

      <!-- Filters -->
      <div class="flex items-center gap-4 p-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div class="flex gap-2">
          <button
            v-for="filter in statusFilters"
            :key="filter.value ?? 'all'"
            class="px-3 py-1.5 text-sm font-medium rounded-lg"
            :class="[
              statusFilter === filter.value
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700',
            ]"
            :aria-pressed="statusFilter === filter.value"
            @click="statusFilter = filter.value"
          >
            {{ filter.label }}
          </button>
        </div>
        <button
          class="flex items-center gap-1 px-3 py-1.5 ml-auto text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          :disabled="isLoadingDeliveries"
          @click="loadDeliveries"
        >
          <IconRefresh class="w-4 h-4" :class="[isLoadingDeliveries ? 'animate-spin' : '']" />
          {{ t('refresh') }}
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto">
        <!-- Loading -->
        <div v-if="isLoadingDeliveries" class="flex items-center justify-center py-12">
          <Spinner size="w-8 h-8" />
        </div>

        <!-- Empty -->
        <div
          v-else-if="deliveries.length === 0"
          class="py-12 text-center"
        >
          <IconClock class="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <p class="text-gray-500 dark:text-gray-400">
            {{ t('no-deliveries') }}
          </p>
        </div>

        <!-- Deliveries List -->
        <div v-else class="divide-y divide-gray-200 dark:divide-gray-700">
          <div
            v-for="delivery in deliveries"
            :key="delivery.id"
            class="hover:bg-gray-50 dark:hover:bg-gray-700/50"
          >
            <!-- Delivery Header -->
            <div class="flex items-center gap-2 p-4">
              <button
                type="button"
                class="flex items-center flex-1 min-w-0 gap-4 text-left rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                :aria-expanded="expandedDeliveryId === delivery.id"
                :aria-controls="getDeliveryDetailsId(delivery.id)"
                @click="toggleExpand(delivery.id)"
              >
                <!-- Status Icon -->
                <div class="shrink-0">
                  <IconCheck v-if="delivery.status === 'success'" class="w-5 h-5 text-green-500" />
                  <IconX v-else-if="delivery.status === 'failed'" class="w-5 h-5 text-red-500" />
                  <IconClock v-else class="w-5 h-5 text-yellow-500" />
                </div>

                <!-- Info -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span
                      class="px-2 py-0.5 text-xs font-medium rounded"
                      :class="getStatusColor(delivery.status)"
                    >
                      {{ delivery.status }}
                    </span>
                    <span class="text-sm font-medium text-gray-900 truncate dark:text-white">
                      {{ delivery.event_type }}
                    </span>
                  </div>
                  <div class="flex items-center gap-4 mt-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>{{ formatDate(delivery.created_at) }}</span>
                    <span v-if="delivery.response_status">HTTP {{ delivery.response_status }}</span>
                    <span v-if="delivery.duration_ms">{{ formatDuration(delivery.duration_ms) }}</span>
                    <span>{{ t('attempts-count', { current: formatNumberValue(delivery.attempt_count), max: formatNumberValue(delivery.max_attempts) }) }}</span>
                  </div>
                </div>

                <IconChevronDown
                  class="w-5 h-5 text-gray-400 transition-transform shrink-0" :class="[
                    expandedDeliveryId === delivery.id ? 'rotate-180' : '',
                  ]"
                />
              </button>

              <!-- Actions -->
              <button
                v-if="delivery.status === 'failed'"
                class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-xs font-medium text-blue-600 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="retryingDeliveryId === delivery.id"
                @click="retryDelivery(delivery)"
              >
                <Spinner v-if="retryingDeliveryId === delivery.id" size="w-3 h-3" />
                <IconRefresh v-else class="w-3 h-3" />
                {{ t('retry') }}
              </button>
            </div>

            <!-- Expanded Content -->
            <div
              v-if="expandedDeliveryId === delivery.id"
              :id="getDeliveryDetailsId(delivery.id)"
              class="p-4 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50"
            >
              <!-- Request Payload -->
              <div class="mb-4">
                <h4 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('request-payload') }}
                </h4>
                <pre class="p-3 overflow-x-auto text-xs text-gray-200 bg-gray-800 rounded-lg max-h-48">{{ formatJson(delivery.request_payload) }}</pre>
              </div>

              <!-- Response -->
              <div v-if="delivery.response_body">
                <h4 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('response-body') }}
                </h4>
                <pre class="p-3 overflow-x-auto text-xs text-gray-200 bg-gray-800 rounded-lg max-h-48">{{ delivery.response_body }}</pre>
              </div>

              <!-- Metadata -->
              <div class="grid grid-cols-2 gap-4 mt-4 text-sm">
                <div>
                  <span class="text-gray-500 dark:text-gray-400">{{ t('delivery-id') }}:</span>
                  <span class="ml-2 font-mono text-xs text-gray-700 dark:text-gray-300">{{ delivery.id }}</span>
                </div>
                <div v-if="delivery.completed_at">
                  <span class="text-gray-500 dark:text-gray-400">{{ t('completed-at') }}:</span>
                  <span class="ml-2 text-gray-700 dark:text-gray-300">{{ formatDate(delivery.completed_at) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div
        v-if="deliveryPagination && deliveryPagination.total > 0"
        class="flex items-center justify-between p-4 border-t border-gray-200 dark:border-gray-700 shrink-0"
      >
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {{ t('showing-deliveries', { count: formatNumberValue(deliveries.length), total: formatNumberValue(deliveryPagination.total) }) }}
        </span>
        <div class="flex gap-2">
          <button
            class="flex items-center justify-center text-gray-600 rounded-lg size-11 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="currentPage === 0"
            :aria-label="t('previous')"
            @click="prevPage"
          >
            <IconChevronLeft class="w-5 h-5" />
          </button>
          <button
            class="flex items-center justify-center text-gray-600 rounded-lg size-11 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!deliveryPagination.has_more"
            :aria-label="t('next')"
            @click="nextPage"
          >
            <IconChevronRight class="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  </dialog>
</template>
