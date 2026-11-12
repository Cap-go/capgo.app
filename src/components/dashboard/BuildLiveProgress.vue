<script setup lang="ts">
import type { BuildLiveState, BuildPlatform } from '~/services/buildLiveStream'
import type { Database } from '~/types/database.types'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconAlert from '~icons/lucide/alert-circle'
import IconCheckCircle from '~icons/lucide/check-circle-2'
import IconCircle from '~icons/lucide/circle'
import IconDownload from '~icons/lucide/download'
import IconLoader from '~icons/lucide/loader-2'
import IconRotate from '~icons/lucide/rotate-ccw'
import IconSparkles from '~icons/lucide/sparkles'
import { applyBuildStreamMessage, buildTimeline, createBuildLiveState, resolveBuildOutcome, stepCopy } from '~/services/buildLiveStream'
import { invokeCapgoApi } from '~/services/capgoApi'
import { useConsole } from '~/services/console'
import { buildPreviewQrCodeDataUrl } from '~/services/previewQrCode'

type BuildRow = Pick<Database['public']['Tables']['build_requests']['Row'], 'status' | 'created_at' | 'started_at' | 'completed_at' | 'last_error' | 'builder_job_id'>

const props = defineProps<{
  appId: string
  buildId: string
  platform: BuildPlatform
  // Dev-only scripted build (`?buildDemo=`), never set in production.
  demo?: string
  // Inside a host card that already has its own title (Getting started checklist).
  embedded?: boolean
}>()
const emit = defineEmits<{ retry: [], done: [] }>()

const POLL_MS = 3000
const HEARTBEAT_MS = 2000
const MAX_RECONNECTS = 5

const { t } = useI18n()
const capgo = useConsole()
const row = ref<BuildRow | null>(null)
const live = ref<BuildLiveState>(createBuildLiveState())
const now = ref(Date.now())
const endedAt = ref<number | null>(null)
let stopped = false
let socket: WebSocket | null = null
let reconnects = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let stopDemo: (() => void) | undefined

const outcome = computed(() => resolveBuildOutcome(live.value.status, row.value?.status))
const timeline = computed(() => buildTimeline({
  live: live.value,
  dbStatus: row.value?.status,
  machineStarted: !!row.value?.started_at,
  platform: props.platform,
}))
const platformLabel = computed(() => props.platform === 'ios' ? t('build-platform-ios') : t('build-platform-android'))
const startedAtMs = computed(() => row.value ? Date.parse(row.value.created_at) : now.value)
const elapsed = computed(() => formatDuration((endedAt.value ?? now.value) - startedAtMs.value))
const percent = computed(() => Math.round(timeline.value.progress * 100))
const currentRow = computed(() => timeline.value.rows[timeline.value.current])
const currentLabel = computed(() => currentRow.value ? rowLabel(currentRow.value.key) : '')
const queued = computed(() => !outcome.value && (currentRow.value?.key === 'upload' || currentRow.value?.key === 'machine'))
const errorText = computed(() => row.value?.last_error || live.value.statusMessage || t('build-live-failed-no-error'))
const qrCode = computed(() => live.value.downloadUrl ? buildPreviewQrCodeDataUrl(live.value.downloadUrl) : '')
const terminalCommand = computed(() => `npx @capgo/cli@latest build request ${props.appId} --platform ${props.platform}`)
const jobShort = computed(() => row.value?.builder_job_id ? `${row.value.builder_job_id.slice(0, 12)}…` : '')

const title = computed(() => {
  if (outcome.value === 'success')
    return t('build-live-title-success', { platform: platformLabel.value })
  if (outcome.value === 'failure')
    return t('build-live-title-failed')
  return t('build-live-title-running', { platform: platformLabel.value })
})
const subtitle = computed(() => {
  if (outcome.value === 'success')
    return t('build-live-subtitle-success', { duration: elapsed.value })
  if (outcome.value === 'failure')
    return t('build-live-subtitle-failed')
  return t('build-live-subtitle-running')
})

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function rowLabel(key: string) {
  const copy = stepCopy(key)
  return copy.labelKey ? t(copy.labelKey) : copy.fallback
}

