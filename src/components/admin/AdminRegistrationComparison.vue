<script setup lang="ts">
import type { RegistrationMonthlyComparison } from '~/services/adminRegistrationComparison'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { formatRegistrationComparisonMonth } from '~/services/adminRegistrationComparison'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'

const { t, locale } = useI18n()
const adminStore = useAdminDashboardStore()
const comparison = ref<RegistrationMonthlyComparison | null>(null)
const isLoading = ref(false)
const loadError = ref(false)
const subtitle = computed(() => comparison.value
  ? t('registration-comparison-cutoff', { day: comparison.value.cutoff_day, time: comparison.value.cutoff_time })
  : t('registration-comparison-description'))

async function loadComparison() {
  if (isLoading.value)
    return
  isLoading.value = true
  loadError.value = false
  comparison.value = null
  try {
    const result = await adminStore.fetchStats('registration_monthly_comparison', true)
    if (!result || !Array.isArray(result.months) || result.months.length !== 5 || !result.totals)
      throw new Error('Invalid registration comparison response')
    comparison.value = result
  }
  catch (error) {
    loadError.value = true
    console.error('[Admin Registration Comparison] Error loading:', error)
  }
  finally {
    isLoading.value = false
  }
}

onMounted(() => void loadComparison())
</script>

<template>
  <ChartCard
    chart-id="registration-monthly-comparison"
    :title="t('registration-comparison-title')"
    :is-loading="isLoading"
  >
    <template #header>
      <div class="min-w-0">
        <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
          {{ t('registration-comparison-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {{ subtitle }}
        </p>
      </div>
    </template>
    <div v-if="loadError" role="alert" class="flex flex-col items-center gap-4 py-8 text-center">
      <p class="text-sm text-slate-600 dark:text-slate-400">
        {{ t('registration-comparison-load-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline" @click="loadComparison">
        {{ t('retry') }}
      </button>
    </div>
    <template v-else-if="comparison">
      <div class="overflow-x-auto">
        <table class="w-full text-sm" data-test="registration-monthly-comparison">
          <caption class="sr-only">
            {{ t('registration-comparison-title') }} — {{ subtitle }}
          </caption>
          <thead class="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-700 dark:text-slate-400">
            <tr>
              <th scope="col" class="px-3 py-3 text-left">
                {{ t('registration-comparison-month') }}
              </th>
              <th scope="col" class="px-3 py-3 text-right">
                {{ t('registration-comparison-self-signup') }}
              </th>
              <th scope="col" class="px-3 py-3 text-right">
                {{ t('organization-invite') }}
              </th>
              <th scope="col" class="px-3 py-3 text-right">
                {{ t('registration-comparison-unknown-other') }}*
              </th>
              <th scope="col" class="px-3 py-3 text-right">
                {{ t('registration-comparison-total-tracked') }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-slate-700 dark:divide-slate-700 dark:text-slate-200">
            <tr v-for="month in comparison.months" :key="month.month">
              <th scope="row" class="whitespace-nowrap px-3 py-4 text-left font-medium">
                {{ formatRegistrationComparisonMonth(month.month, locale) }}
                <span v-if="month.full_month" class="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">{{ t('registration-comparison-full-month') }}</span>
              </th>
              <td class="px-3 py-4 text-right tabular-nums text-azure-500">
                {{ formatNumberValue(month.self_signup) }}
              </td>
              <td class="px-3 py-4 text-right tabular-nums text-purple-500">
                {{ formatNumberValue(month.organization_invite) }}
              </td>
              <td class="px-3 py-4 text-right text-slate-400" :aria-label="t('registration-comparison-not-tracked')">
                —
              </td>
              <td class="px-3 py-4 text-right font-semibold tabular-nums">
                {{ formatNumberValue(month.total) }}
              </td>
            </tr>
          </tbody>
          <tfoot class="border-t-2 border-slate-200 font-semibold text-slate-900 dark:border-slate-700 dark:text-white">
            <tr>
              <th scope="row" class="px-3 py-4 text-left">
                {{ t('total') }}
              </th>
              <td class="px-3 py-4 text-right tabular-nums">
                {{ formatNumberValue(comparison.totals.self_signup) }}
              </td>
              <td class="px-3 py-4 text-right tabular-nums">
                {{ formatNumberValue(comparison.totals.organization_invite) }}
              </td>
              <td class="px-3 py-4 text-right text-slate-400" :aria-label="t('registration-comparison-not-tracked')">
                —
              </td>
              <td class="px-3 py-4 text-right tabular-nums">
                {{ formatNumberValue(comparison.totals.total) }}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {{ t('registration-comparison-tracking-note') }}
      </p>
      <button type="button" class="mt-3 d-btn d-btn-sm d-btn-ghost text-slate-600 dark:text-slate-300" @click="loadComparison">
        {{ t('refresh') }}
      </button>
    </template>
  </ChartCard>
</template>
