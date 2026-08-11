export interface AdminChartSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
}

export interface AbovePlanMetricCard {
  key: string
  title: string
  description: string
  value: number | null
  emptyDisplay: string
  iconWrapClass: string
  iconClass: string
  valueClass: string
  iconPath: string
}

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminGlobalStatsTrend } from '~/composables/useAdminGlobalStatsTrend'

export function useAdminRevenueDashboard(logLabel = 'Admin Dashboard Revenue') {
  const { t } = useI18n()
  const {
    globalStatsTrendData,
    isLoadingGlobalStatsTrend,
    loadGlobalStatsTrend,
    latestGlobalStats,
  } = useAdminGlobalStatsTrend(logLabel)

  const abovePlanTrendData = computed(() => globalStatsTrendData.value.filter(
    item => item.above_plan_with_credits != null && item.above_plan_without_credits != null,
  ))

  const upgradeTrendSeries = computed(() => {
    if (abovePlanTrendData.value.length === 0)
      return []

    return [
      {
        label: t('need-upgrade-trend'),
        data: abovePlanTrendData.value.map(item => ({
          date: item.date,
          value: item.need_upgrade || 0,
        })),
        color: '#7c3aed',
      },
      {
        label: t('total-above-plan'),
        data: abovePlanTrendData.value.map(item => ({
          date: item.date,
          value: (item.above_plan_with_credits ?? 0) + (item.above_plan_without_credits ?? 0),
        })),
        color: '#0ea5e9',
      },
      {
        label: t('above-plan-with-credits'),
        data: abovePlanTrendData.value.map(item => ({
          date: item.date,
          value: item.above_plan_with_credits ?? 0,
        })),
        color: '#f59e0b',
      },
      {
        label: t('above-plan-without-credits'),
        data: abovePlanTrendData.value.map(item => ({
          date: item.date,
          value: item.above_plan_without_credits ?? 0,
        })),
        color: '#ef4444',
      },
      {
        label: t('upgraded-organizations'),
        data: abovePlanTrendData.value.map(item => ({
          date: item.date,
          value: item.upgraded_orgs || 0,
        })),
        color: '#10b981',
      },
    ]
  })

  const upgradeRate12mSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('upgrade-rate-12m'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.upgrade_rate_12m || 0,
        })),
        color: '#10b981',
      },
    ]
  })

  const totalAbovePlan = computed(() => {
    const stats = latestGlobalStats.value
    if (!stats || stats.above_plan_with_credits == null || stats.above_plan_without_credits == null)
      return null
    return stats.above_plan_with_credits + stats.above_plan_without_credits
  })

  const abovePlanMetricCards = computed(() => {
    const stats = latestGlobalStats.value
    return [
      {
        key: 'need-upgrade',
        title: t('need-upgrade'),
        description: t('need-upgrade-description'),
        value: stats ? (stats.need_upgrade || 0) : 0,
        emptyDisplay: '0',
        iconWrapClass: 'bg-error/10',
        iconClass: 'text-error',
        valueClass: 'text-error',
        iconPath: 'M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z',
      },
      {
        key: 'total-above-plan',
        title: t('total-above-plan'),
        description: t('total-above-plan-description'),
        value: totalAbovePlan.value,
        emptyDisplay: '—',
        iconWrapClass: 'bg-info/10',
        iconClass: 'text-info',
        valueClass: 'text-info',
        iconPath: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
      },
      {
        key: 'above-plan-with-credits',
        title: t('above-plan-with-credits'),
        description: t('above-plan-with-credits-description'),
        value: stats?.above_plan_with_credits ?? null,
        emptyDisplay: '—',
        iconWrapClass: 'bg-warning/10',
        iconClass: 'text-warning',
        valueClass: 'text-warning',
        iconPath: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V7m0 9v1m0-13a9 9 0 110 18 9 9 0 010-18z',
      },
      {
        key: 'above-plan-without-credits',
        title: t('above-plan-without-credits'),
        description: t('above-plan-without-credits-description'),
        value: stats?.above_plan_without_credits ?? null,
        emptyDisplay: '—',
        iconWrapClass: 'bg-error/10',
        iconClass: 'text-error',
        valueClass: 'text-error',
        iconPath: 'M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z',
      },
    ]
  })

  const subscriptionFlowSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('new-subscriptions'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.new_paying_orgs || 0,
        })),
        color: '#10b981',
      },
      {
        label: t('cancellations'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.canceled_orgs || 0,
        })),
        color: '#ef4444',
      },
    ]
  })

  const pastDueOrgSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('past-due-organizations'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.past_due_orgs || 0,
        })),
        color: '#ef4444',
      },
    ]
  })

  const pastDueAverageDaysSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('average-past-due-days'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.past_due_orgs_average_days || 0,
        })),
        color: '#f59e0b',
      },
    ]
  })

  const activeCanceledOrgSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('active-canceled-organizations'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.active_canceled_orgs || 0,
        })),
        color: '#f97316',
      },
    ]
  })

  const activePastDueOrgSeries = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return []

    return [
      {
        label: t('active-past-due-organizations'),
        data: globalStatsTrendData.value.map(item => ({
          date: item.date,
          value: item.active_past_due_orgs || 0,
        })),
        color: '#dc2626',
      },
    ]
  })

  return {
    globalStatsTrendData,
    isLoadingGlobalStatsTrend,
    loadGlobalStatsTrend,
    latestGlobalStats,
    abovePlanTrendData,
    upgradeTrendSeries,
    upgradeRate12mSeries,
    totalAbovePlan,
    abovePlanMetricCards,
    subscriptionFlowSeries,
    pastDueOrgSeries,
    pastDueAverageDaysSeries,
    activeCanceledOrgSeries,
    activePastDueOrgSeries,
  }
}