function rowWhy(key: string) {
  const copy = stepCopy(key)
  return copy.whyKey ? t(copy.whyKey) : ''
}

function rowTime(r: { state: string, startedAt?: number, durationMs?: number }) {
  if (r.durationMs !== undefined && r.state !== 'running')
    return formatDuration(r.durationMs)
  if (r.state === 'running' && r.startedAt)
    return formatDuration(now.value - r.startedAt)
  return ''
}

async function fetchRow() {
  const { data, error } = await capgo
    .from('build_requests')
    .select('status, created_at, started_at, completed_at, last_error, builder_job_id')
    .eq('id', props.buildId)
    .maybeSingle()
  if (error) {
    console.warn('Polling build_requests failed', error)
    return
  }
  if (data && !stopped)
    row.value = data
}

function closeSocket() {
  clearInterval(heartbeatTimer)
  clearTimeout(reconnectTimer)
  const ws = socket
  socket = null
  ws?.close()
}

// Token fetch failures and dropped sockets share one bounded backoff, then the page stays status-only.
function scheduleReconnect(jobId: string) {
  if (stopped || outcome.value || reconnects >= MAX_RECONNECTS)
    return
  reconnects += 1
  reconnectTimer = setTimeout(() => void connectStream(jobId), HEARTBEAT_MS * reconnects)
}

