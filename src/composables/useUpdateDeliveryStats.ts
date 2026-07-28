import type { Ref } from 'vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { defaultApiHost, useSupabase } from '~/services/supabase'

export type UpdateDeliveryScope = 'app' | 'org' | 'platform'

export interface UpdateDeliveryStatsResponse {
  scope: UpdateDeliveryScope
  labels: string[]
  period: {
    requested_days: number
    actual_days: number
    start: string
    end: string
  }
  overview: {
    samples: number
    devices: number | null
    p50_ms: number | null
    p75_ms: number | null
    p95_ms: number | null
    p99_ms: number | null
  }
  daily: {
    samples: number[]
    p50_ms: Array<number | null>
    p75_ms: Array<number | null>
    p95_ms: Array<number | null>
    p99_ms: Array<number | null>
  }
}

export function useUpdateDeliveryStats(
  params: () => {
    scope: UpdateDeliveryScope
    app_id?: string
    org_id?: string
    days: number
  },
  logContext = 'update delivery stats',
) {
  const supabase = useSupabase()
  const { t } = useI18n()
  const stats = ref<UpdateDeliveryStatsResponse | null>(null) as Ref<UpdateDeliveryStatsResponse | null>
  const statsLoading = ref(false)
  const statsError = ref(false)
  let latestRequest = 0

  async function fetchStats() {
    const body = params()
    if (body.scope === 'app' && !body.app_id) {
      latestRequest += 1
      stats.value = null
      statsError.value = false
      statsLoading.value = false
      return
    }
    if (body.scope === 'org' && !body.org_id) {
      latestRequest += 1
      stats.value = null
      statsError.value = false
      statsLoading.value = false
      return
    }

    const requestId = ++latestRequest
    statsLoading.value = true
    statsError.value = false
    stats.value = null
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        if (requestId === latestRequest) {
          statsError.value = true
          toast.error(t('not-authenticated'))
        }
        return
      }

      const response = await fetch(`${defaultApiHost}/private/update_delivery_stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify(body),
      })

      if (requestId !== latestRequest)
        return

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        if (requestId !== latestRequest)
          return
        console.error(`Failed to fetch ${logContext}:`, errorData)
        statsError.value = true
        toast.error(t('failed-to-fetch-update-delivery-stats'))
        return
      }

      const payload = await response.json() as UpdateDeliveryStatsResponse
      if (requestId !== latestRequest)
        return
      stats.value = payload
    }
    catch (error) {
      if (requestId !== latestRequest)
        return
      console.error(`Error fetching ${logContext}:`, error)
      statsError.value = true
      toast.error(t('failed-to-fetch-update-delivery-stats'))
    }
    finally {
      if (requestId === latestRequest)
        statsLoading.value = false
    }
  }

  return { stats, statsLoading, statsError, fetchStats }
}

export function buildDemoUpdateDeliveryStats(days: number): UpdateDeliveryStatsResponse {
  const labels: string[] = []
  const end = new Date()
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(end)
    date.setUTCDate(end.getUTCDate() - i)
    labels.push(date.toISOString().slice(0, 10))
  }

  const p50_ms = labels.map((_, index) => 700 + index * 18)
  const p75_ms = labels.map((_, index) => 1100 + index * 24)
  const p95_ms = labels.map((_, index) => 2200 + index * 40)
  const p99_ms = labels.map((_, index) => 3800 + index * 55)
  const samples = labels.map((_, index) => 20 + index * 3)

  return {
    scope: 'app',
    labels,
    period: {
      requested_days: days,
      actual_days: labels.length,
      start: `${labels[0]}T00:00:00.000Z`,
      end: `${labels[labels.length - 1]}T23:59:59.999Z`,
    },
    overview: {
      samples: samples.reduce((sum, value) => sum + value, 0),
      devices: 42,
      p50_ms: p50_ms[p50_ms.length - 1] ?? null,
      p75_ms: p75_ms[p75_ms.length - 1] ?? null,
      p95_ms: p95_ms[p95_ms.length - 1] ?? null,
      p99_ms: p99_ms[p99_ms.length - 1] ?? null,
    },
    daily: {
      samples,
      p50_ms,
      p75_ms,
      p95_ms,
      p99_ms,
    },
  }
}
