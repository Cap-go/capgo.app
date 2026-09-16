import type { Ref } from 'vue'
import type { DateRangeValue } from '~/services/dateRange'
import type { PeriodDayOption } from '~/utils/periodDays'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { legacyStatsDaysFromRange } from '~/utils/observePeriodDays'

export interface LogInsightSummary {
  total: number
  device_count: number
  action_count: number
}

export interface LogInsightAction {
  action: string
  total: number
  device_count: number
  version_count: number
  first_seen: string | null
  last_seen: string | null
  latest_version_name: string
  latest_device_id: string
}

export interface LogInsightDaily {
  date: string
  action: string
  total: number
}

export interface LogInsightVersion {
  action: string
  version_name: string
  total: number
  device_count: number
  last_seen: string | null
}

export interface LogInsightDevice {
  action: string
  device_id: string
  total: number
  version_name: string
  last_seen: string | null
}

export interface LogInsightsResponse {
  summary: LogInsightSummary
  actions: LogInsightAction[]
  daily: LogInsightDaily[]
  versions: LogInsightVersion[]
  devices: LogInsightDevice[]
  period: {
    requested_days: PeriodDayOption
    start: string
    end: string
    labels: string[]
  }
}

export function useObserveInsights(options: {
  appId: Ref<string>
  rangeValue: Ref<DateRangeValue>
  selectedVersionName: Ref<string>
}) {
  const { t } = useI18n()
  const supabase = useSupabase()
  const insightsLoading = ref(false)
  const insights = ref<LogInsightsResponse | null>(null)
  let latestInsightsRequest = 0

  async function fetchInsights() {
    if (!options.appId.value)
      return

    const requestId = ++latestInsightsRequest
    insightsLoading.value = true
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        if (requestId === latestInsightsRequest)
          toast.error(t('not-authenticated'))
        return
      }

      const { start, end } = options.rangeValue.value
      const response = await fetch(`${defaultApiHost}/private/stats/insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({
          appId: options.appId.value,
          rangeStart: start.toISOString(),
          rangeEnd: end.toISOString(),
          ...(options.selectedVersionName.value ? { versionName: options.selectedVersionName.value } : {}),
        }),
      })

      if (requestId !== latestInsightsRequest)
        return

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        if (requestId !== latestInsightsRequest)
          return
        console.error('Failed to fetch log insights:', errorData)
        toast.error(t('failed-to-fetch-log-insights'))
        return
      }

      const payload = await response.json() as LogInsightsResponse
      if (requestId !== latestInsightsRequest)
        return
      insights.value = payload
    }
    catch (error) {
      if (requestId !== latestInsightsRequest)
        return
      console.error(error)
      toast.error(t('failed-to-fetch-log-insights'))
    }
    finally {
      if (requestId === latestInsightsRequest)
        insightsLoading.value = false
    }
  }

  watch(
    () => [
      options.appId.value,
      options.rangeValue.value.start.getTime(),
      options.rangeValue.value.end.getTime(),
      options.selectedVersionName.value,
    ] as const,
    async ([appId], previous) => {
      if (!appId || !previous)
        return
      await fetchInsights()
    },
  )

  const legacyStatsDays = computed(() =>
    legacyStatsDaysFromRange(options.rangeValue.value.start, options.rangeValue.value.end),
  )

  return {
    insights,
    insightsLoading,
    fetchInsights,
    legacyStatsDays,
  }
}
