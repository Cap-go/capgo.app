<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ArrowPathIconSolid from '~icons/heroicons/arrow-path-solid'
import BanknotesIcon from '~icons/heroicons/banknotes'
import CalendarDaysIcon from '~icons/heroicons/calendar-days'
import ChartBarIcon from '~icons/heroicons/chart-bar'

const props = defineProps({
  useBillingPeriod: { type: Boolean, default: false },
  showCumulative: { type: Boolean, default: false },
  isRefreshing: { type: Boolean, default: false },
})

const emit = defineEmits<{
  'update:useBillingPeriod': [value: boolean]
  'update:showCumulative': [value: boolean]
  'reload': []
}>()

const { t } = useI18n()

function setDaily() {
  emit('update:showCumulative', false)
}

// Cumulative only makes sense over the billing period, so enable both together.
function setCumulative() {
  emit('update:useBillingPeriod', true)
  emit('update:showCumulative', true)
}

function setBillingPeriod() {
  emit('update:useBillingPeriod', true)
}

function setLast30Days() {
  emit('update:useBillingPeriod', false)
  // Cumulative is billing-period-only, so disable it when leaving billing period.
  emit('update:showCumulative', false)
}
</script>

<template>
  <div class="flex items-center justify-end gap-2 flex-nowrap sm:gap-4">
    <!-- Daily vs Cumulative -->
    <div class="flex items-center p-1 space-x-1 bg-gray-200 rounded-lg dark:bg-gray-800">
      <button
        type="button"
        class="flex gap-0.5 justify-center items-center h-9 min-h-9 py-1 px-2 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors cursor-pointer sm:gap-1.5 sm:px-3"
        :class="[!props.showCumulative || !props.useBillingPeriod ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
        :aria-label="t('daily')"
        @click="setDaily"
      >
        <CalendarDaysIcon class="w-4 h-4" />
        <span class="hidden sm:inline">{{ t('daily') }}</span>
      </button>
      <button
        type="button"
        class="flex gap-0.5 justify-center items-center h-9 min-h-9 py-1 px-2 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors cursor-pointer sm:gap-1.5 sm:px-3"
        :class="[props.showCumulative && props.useBillingPeriod ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
        :aria-label="t('cumulative')"
        @click="setCumulative"
      >
        <ChartBarIcon class="w-4 h-4" />
        <span class="hidden sm:inline">{{ t('cumulative') }}</span>
      </button>
    </div>

    <!-- Billing Period vs Last 30 Days -->
    <div class="flex items-center p-1 space-x-1 bg-gray-200 rounded-lg dark:bg-gray-800">
      <button
        type="button"
        class="flex gap-0.5 justify-center items-center h-9 min-h-9 py-1 px-2 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors cursor-pointer sm:gap-1.5 sm:px-3"
        :class="[props.useBillingPeriod ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
        :aria-label="t('billing-period')"
        @click="setBillingPeriod"
      >
        <BanknotesIcon class="w-4 h-4" />
        <span class="hidden sm:inline">{{ t('billing-period') }}</span>
      </button>
      <button
        type="button"
        class="flex gap-0.5 justify-center items-center h-9 min-h-9 py-1 px-2 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors cursor-pointer sm:gap-1.5 sm:px-3"
        :class="[!props.useBillingPeriod ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
        :aria-label="t('last-30-days')"
        @click="setLast30Days"
      >
        <CalendarDaysIcon class="w-4 h-4" />
        <span class="hidden sm:inline">{{ t('last-30-days') }}</span>
      </button>
    </div>

    <!-- Reload -->
    <button
      type="button"
      class="flex items-center justify-center w-8 h-8 text-gray-700 transition-colors bg-white rounded-md shadow-sm cursor-pointer sm:w-9 sm:h-9 dark:text-gray-200 dark:bg-gray-700 hover:text-gray-900 hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:hover:bg-gray-600 dark:hover:text-white dark:focus:ring-blue-400"
      :aria-label="t('reload')"
      :class="{ 'opacity-60 cursor-not-allowed': props.isRefreshing }"
      :disabled="props.isRefreshing"
      @click="emit('reload')"
    >
      <ArrowPathIconSolid class="w-4 h-4" :class="{ 'animate-spin': props.isRefreshing }" />
    </button>
  </div>
</template>
