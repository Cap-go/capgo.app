import type { Ref } from 'vue'
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { ref, watch } from 'vue'
import { defaultApiHost, useSupabase } from '~/services/supabase'

export const RELEASE_LIVE_POLL_INTERVAL_MS = 60_000

export interface ReleaseLiveDeployment {
  version_name: string
  channel_id: number | null
  channel_name: string | null
  deployed_at: string
}

export interface ReleaseLiveBucket {
  ts: string
  get: number
  install: number
  fail: number
}

export interface ReleaseLiveResponse {
  release: (ReleaseLiveDeployment & { bundle_id: number | null }) | null
  window?: {
    start: string
    end: string
    bucket_minutes: number
    truncated: boolean
  }
  totals?: {
    get: number
    install: number
    fail: number
    success_rate: number | null
  }
  adoption?: {
    devices_on_release: number
    total_devices: number
    percent: number | null
  }
  failures?: { action: string, count: number }[]
  series?: ReleaseLiveBucket[]
  recent_deployments: ReleaseLiveDeployment[]
  generated_at?: string
}

export function useReleaseLive(
  params: () => {
    app_id: string
    channel_id?: number
    version_name?: string
    enabled: boolean
  },
) {
  const supabase = useSupabase()
  const data = ref<ReleaseLiveResponse | null>(null) as Ref<ReleaseLiveResponse | null>
  const loading = ref(false)
  const error = ref(false)
  const lastUpdatedAt = ref<number | null>(null)
  const visibility = useDocumentVisibility()
  let latestRequest = 0

  async function fetchLive(options: { silent?: boolean } = {}) {
    const { enabled, ...body } = params()
    if (!enabled || !body.app_id) {
      latestRequest += 1
      loading.value = false
      return
    }

    const requestId = ++latestRequest
    if (!options.silent)
      loading.value = true
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session)
        throw new Error('not_authenticated')

      const response = await fetch(`${defaultApiHost}/private/release_live`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify(body),
      })
      if (requestId !== latestRequest)
        return
      if (!response.ok)
        throw new Error(`release_live HTTP ${response.status}`)

      const payload = await response.json() as ReleaseLiveResponse
      if (requestId !== latestRequest)
        return
      data.value = payload
      error.value = false
      lastUpdatedAt.value = Date.now()
    }
    catch (err) {
      if (requestId !== latestRequest)
        return
      console.error('Error fetching live release stats:', err)
      // Keep showing the last good snapshot during background polls.
      if (!options.silent || !data.value)
        error.value = true
    }
    finally {
      if (requestId === latestRequest)
        loading.value = false
    }
  }

  const { pause, resume } = useIntervalFn(() => {
    if (visibility.value === 'visible')
      void fetchLive({ silent: true })
  }, RELEASE_LIVE_POLL_INTERVAL_MS, { immediate: false })

  // Any change of target invalidates the in-flight request and the previous
  // snapshot, so the panel never shows another app's or release's numbers.
  watch(
    () => {
      const { app_id, channel_id, version_name, enabled } = params()
      return [app_id, channel_id, version_name, enabled] as const
    },
    ([, , , enabled], previous) => {
      if (previous) {
        latestRequest += 1
        data.value = null
        error.value = false
        lastUpdatedAt.value = null
        loading.value = false
      }
      if (enabled) {
        void fetchLive()
        resume()
      }
      else {
        pause()
      }
    },
    { immediate: true },
  )

  // Catch up right away when the user comes back to the tab.
  watch(visibility, (state, previous) => {
    if (state === 'visible' && previous === 'hidden' && params().enabled)
      void fetchLive({ silent: true })
  })

  return { data, loading, error, lastUpdatedAt, fetchLive }
}

function demoFailures(index: number) {
  if (index % 7 === 2)
    return 3
  if (index % 5 === 0)
    return 1
  return 0
}

export function buildDemoReleaseLive(now = Date.now()): ReleaseLiveResponse {
  const bucketMinutes = 5
  const bucketMs = bucketMinutes * 60_000
  const end = Math.floor(now / bucketMs) * bucketMs
  const start = end - 36 * bucketMs
  const series: ReleaseLiveBucket[] = []
  for (let index = 0; index < 36; index += 1) {
    const ramp = Math.round(120 * Math.exp(-index / 10) + 8)
    series.push({
      ts: new Date(start + index * bucketMs).toISOString(),
      get: ramp + 6,
      install: ramp,
      fail: demoFailures(index),
    })
  }
  const install = series.reduce((sum, bucket) => sum + bucket.install, 0)
  const fail = series.reduce((sum, bucket) => sum + bucket.fail, 0)
  const get = series.reduce((sum, bucket) => sum + bucket.get, 0)
  const deployedAt = new Date(start).toISOString()
  return {
    release: {
      bundle_id: null,
      version_name: '1.2.0',
      channel_id: 1,
      channel_name: 'production',
      deployed_at: deployedAt,
    },
    window: {
      start: deployedAt,
      end: new Date(now).toISOString(),
      bucket_minutes: bucketMinutes,
      truncated: false,
    },
    totals: {
      get,
      install,
      fail,
      success_rate: Math.round((install / (install + fail)) * 1000) / 10,
    },
    adoption: {
      devices_on_release: install,
      total_devices: Math.round(install * 1.6),
      percent: Math.round((1 / 1.6) * 1000) / 10,
    },
    failures: [
      { action: 'download_fail', count: 9 },
      { action: 'checksum_fail', count: 3 },
      { action: 'unzip_fail', count: 1 },
    ],
    series,
    recent_deployments: [
      { version_name: '1.2.0', channel_id: 1, channel_name: 'production', deployed_at: deployedAt },
    ],
    generated_at: new Date(now).toISOString(),
  }
}
