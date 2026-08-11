<script setup lang="ts">
import type { AdminGlobalStatsTrendPoint } from '~/composables/useAdminGlobalStatsTrend'
import type { AbovePlanMetricCard, AdminChartSeries } from '~/composables/useAdminRevenueDashboard'
import { useI18n } from 'vue-i18n'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { formatNumberValue } from '~/services/formatLocale'

defineProps<{
  isLoadingGlobalStatsTrend: boolean
  latestGlobalStats: AdminGlobalStatsTrendPoint | null
  abovePlanMetricCards: AbovePlanMetricCard[]
  upgradeTrendSeries: AdminChartSeries[]
  upgradeRate12mSeries: AdminChartSeries[]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
      <div
        v-for="card in abovePlanMetricCards"
        :key="card.key"
        class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900"
      >
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg" :class="card.iconWrapClass">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current" :class="card.iconClass">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="card.iconPath" />
            </svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ card.title }}
          </p>
          <p v-if="card.value !== null" class="mt-2 text-3xl font-bold" :class="card.valueClass">
            {{ formatNumberValue(card.value) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold" :class="card.valueClass">
            {{ card.emptyDisplay }}
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ card.description }}
          </p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-success/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('upgraded-organizations') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
            {{ formatNumberValue(latestGlobalStats.upgraded_orgs || 0) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-success">
            0
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('upgraded-organizations-latest-day') }}
          </p>
        </div>
      </div>

      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-success/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('upgrade-rate-12m') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-success">
            {{ formatNumberValue(latestGlobalStats.upgrade_rate_12m || 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-success">
            {{ formatNumberValue(0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('upgrade-rate-12m-description') }}
          </p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6">
      <ChartCard
        :title="t('upgrade-rate-12m')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="upgradeRate12mSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="upgradeRate12mSeries"
          :is-loading="isLoadingGlobalStatsTrend"
          value-suffix="%"
        />
      </ChartCard>
    </div>

    <div class="grid grid-cols-1 gap-6">
      <ChartCard
        :title="t('above-plan-trend')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="upgradeTrendSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="upgradeTrendSeries"
          :is-loading="isLoadingGlobalStatsTrend"
        />
      </ChartCard>
    </div>
  </div>
</template>
