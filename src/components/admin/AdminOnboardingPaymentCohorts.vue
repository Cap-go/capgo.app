<script setup lang="ts">
import type { OnboardingPaymentCohortReport, OnboardingPaymentCohortRow } from '~/services/adminOnboardingPaymentCohorts'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createOnboardingPaymentCohortLoader,
  formatOnboardingPaymentCohortMonth,
  formatOnboardingPaymentCohortTimestamp,
} from '~/services/adminOnboardingPaymentCohorts'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const adminStore = useAdminDashboardStore()
const mainStore = useMainStore()
const report = ref<OnboardingPaymentCohortReport | null>(null)
const loading = ref(false)
const error = ref(false)
const authIdentity = computed(() => mainStore.isAdmin && mainStore.user?.id
  ? `${mainStore.user.id}:${mainStore.authGeneration}`
  : null)
const windows = ['days_3', 'days_7', 'days_14', 'ever'] as const satisfies readonly (keyof OnboardingPaymentCohortRow)[]
const windowLabels = {
  days_3: 'onboarding-payment-cohorts-3-days',
  days_7: 'onboarding-payment-cohorts-7-days',
  days_14: 'onboarding-payment-cohorts-14-days',
  ever: 'onboarding-payment-cohorts-ever',
}
const appendWarning = computed(() => /append|incremental/i.test(report.value?.invoice_sync_type ?? ''))
const loader = createOnboardingPaymentCohortLoader(
  forceRefresh => adminStore.fetchStats('onboarding_payment_cohorts', forceRefresh),
  {
    onReport: value => report.value = value,
    onLoading: value => loading.value = value,
    onError: value => error.value = value !== null,
  },
  () => authIdentity.value,
)

watch(() => adminStore.refreshTrigger, () => {
  void loader.load()
})
watch(authIdentity, () => {
  loader.invalidate()
  void loader.load()
}, { flush: 'sync' })
onMounted(() => {
  void loader.load()
})
onUnmounted(loader.dispose)
</script>

<template>
  <section
    v-if="authIdentity !== null"
    class="w-full p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900"
    :aria-busy="loading"
  >
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
          {{ t('onboarding-payment-cohorts-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {{ t('onboarding-payment-cohorts-scope') }}
        </p>
      </div>
      <button
        type="button"
        class="d-btn d-btn-outline d-btn-sm"
        :disabled="loading"
        data-test="payment-cohorts-refresh"
        @click="loader.load(true)"
      >
        {{ t('onboarding-payment-cohorts-refresh') }}
      </button>
    </div>

    <div v-if="loading" role="status" class="flex items-center gap-2 py-8 text-sm text-slate-600 dark:text-slate-400">
      <span class="d-loading d-loading-spinner d-loading-sm" aria-hidden="true" />
      {{ t('onboarding-payment-cohorts-loading') }}
    </div>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-3 py-6 text-sm text-red-700 dark:text-red-300">
      <p>{{ t('onboarding-payment-cohorts-error') }}</p>
      <button type="button" class="d-btn d-btn-outline d-btn-sm" data-test="payment-cohorts-retry" @click="loader.load(true)">
        {{ t('onboarding-payment-cohorts-retry') }}
      </button>
    </div>
    <template v-else-if="report">
      <div class="w-full overflow-x-auto" data-test="payment-cohorts-overflow">
        <table class="w-full min-w-[900px] d-table text-sm tabular-nums">
          <caption class="sr-only">
            {{ t('onboarding-payment-cohorts-title') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('onboarding-payment-cohorts-month') }}
              </th>
              <th scope="col" class="text-right">
                {{ t('onboarding-payment-cohorts-signups') }}
              </th>
              <th scope="col" class="text-right">
                {{ t('onboarding-payment-cohorts-no-public-row') }}
              </th>
              <th scope="col" class="text-right">
                {{ t('onboarding-payment-cohorts-invites') }}
              </th>
              <th v-for="window in windows" :key="window" scope="col" class="text-right">
                {{ t(windowLabels[window]) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.rows" :key="row.month">
              <th scope="row" class="whitespace-nowrap">
                {{ formatOnboardingPaymentCohortMonth(row.month) }}
              </th>
              <td class="text-right">
                {{ formatNumberValue(row.signups) }}
              </td>
              <td class="text-right">
                {{ formatNumberValue(row.excluded_no_public_row) }}
              </td>
              <td class="text-right">
                {{ formatNumberValue(row.excluded_invite) }}
              </td>
              <td v-for="window in windows" :key="window" class="text-right whitespace-nowrap">
                <div>{{ formatNumberValue(row[window].paid) }} / {{ formatNumberValue(row[window].eligible) }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">
                  <template v-if="row[window].conversion_percent !== null">
                    {{ formatNumberValue(row[window].conversion_percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
                  </template>
                  <template v-else>
                    {{ t('onboarding-payment-cohorts-unavailable') }}
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="mt-4 space-y-1 text-xs text-slate-600 dark:text-slate-400">
        <p>{{ t('onboarding-payment-cohorts-cutoff', { cutoff: formatOnboardingPaymentCohortTimestamp(report.cutoff) }) }}</p>
        <p>{{ t('onboarding-payment-cohorts-last-sync', { synced: report.invoice_last_synced_at ? formatOnboardingPaymentCohortTimestamp(report.invoice_last_synced_at) : t('onboarding-payment-cohorts-unavailable') }) }}</p>
        <p v-if="report.invoice_sync_type">
          {{ t('onboarding-payment-cohorts-sync-mode', { mode: report.invoice_sync_type }) }}
        </p>
        <p>{{ t('onboarding-payment-cohorts-fallbacks', { count: formatNumberValue(report.credit_timestamp_fallbacks) }) }}</p>
      </div>
      <p v-if="appendWarning" class="p-3 mt-3 text-sm text-amber-800 border border-amber-200 rounded-lg bg-amber-50 dark:text-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30">
        {{ t('onboarding-payment-cohorts-append-warning') }}
      </p>
    </template>

    <div class="pt-4 mt-4 space-y-2 text-xs leading-relaxed border-t border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400">
      <p>{{ t('onboarding-payment-cohorts-cell-note') }}</p>
      <p>{{ t('onboarding-payment-cohorts-window-note') }}</p>
      <p>{{ t('onboarding-payment-cohorts-ever-note') }}</p>
      <p>{{ t('onboarding-payment-cohorts-snapshot-note') }}</p>
      <details>
        <summary class="font-semibold cursor-pointer text-slate-800 dark:text-slate-200">
          {{ t('onboarding-payment-cohorts-methodology') }}
        </summary>
        <div class="mt-2 space-y-2">
          <p>{{ t('onboarding-payment-cohorts-signup-note') }}</p>
          <p>{{ t('onboarding-payment-cohorts-source-note') }}</p>
          <p>{{ t('onboarding-payment-cohorts-credit-note') }}</p>
        </div>
      </details>
    </div>
  </section>
</template>