// Read-only follower of the builder log stream (same protocol as the CLI). It
// never acks messages and never calls /start: the CLI owns the session.
async function connectStream(jobId: string) {
  if (stopped || outcome.value)
    return
  const { data, error } = await invokeCapgoApi<{ logs_url?: string, logs_token?: string }>(`build/logs_token/${encodeURIComponent(jobId)}`, { method: 'GET', retries: 0 })
  if (error || !data?.logs_url || !data.logs_token) {
    // Builder stream not available (older backend, local dev): status-only view meanwhile.
    console.info('Live build stream unavailable, showing status only', error?.message)
    scheduleReconnect(jobId)
    return
  }
  if (stopped || outcome.value)
    return
  const baseUrl = data.logs_url.endsWith('/') ? data.logs_url.slice(0, -1) : data.logs_url
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/stream?token=${encodeURIComponent(data.logs_token)}`)
  socket = ws
  let synced = false
  const heartbeat = () => {
    if (ws.readyState !== WebSocket.OPEN)
      return
    // The first heartbeat asks for the full replay (steps, status, backlog); ids dedupe it.
    ws.send(JSON.stringify({ type: 'heartbeat', lastId: synced ? live.value.lastId : 0 }))
    synced = true
  }
  ws.addEventListener('open', () => {
    reconnects = 0
    heartbeat()
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS)
  })
  ws.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string')
      return
    let parsed: unknown = null
    try {
      parsed = JSON.parse(event.data)
    }
    catch {
      parsed = null
    }
    live.value = applyBuildStreamMessage(live.value, parsed)
  })
  ws.addEventListener('close', () => {
    if (socket !== ws)
      return
    clearInterval(heartbeatTimer)
    socket = null
    scheduleReconnect(jobId)
  })
}

async function copyFixPrompt() {
  const prompt = [
    t('build-live-fix-prompt', { platform: platformLabel.value, app: props.appId }),
    '',
    errorText.value,
  ].join('\n')
  try {
    await navigator.clipboard.writeText(prompt)
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error('Failed to copy fix prompt', error)
    toast.error(t('build-live-copy-failed'))
  }
}

function stop() {
  stopped = true
  clearInterval(pollTimer)
  clearInterval(clockTimer)
  stopDemo?.()
  closeSocket()
}

watch(() => row.value?.builder_job_id, (jobId) => {
  if (jobId && !socket && !props.demo)
    void connectStream(jobId)
})

watch(outcome, (value) => {
  if (!value)
    return
  const completedAt = row.value?.completed_at ? Date.parse(row.value.completed_at) : Number.NaN
  endedAt.value = Number.isNaN(completedAt) ? Date.now() : completedAt
  clearInterval(clockTimer)
  clearInterval(pollTimer)
  closeSocket()
  // The stream can finish before the row: one last read picks up last_error/completed_at.
  if (!props.demo && !stopped)
    void fetchRow()
})

onMounted(async () => {
  clockTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  if (import.meta.env.DEV && props.demo) {
    const { playBuildDemo } = await import('~/services/buildLiveDemo')
    const createdAt = new Date().toISOString()
    stopDemo = playBuildDemo(props.demo, props.platform, (message) => {
      live.value = applyBuildStreamMessage(live.value, message)
    }, (demoRow) => {
      row.value = { ...demoRow, created_at: createdAt, completed_at: null, last_error: null, builder_job_id: 'job_demo0000000000000000000000000' }
    })
    return
  }
  await fetchRow()
  if (!stopped && !outcome.value)
    pollTimer = setInterval(() => void fetchRow(), POLL_MS)
})

onUnmounted(stop)
</script>

<template>
  <div class="@container flex flex-col gap-6" data-test="build-live-progress">
    <header v-if="!embedded" class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60 sm:p-6">
      <h2 class="text-2xl font-semibold text-slate-950 dark:text-white sm:text-3xl">
        {{ title }}
      </h2>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base">
        {{ subtitle }}
      </p>
    </header>

    <!-- Success -->
    <section v-if="outcome === 'success'" class="rounded-xl border border-emerald-300 bg-white p-5 shadow-sm dark:border-emerald-500/40 dark:bg-slate-800/60 sm:p-6" data-test="build-live-success">
      <div class="flex flex-col gap-6 @xl:flex-row @xl:items-center @xl:justify-between">
        <div class="min-w-0">
          <span class="d-badge d-badge-success gap-2 font-semibold">
            <IconCheckCircle class="h-3.5 w-3.5" />
            {{ t('build-live-status-succeeded', { duration: elapsed }) }}
          </span>
          <p class="mt-4 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ live.downloadUrl ? t('build-live-success-download') : platform === 'ios' ? t('build-live-success-store-ios') : t('build-live-success-store-android') }}
          </p>
          <div class="mt-5 flex flex-wrap gap-3">
            <a v-if="live.downloadUrl" class="d-btn d-btn-primary gap-2" :href="live.downloadUrl" target="_blank" rel="noopener noreferrer">
              <IconDownload class="h-4 w-4" />
              {{ t('build-live-download') }}
            </a>
            <button v-if="!embedded" type="button" class="d-btn" :class="live.downloadUrl ? 'd-btn-outline' : 'd-btn-primary'" @click="emit('done')">
              {{ t('build-live-view-builds') }}
            </button>
          </div>
        </div>
        <figure v-if="qrCode" class="shrink-0 text-center">
          <img :src="qrCode" :alt="t('build-live-qr-alt')" class="h-40 w-40 rounded-lg bg-white p-2">
          <figcaption class="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {{ t('build-live-qr-caption') }}
          </figcaption>
        </figure>
      </div>
    </section>

    <!-- Running / failed -->
    <section v-else class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60 sm:p-6">
      <span
        class="d-badge gap-2 font-semibold"
        :class="outcome === 'failure' ? 'd-badge-error' : 'd-badge-info'"
      >
        <span class="h-2 w-2 rounded-full bg-current" :class="{ 'animate-pulse': !outcome }" />
        {{ outcome === 'failure' ? t('build-live-status-failed') : queued ? t('build-live-status-queued') : t('build-live-status-building') }}
      </span>
      <h3 class="mt-3 text-lg font-semibold text-slate-950 dark:text-white">
        {{ appId }} · {{ platformLabel }}
      </h3>
      <dl class="mt-4 flex gap-8">
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ t('build-live-elapsed') }}
          </dt>
          <dd class="text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
            {{ elapsed }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ t('build-live-step') }}
          </dt>
          <dd class="text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
            {{ timeline.current + 1 }} / {{ timeline.rows.length }}
          </dd>
        </div>
      </dl>
      <progress
        class="d-progress mt-4 h-2.5 w-full"
        :class="outcome === 'failure' ? 'd-progress-error' : 'd-progress-info animate-pulse'"
        :value="Math.max(percent, 3)"
        max="100"
        :aria-label="t('build-live-progress')"
      />
      <div class="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{{ outcome === 'failure' ? t('build-live-failed-at', { step: currentLabel }) : `${currentLabel}…` }}</span>
        <span class="tabular-nums">{{ percent }}%</span>
      </div>

      <div v-if="outcome === 'failure'" class="mt-5 rounded-lg border border-violet-300 bg-violet-50 p-4 dark:border-violet-500/40 dark:bg-violet-950/30" data-test="build-live-failure">
        <h4 class="flex items-center gap-2 font-semibold text-slate-950 dark:text-white">
          <IconSparkles class="h-4 w-4 text-violet-500" />
          {{ t('build-live-failure-title') }}
        </h4>
        <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-3 font-mono text-xs leading-5 text-red-300">{{ errorText }}</pre>
        <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {{ t('build-live-failure-ai-hint') }}
        </p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button type="button" class="d-btn d-btn-primary gap-2" @click="emit('retry')">
            <IconRotate class="h-4 w-4" />
            {{ t('build-live-retry') }}
          </button>
          <button type="button" class="d-btn d-btn-outline" @click="copyFixPrompt">
            {{ t('build-live-copy-fix-prompt') }}
          </button>
          <button v-if="!embedded" type="button" class="d-btn d-btn-ghost" @click="emit('done')">
            {{ t('build-live-view-builds') }}
          </button>
        </div>
      </div>
    </section>

    <div v-if="outcome !== 'success'" class="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section class="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-800/60">
        <div class="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-white/10">
          <h3 class="font-semibold text-slate-950 dark:text-white">
            {{ t('build-live-steps-title') }}
          </h3>
        </div>
        <ol>
          <li
            v-for="r in timeline.rows"
            :key="r.key"
            class="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-3 border-t border-slate-100 px-5 py-3 first:border-t-0 dark:border-white/5"
          >
            <IconCheckCircle v-if="r.state === 'done'" class="mt-0.5 h-5 w-5 text-emerald-500" />
            <IconLoader v-else-if="r.state === 'running'" class="mt-0.5 h-5 w-5 animate-spin text-azure-500" />
            <IconAlert v-else-if="r.state === 'failed'" class="mt-0.5 h-5 w-5 text-red-500" />
            <IconCircle v-else class="mt-0.5 h-5 w-5 text-slate-300 dark:text-slate-600" />
            <div class="min-w-0">
              <p class="font-medium" :class="r.state === 'pending' ? 'text-slate-400 dark:text-slate-500' : 'text-slate-900 dark:text-white'">
                {{ rowLabel(r.key) }}
              </p>
              <p v-if="(r.state === 'running' || r.state === 'failed') && rowWhy(r.key)" class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {{ rowWhy(r.key) }}
              </p>
            </div>
            <span class="text-sm tabular-nums" :class="r.state === 'running' ? 'text-azure-500' : 'text-slate-500 dark:text-slate-400'">
              {{ rowTime(r) }}
            </span>
          </li>
        </ol>
      </section>

      <aside class="h-fit rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60">
        <h3 class="font-semibold text-slate-950 dark:text-white">
          {{ t('build-live-terminal-title') }}
        </h3>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('build-live-terminal-subtitle') }}
        </p>
        <div class="mt-3 space-y-1 rounded-md bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-300">
          <p class="break-all">
            <span class="text-emerald-400">$</span> {{ terminalCommand }}
          </p>
          <p v-if="jobShort">
            <span class="text-emerald-400">✔</span> {{ t('build-live-terminal-requested', { job: jobShort }) }}
          </p>
          <p :class="outcome === 'failure' ? 'text-red-400' : 'text-azure-400'">
            {{ outcome === 'failure' ? `✖ ${t('build-live-failed-at', { step: currentLabel })}` : `⠋ ${currentLabel}…` }}
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
