<script setup lang="ts">
import type { SimulatorSummary } from '../../services/simulatorSessions'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconSmartphone from '~icons/lucide/smartphone'
import { defaultApiHost, useConsole } from '../../services/console'
import { formatLocalDateTime } from '../../services/date'
import { applySimulatorList, forgetSimulator, formatSimulatorDuration, noteSimulatorStartError, rememberSimulator, runningSimulators, sessionRemainsAfterLookup, simulatorConfigured, simulatorEpoch } from '../../services/simulatorSessions'

const props = defineProps<{ appId: string }>()
const { t } = useI18n()
const capgo = useConsole()
const pending = ref<'ios' | 'android' | ''>('')
const stoppingId = ref('')
const sessions = computed(() => runningSimulators(props.appId))
const recent = ref<SimulatorSummary[]>([])
const limits = ref({ idle: 5, max: 40 })
const error = ref('')
// Sessions stopped from this card: the list may still report them running for a while.
const stoppedHere = new Set<string>()
// While a simulator runs, check every 30 seconds: one that stopped by itself leaves the list.
const REFRESH_MS = 30_000
let timer: ReturnType<typeof setInterval> | undefined
// Only the latest list request may update the card: an older answer can still say running.
let listRequest = 0

const finished = computed(() => recent.value.filter(item => item.status !== 'in-progress').slice(0, 5))

function startedAt(id: string) {
  return recent.value.find(item => item.id === id)?.started_at ?? null
}

function platformLabel(platform: string) {
  return platform === 'android' ? t('platform-android') : t('platform-ios')
}

async function sessionToken() {
  const { data } = await capgo.auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new Error(t('simulator-sign-in'))
  return token
}

async function loadSessions() {
  const appId = props.appId
  const epoch = simulatorEpoch()
  const request = ++listRequest
  try {
    const response = await fetch(`${defaultApiHost}/private/simulator/?app_id=${encodeURIComponent(appId)}`, {
      headers: { authorization: `Bearer ${await sessionToken()}` },
    })
    if (!response.ok)
      return false
    const payload = await response.json() as { data?: SimulatorSummary[], idle_minutes?: number, max_minutes?: number, configured?: boolean }
    if (request !== listRequest || epoch !== simulatorEpoch() || appId !== props.appId || !Array.isArray(payload.data))
      return false
    recent.value = payload.data
    if (typeof payload.configured === 'boolean')
      simulatorConfigured.value = payload.configured
    limits.value = { idle: payload.idle_minutes ?? limits.value.idle, max: payload.max_minutes ?? limits.value.max }
    applySimulatorList(appId, payload.data, epoch, stoppedHere)
    return true
  }
  catch {
    return false
  }
}

// Sessions this tab started that the list does not include: ask for each one.
async function refreshSessions(listed: boolean) {
  const appId = props.appId
  const known = runningSimulators(appId).filter(session => !listed || !recent.value.some(item => item.id === session.id))
  await Promise.all(known.map(async (session) => {
    const remains = await sessionRemainsAfterLookup(async () => {
      const response = await fetch(`${defaultApiHost}/private/simulator/${session.id}?app_id=${encodeURIComponent(appId)}`, {
        headers: { authorization: `Bearer ${await sessionToken()}` },
      })
      if (!response.ok)
        return { httpStatus: response.status }
      const payload = await response.json() as { data?: { status?: string } }
      return { httpStatus: response.status, sessionStatus: payload.data?.status }
    })
    if (!remains)
      forgetSimulator(appId, session.id)
  }))
}

async function refresh() {
  await refreshSessions(await loadSessions())
}

// A session stopped here that the (cached) list still shows running: its build time is not listed yet.
function awaitingSummary() {
  return recent.value.some(item => item.status === 'in-progress' && stoppedHere.has(item.id))
}

function shouldRefresh() {
  return document.visibilityState === 'visible' && (sessions.value.length > 0 || awaitingSummary())
}

function onVisible() {
  if (shouldRefresh())
    void refresh()
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    if (shouldRefresh())
      void refresh()
  }, REFRESH_MS)
  document.addEventListener('visibilitychange', onVisible)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})

async function start(platform: 'ios' | 'android') {
  const epoch = simulatorEpoch()
  error.value = ''
  pending.value = platform
  try {
    const response = await fetch(`${defaultApiHost}/private/simulator/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${await sessionToken()}`,
      },
      body: JSON.stringify({ app_id: props.appId, platform }),
    })
    const payload = await response.json().catch(() => undefined) as { data?: { id?: string, url?: string }, message?: string, error?: string } | undefined
    if (!response.ok) {
      // A missing simulator host is explained by the hint that replaces the start buttons.
      if (noteSimulatorStartError(payload)) {
        // A list sent before this refusal must not bring the start buttons back.
        listRequest++
        return
      }
      throw new Error(payload?.message || payload?.error || t('simulator-did-not-start'))
    }
    const id = payload?.data?.id
    if (id)
      rememberSimulator(props.appId, { id, url: payload.data?.url || '' }, epoch)
    void loadSessions()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('simulator-did-not-start')
  }
  finally {
    pending.value = ''
  }
}

