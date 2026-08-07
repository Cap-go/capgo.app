import { useDark } from '@vueuse/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getTodayLimit } from '~/services/buildCharts'
import { createLegendConfig, createStackedChartScales } from '~/services/chartConfig'
import { createTooltipConfig } from '~/services/chartTooltip'
import { generateMonthDays, normalizeToUtcStartOfDay } from '~/services/date'
import { useOrganizationStore } from '~/stores/organization'

interface BuildChartConfigProps {
  appId: string
  useBillingPeriod: boolean
  accumulated: boolean
}

// Shared chart scaffolding for the build charts: the org-scoped billing cycle
// (reactive to appId), the day labels, the today-line marker, and the Chart.js
// options. Keeps BuildStatsChart and BuildTimeChart free of duplicated config.
export function useBuildChartConfig(props: BuildChartConfigProps, options: { stacked: boolean, hasLegend: boolean }) {
  const isDark = useDark()
  const { t } = useI18n()
  const organizationStore = useOrganizationStore()

  function resolveCycle(field: 'subscription_start' | 'subscription_end') {
    const org = organizationStore.getOrgByAppId(props.appId) ?? organizationStore.currentOrganization
    return normalizeToUtcStartOfDay(new Date(org?.[field] ?? new Date()))
  }
  const cycleStart = computed(() => resolveCycle('subscription_start'))
  const cycleEnd = computed(() => resolveCycle('subscription_end'))

  function monthdays() {
    return generateMonthDays(props.useBillingPeriod, cycleStart.value, cycleEnd.value)
  }
  function todayLimit(labelCount: number) {
    return getTodayLimit(labelCount, props.useBillingPeriod, cycleStart.value, cycleEnd.value)
  }

  const todayLineOptions = computed(() => {
    if (!props.useBillingPeriod)
      return { enabled: false }
    const labels = monthdays()
    const index = todayLimit(labels.length)
    if (index < 0 || index >= labels.length)
      return { enabled: false }
    return {
      enabled: true,
      xIndex: index,
      label: t('today'),
      color: isDark.value ? 'rgba(165, 180, 252, 0.75)' : 'rgba(99, 102, 241, 0.7)',
      glowColor: isDark.value ? 'rgba(129, 140, 248, 0.35)' : 'rgba(165, 180, 252, 0.35)',
      badgeFill: isDark.value ? 'rgba(67, 56, 202, 0.45)' : 'rgba(199, 210, 254, 0.85)',
      textColor: isDark.value ? '#e0e7ff' : '#312e81',
    }
  })

  const chartOptions = computed(() => ({
    maintainAspectRatio: false,
    scales: createStackedChartScales(isDark.value, options.stacked),
    plugins: {
      legend: createLegendConfig(isDark.value, options.hasLegend),
      title: { display: false },
      tooltip: createTooltipConfig(options.hasLegend, props.accumulated, props.useBillingPeriod ? cycleStart.value : false, undefined),
      todayLine: todayLineOptions.value,
    },
  }))

  return { monthdays, todayLimit, chartOptions }
}
