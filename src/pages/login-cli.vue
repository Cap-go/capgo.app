<script setup lang="ts">
import type { RealtimeChannel } from '@supabase/supabase-js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconKey from '~icons/heroicons/key'
import {
  createCliLoginKeyDependencies,
  getCliLoginDestination,
  isMatchingCliLoginEvent,
  isValidCliLoginSession,
  prepareCliLoginKey,
} from '~/services/cliLogin'
import { formatLocalDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

type PageState = 'direct' | 'preparing' | 'empty' | 'ready' | 'success' | 'error'

const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const state = ref<PageState>('preparing')
const secret = ref<string | null>(null)
const revealed = ref(false)
const reused = ref(false)
const hashed = ref(false)
const expiresAt = ref<string | null>(null)
const skippedNames = ref<string[]>([])
const realtimeUnavailable = ref(false)
const destination = ref('/dashboard')
const channels: RealtimeChannel[] = []
const displayedKey = computed(() => revealed.value && secret.value ? secret.value : hiddenKey)

function clearSecret(): void {
  revealed.value = false
  secret.value = null
}

function clearChannels(): void {
  for (const channel of channels.splice(0))
    void supabase.removeChannel(channel)
}

async function resolveDestination(): Promise<string> {
  const accepted = organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org))
  if (accepted.length !== 1 || accepted[0].app_count !== 1)
    return '/dashboard'
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, need_onboarding')
    .eq('owner_org', accepted[0].gid)
    .limit(2)
  return error ? '/dashboard' : getCliLoginDestination(accepted.length, data ?? [])
}

async function complete(): Promise<void> {
  if (state.value === 'success')
    return
  state.value = 'success'
  clearSecret()
  clearChannels()
  destination.value = await resolveDestination()
}

function subscribe(orgIds: string[], session: string): Promise<boolean[]> {
  return Promise.all(orgIds.map(orgId => new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (connected: boolean) => {
      if (settled)
        return
      settled = true
      resolve(connected)
    }
    const channel = supabase.channel(`cli-events:org:${orgId}`)
      .on('broadcast', { event: 'cli-activity' }, (message) => {
        if (isMatchingCliLoginEvent(message.payload, session))
          void complete()
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED')
          finish(true)
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          finish(false)
      })
    channels.push(channel)
  })))
}

async function prepare(): Promise<void> {
  clearChannels()
  clearSecret()
  state.value = 'preparing'
  realtimeUnavailable.value = false
  if (!isValidCliLoginSession(route.query.session)) {
    state.value = 'direct'
    return
  }

  try {
    await organizationStore.awaitInitialLoad()
    const userId = main.user?.id ?? main.auth?.id
    if (!userId)
      throw new Error('Missing authenticated user')
    const result = await prepareCliLoginKey(
      organizationStore.organizations,
      createCliLoginKeyDependencies(supabase, userId),
    )
    skippedNames.value = result.skippedOrganizationNames
    if (result.status === 'empty') {
      state.value = 'empty'
      return
    }
    secret.value = result.secret
    reused.value = result.reused
    hashed.value = result.policy.hashed
    expiresAt.value = result.policy.expiresAt
    const connections = await subscribe(result.eligibleOrgIds, route.query.session)
    realtimeUnavailable.value = !connections.some(Boolean)
    showReadyUnlessCompleted()
  }
  catch (error) {
    console.error('Cannot prepare CLI login key', error)
    state.value = 'error'
  }
}

async function copyKey(): Promise<void> {
  if (!secret.value)
    return
  try {
    await navigator.clipboard.writeText(secret.value)
    toast.success(t('cli-login-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
  }
}

function goToDestination(): void {
  void router.push(destination.value)
}

function showReadyUnlessCompleted(): void {
  if (state.value !== 'success')
    state.value = 'ready'
}

onMounted(prepare)
onBeforeUnmount(() => {
  clearSecret()
  clearChannels()
})
</script>

<template>
  <main class="flex min-h-full items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
    <section class="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-8">
      <header class="mb-6 flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-primary dark:bg-orange-950/40">
          <IconKey class="h-5 w-5" />
        </span>
        <h1 class="text-2xl font-semibold text-slate-950 dark:text-white">
          {{ t('cli-login-title') }}
        </h1>
      </header>

      <p v-if="state === 'preparing'" role="status" class="text-slate-600 dark:text-slate-300">
        {{ t('cli-login-preparing') }}
      </p>

      <div v-else-if="state === 'direct'" class="space-y-4">
        <h2 class="text-lg font-semibold">
          {{ t('cli-login-direct-title') }}
        </h2>
        <p>{{ t('cli-login-direct-description') }}</p>
        <button class="btn" type="button" @click="router.push('/dashboard')">
          {{ t('dashboard') }}
        </button>
      </div>

      <div v-else-if="state === 'empty'" class="space-y-4">
        <p class="alert alert-warning">
          {{ t('cli-login-no-eligible') }}
        </p>
        <p v-if="skippedNames.length" class="text-sm">
          {{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}
        </p>
        <button class="btn" type="button" @click="router.push('/dashboard')">
          {{ t('dashboard') }}
        </button>
      </div>

      <div v-else-if="state === 'ready'" class="space-y-5">
        <p class="text-slate-600 dark:text-slate-300">
          {{ t('cli-login-paste-instruction') }}
        </p>
        <div class="flex items-center gap-2 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <code :class="revealed ? '' : 'select-none blur-[5px]'" class="min-w-0 flex-1 truncate">{{ displayedKey }}</code>
          <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="revealed" @click="revealed = !revealed">
            {{ t(revealed ? 'cli-login-hide-key' : 'cli-login-reveal-key') }}
          </button>
          <button class="btn btn-primary btn-sm" type="button" @click="copyKey">
            <IconClipboard class="h-4 w-4" /> {{ t('copy') }}
          </button>
        </div>
        <p class="text-xs text-slate-500">
          {{ t('cli-login-copy-note') }}
        </p>
        <p class="alert alert-warning text-sm">
          {{ t('cli-login-security-warning') }}
        </p>
        <p v-if="reused" class="text-sm">
          {{ t('cli-login-reused') }}
        </p>
        <p v-if="hashed" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-hashed-warning') }}
        </p>
        <p v-if="expiresAt" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-expiration-warning', { date: formatLocalDate(expiresAt) }) }}
        </p>
        <p v-if="skippedNames.length" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}
        </p>
        <p role="status" class="text-sm" :class="realtimeUnavailable ? 'text-amber-700' : 'text-slate-500'">
          {{ t(realtimeUnavailable ? 'cli-login-realtime-unavailable' : 'cli-login-waiting') }}
        </p>
      </div>

      <div v-else-if="state === 'success'" class="space-y-5 text-center">
        <IconCheckCircle class="mx-auto h-12 w-12 text-emerald-500" />
        <h2 class="text-xl font-semibold">
          {{ t('cli-login-success-title') }}
        </h2>
        <button class="btn btn-primary" type="button" @click="goToDestination">
          {{ t(destination.startsWith('/app/new') ? 'cli-login-continue-setup' : 'dashboard') }}
        </button>
      </div>

      <div v-else class="space-y-4">
        <p class="alert alert-error">
          {{ t('cli-login-error') }}
        </p>
        <div class="flex gap-2">
          <button class="btn btn-primary" type="button" @click="prepare">
            {{ t('retry') }}
          </button>
          <button class="btn" type="button" @click="router.push('/dashboard')">
            {{ t('dashboard') }}
          </button>
        </div>
      </div>
    </section>
  </main>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