async function stop(id: string) {
  error.value = ''
  stoppingId.value = id
  try {
    const response = await fetch(`${defaultApiHost}/private/simulator/${id}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${await sessionToken()}`,
      },
      body: JSON.stringify({ app_id: props.appId }),
    })
    const payload = await response.json().catch(() => undefined) as { message?: string, error?: string } | undefined
    if (!response.ok)
      throw new Error(payload?.message || payload?.error || t('simulator-did-not-stop'))
    stoppedHere.add(id)
    forgetSimulator(props.appId, id)
    void loadSessions()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('simulator-did-not-stop')
  }
  finally {
    stoppingId.value = ''
  }
}
</script>

<template>
  <section data-simulator-card class="p-4 mb-6 bg-white rounded-xl border border-slate-200 dark:bg-slate-900 dark:border-slate-700">
    <div class="flex flex-wrap gap-3 items-center">
      <span class="inline-flex gap-1 items-center px-2 py-1 text-xs font-medium text-white bg-slate-900 rounded-full dark:bg-white dark:text-slate-900">
        <IconSmartphone class="w-3.5 h-3.5" />
        {{ t('simulator') }}
      </span>
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('simulator-slot-minutes') }}
      </p>
    </div>
    <p class="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">
      {{ t('simulator-auto-stop', { idle: limits.idle, max: limits.max }) }}
    </p>
    <p v-if="simulatorConfigured === false" class="mt-4 text-sm text-slate-600 dark:text-slate-300" data-test="simulator-not-configured">
      {{ t('simulator-not-configured-hint') }}
    </p>
    <div v-else class="flex flex-wrap gap-2 mt-4">
      <button type="button" class="text-white d-btn d-btn-primary" :disabled="pending !== '' || stoppingId !== ''" @click="start('ios')">
        {{ pending === 'ios' ? t('simulator-starting') : t('start-ios-simulator') }}
      </button>
      <button type="button" class="d-btn" :disabled="pending !== '' || stoppingId !== ''" @click="start('android')">
        {{ pending === 'android' ? t('simulator-starting') : t('start-android-simulator') }}
      </button>
    </div>
    <div v-for="session in sessions" :key="session.id" class="flex flex-wrap gap-3 items-center mt-3">
      <span class="inline-flex gap-1.5 items-center text-sm font-medium text-emerald-700 dark:text-emerald-400">
        <span class="w-2 h-2 bg-emerald-500 rounded-full" />
        {{ t('simulator-running') }}
      </span>
      <span v-if="startedAt(session.id)" class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('simulator-started-at', { time: formatLocalDateTime(startedAt(session.id)) }) }}
      </span>
      <a v-if="session.url" class="text-white d-btn d-btn-primary d-btn-sm" :href="session.url" target="_blank" rel="noreferrer">
        {{ t('simulator-open') }}
      </a>
      <button type="button" class="d-btn" :disabled="pending !== '' || stoppingId !== ''" @click="stop(session.id)">
        {{ stoppingId === session.id ? t('simulator-stopping') : t('stop-simulator') }}
      </button>
    </div>
    <div v-if="finished.length" class="pt-3 mt-4 border-t border-slate-200 dark:border-slate-700">
      <p class="text-xs font-medium text-slate-500 uppercase dark:text-slate-400">
        {{ t('simulator-recent') }}
      </p>
      <ul class="mt-2 space-y-1">
        <li v-for="item in finished" :key="item.id" class="flex flex-wrap gap-x-3 text-sm text-slate-600 dark:text-slate-300">
          <span class="font-medium text-slate-900 dark:text-white">{{ platformLabel(item.platform) }}</span>
          <span>{{ formatLocalDateTime(item.started_at) }}</span>
          <span v-if="item.build_time_seconds != null">
            {{ t('simulator-ran-for', { duration: formatSimulatorDuration(item.build_time_seconds), counted: formatSimulatorDuration(item.billable_seconds ?? item.build_time_seconds) }) }}
          </span>
        </li>
      </ul>
    </div>
    <p v-if="error" class="mt-3 text-sm text-red-600 dark:text-red-400">
      {{ error }}
    </p>
  </section>
</template>
