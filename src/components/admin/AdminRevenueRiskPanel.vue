<script setup lang="ts">
import type { AdminGlobalStatsTrendPoint } from '~/composables/useAdminGlobalStatsTrend'
import { useI18n } from 'vue-i18n'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { formatNumberValue } from '~/services/formatLocale'

interface ChartSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
}

defineProps<{
  isLoadingGlobalStatsTrend: boolean
  latestGlobalStats: AdminGlobalStatsTrendPoint | null
  subscriptionFlowSeries: ChartSeries[]
  pastDueOrgSeries: ChartSeries[]
  pastDueAverageDaysSeries: ChartSeries[]
  activeCanceledOrgSeries: ChartSeries[]
  activePastDueOrgSeries: ChartSeries[]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-error/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-error"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M9.172 4.172a4 4 0 015.656 0l5 5a4 4 0 010 5.656l-5 5a4 4 0 01-5.656 0l-5-5a4 4 0 010-5.656l5-5z" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('past-due-orgs') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-error">
            {{ formatNumberValue(latestGlobalStats.past_due_orgs || 0) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-error">
            0
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('stripe-subscriptions-past-due') }}
          </p>
        </div>
      </div>

      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-warning/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('avg-past-due-days') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
            {{ formatNumberValue(latestGlobalStats.past_due_orgs_average_days || 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-warning">
            0.0
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('current-average-delay') }}
          </p>
        </div>
      </div>

      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-warning/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('active-canceled-orgs') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
            {{ formatNumberValue(latestGlobalStats.active_canceled_orgs || 0) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-warning">
            0
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('active-canceled-orgs-description') }}
          </p>
        </div>
      </div>

      <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
        <div class="flex items-start justify-between mb-4">
          <div class="p-3 rounded-lg bg-error/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-error"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86l-8.5 14.74A2 2 0 003.55 22h16.9a2 2 0 001.76-3.4l-8.5-14.74a2 2 0 00-3.42 0z" /></svg>
          </div>
        </div>
        <div>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('active-past-due-orgs') }}
          </p>
          <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-error">
            {{ formatNumberValue(latestGlobalStats.active_past_due_orgs || 0) }}
          </p>
          <p v-else class="mt-2 text-3xl font-bold text-error">
            0
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('active-past-due-orgs-description') }}
          </p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ChartCard
        :title="t('subscription-flow')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="subscriptionFlowSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="subscriptionFlowSeries"
          :is-loading="isLoadingGlobalStatsTrend"
        />
      </ChartCard>

      <ChartCard
        :title="t('past-due-organizations')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="pastDueOrgSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="pastDueOrgSeries"
          :is-loading="isLoadingGlobalStatsTrend"
        />
      </ChartCard>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ChartCard
        :title="t('average-past-due-days')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="pastDueAverageDaysSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="pastDueAverageDaysSeries"
          :is-loading="isLoadingGlobalStatsTrend"
          :value-suffix="` ${t('days')}`"
        />
      </ChartCard>

      <ChartCard
        :title="t('active-canceled-organizations')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="activeCanceledOrgSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="activeCanceledOrgSeries"
          :is-loading="isLoadingGlobalStatsTrend"
        />
      </ChartCard>
    </div>

    <div class="grid grid-cols-1 gap-6">
      <ChartCard
        :title="t('active-past-due-organizations')"
        :is-loading="isLoadingGlobalStatsTrend"
        :has-data="activePastDueOrgSeries.length > 0"
      >
        <AdminMultiLineChart
          :series="activePastDueOrgSeries"
          :is-loading="isLoadingGlobalStatsTrend"
        />
      </ChartCard>
    </div>
  </div>
</template>
