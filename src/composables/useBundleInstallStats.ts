import type { Ref } from 'vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { defaultApiHost, useSupabase } from '~/services/supabase'

export interface BundleInstallStatsItem {
  version_name: string
  install: number
  fail: number
  success_rate: number | null
  timing: {
    samples: number
    p50_ms: number | null
    p70_ms: number | null
    p90_ms: number | null
    p95_ms: number | null
  }
}

export interface BundleInstallStatsResponse {
  period: {
    requested_days: number
    actual_days: number
    start: string
    end: string
  }
  bundles: BundleInstallStatsItem[]
  totals: {
    install: number
    fail: number
    success_rate: number | null
  }
}

export function useBundleInstallStats(
  params: () => {
    app_id: string
    days: number
    channel_id?: number
    version_name?: string
  },
) {
  const supabase = useSupabase()
  const { t } = useI18n()
  const stats = ref<BundleInstallStatsResponse | null>(null) as Ref<BundleInstallStatsResponse | null>
  const statsLoading = ref(false)
  const statsError = ref(false)
  let latestRequest = 0

  async function fetchStats() {
    const body = params()
    if (!body.app_id) {
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

      const response = await fetch(`${defaultApiHost}/private/bundle_install_stats`, {
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
        console.error('Failed to fetch bundle install stats:', errorData)
        statsError.value = true
        toast.error(t('failed-to-fetch-bundle-install-stats'))
        return
      }

      stats.value = await response.json() as BundleInstallStatsResponse
    }
    catch (error) {
      if (requestId !== latestRequest)
        return
      console.error('Error fetching bundle install stats:', error)
      statsError.value = true
      toast.error(t('failed-to-fetch-bundle-install-stats'))
    }
    finally {
      if (requestId === latestRequest)
        statsLoading.value = false
    }
  }

  return { stats, statsLoading, statsError, fetchStats }
}

export function buildDemoBundleInstallStats(days: number): BundleInstallStatsResponse {
  const end = dayjsUtcEnd()
  const start = new Date(end)
  start.setUTCDate(end.getUTCDate() - (days - 1))

  return {
    period: {
      requested_days: days,
      actual_days: days,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    bundles: [
      {
        version_name: '1.2.0',
        install: 842,
        fail: 18,
        success_rate: 97.9,
        timing: { samples: 620, p50_ms: 4200, p70_ms: 6100, p90_ms: 9800, p95_ms: 12400 },
      },
      {
        version_name: '1.1.0',
        install: 210,
        fail: 12,
        success_rate: 94.6,
        timing: { samples: 145, p50_ms: 5100, p70_ms: 7200, p90_ms: 11200, p95_ms: 14800 },
      },
      {
        version_name: '1.0.0',
        install: 95,
        fail: 8,
        success_rate: 92.2,
        timing: { samples: 52, p50_ms: 6800, p70_ms: 9100, p90_ms: 14500, p95_ms: 18200 },
      },
    ],
    totals: {
      install: 1147,
      fail: 38,
      success_rate: 96.8,
    },
  }
}

function dayjsUtcEnd() {
  const end = new Date()
  end.setUTCHours(23, 59, 59, 999)
  return end
}
