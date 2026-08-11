import type { GlobalStatsTrendPoint } from '~/services/adminStatsTypes'

export type { GlobalStatsTrendPoint as AdminGlobalStatsTrendPoint } from '~/services/adminStatsTypes'

import { computed, ref } from 'vue'
import { useAdminDashboardStore } from '~/stores/adminDashboard'

export function useAdminGlobalStatsTrend(defaultLogLabel = 'Admin Dashboard') {
  const adminStore = useAdminDashboardStore()
  const globalStatsTrendData = ref<GlobalStatsTrendPoint[]>([])
  const isLoadingGlobalStatsTrend = ref(false)
  let loadGlobalStatsTrendSequence = 0

  async function loadGlobalStatsTrend(logLabel = defaultLogLabel) {
    const sequence = ++loadGlobalStatsTrendSequence
    isLoadingGlobalStatsTrend.value = true
    try {
      const data = await adminStore.fetchStats('global_stats_trend')
      if (sequence !== loadGlobalStatsTrendSequence)
        return
      globalStatsTrendData.value = data || []
    }
    catch (error) {
      if (sequence !== loadGlobalStatsTrendSequence)
        return
      console.error(`[${logLabel}] Error loading global stats trend:`, error)
      globalStatsTrendData.value = []
    }
    finally {
      if (sequence === loadGlobalStatsTrendSequence)
        isLoadingGlobalStatsTrend.value = false
    }
  }

  const latestGlobalStats = computed(() => {
    if (globalStatsTrendData.value.length === 0)
      return null
    return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
  })

  return {
    globalStatsTrendData,
    isLoadingGlobalStatsTrend,
    loadGlobalStatsTrend,
    latestGlobalStats,
  }
}
