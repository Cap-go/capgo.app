<script setup lang="ts">
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { CliAiPromptOrganization } from '~/services/cliAiPrompt'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconEye from '~icons/heroicons/eye'
import IconEyeSlash from '~icons/heroicons/eye-slash'
import IconKey from '~icons/heroicons/key'
import IconSparkles from '~icons/heroicons/sparkles'
import { buildCliAiSetupPrompt } from '~/services/cliAiPrompt'
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
const revealDialogOpen = ref(false)
const reused = ref(false)
const hashed = ref(false)
const expiresAt = ref<string | null>(null)
const skippedNames = ref<string[]>([])
const realtimeUnavailable = ref(false)
const destination = ref('/dashboard')
const channels: RealtimeChannel[] = []
const aiPromptOrganizations = ref<CliAiPromptOrganization[]>([])
const aiPromptSkippedOrganizations = ref<Array<{ id: string, name: string }>>([])
const aiMode = computed(() => route.query.ai === '1')
const displayedKey = computed(() => revealed.value && secret.value ? secret.value : hiddenKey)
const aiPrompt = computed(() => {
  if (!secret.value || aiPromptOrganizations.value.length === 0)
    return ''
  return buildCliAiSetupPrompt({
    apiKey: secret.value,
    organizations: aiPromptOrganizations.value,
    skippedOrganizations: aiPromptSkippedOrganizations.value,
  })
})
const revealButtonRef = useTemplateRef<HTMLButtonElement>('revealButtonRef')
const revealDialogRef = useTemplateRef<HTMLElement>('revealDialogRef')

function clearSecret(): void {
  revealDialogOpen.value = false
  revealed.value = false
  secret.value = null
  aiPromptOrganizations.value = []
  aiPromptSkippedOrganizations.value = []
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
  destination.value = await resolveDestination()
  state.value = 'success'
  clearSecret()
  clearChannels()
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
  const session = route.query.session
  if (!aiMode.value && !isValidCliLoginSession(session)) {
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
    const eligibleIds = new Set(result.eligibleOrgIds)
    aiPromptOrganizations.value = organizationStore.organizations
      .filter(organization => eligibleIds.has(organization.gid))
      .map(organization => ({
        id: organization.gid,
        name: organization.name,
        apps: organizationStore.getAppsByOrgId(organization.gid).map(app => ({
          appId: app.app_id,
          name: app.name,
        })),
      }))
    aiPromptSkippedOrganizations.value = organizationStore.organizations
      .filter(organization => !eligibleIds.has(organization.gid))
      .map(organization => ({ id: organization.gid, name: organization.name }))
    secret.value = result.secret
    reused.value = result.reused
    hashed.value = result.policy.hashed
    expiresAt.value = result.policy.expiresAt
    if (aiMode.value) {
      showReadyUnlessCompleted()
      return
    }
    if (!isValidCliLoginSession(session))
      throw new Error('Missing CLI login session')
    const connections = await subscribe(result.eligibleOrgIds, session)
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

async function copyAiPrompt(): Promise<void> {
  if (!aiPrompt.value)
    return
  try {
    await navigator.clipboard.writeText(aiPrompt.value)
    toast.success(t('cli-login-ai-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
  }
}

function toggleReveal(): void {
  if (revealed.value) {
    revealed.value = false
    return
  }
  revealDialogOpen.value = true
}

function closeRevealDialog(): void {
  revealDialogOpen.value = false
}

function getRevealDialogFocusable(): HTMLElement[] {
  if (!revealDialogRef.value)
    return []
  return Array.from(revealDialogRef.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.offsetParent !== null)
}

function onRevealDialogKeydown(event: KeyboardEvent): void {
  if (!revealDialogOpen.value)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeRevealDialog()
    return
  }
  if (event.key !== 'Tab')
    return

  const focusable = getRevealDialogFocusable()
  if (focusable.length === 0)
    return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function confirmReveal(): void {
  revealed.value = true
  closeRevealDialog()
}

async function copyFromRevealDialog(): Promise<void> {
  await copyKey()
  closeRevealDialog()
}

function goToDestination(): void {
  void router.push(destination.value)
}

function showReadyUnlessCompleted(): void {
  if (state.value !== 'success')
    state.value = 'ready'
}

watch(revealDialogOpen, async (open) => {
  if (open) {
    window.addEventListener('keydown', onRevealDialogKeydown)
    await nextTick()
    getRevealDialogFocusable()[0]?.focus()
  }
  else {
    window.removeEventListener('keydown', onRevealDialogKeydown)
    await nextTick()
    revealButtonRef.value?.focus()
  }
})

onMounted(prepare)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onRevealDialogKeydown)
  clearSecret()
  clearChannels()
})
</script>

<template>
  <main class="flex min-h-full items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
    <section class="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-8">
      <header class="mb-6 flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-primary dark:bg-orange-950/40">
          <IconSparkles v-if="aiMode" class="h-5 w-5" />
          <IconKey v-else class="h-5 w-5" />
        </span>
        <h1 class="text-2xl font-semibold text-slate-950 dark:text-white">
          {{ t(aiMode ? 'cli-login-ai-title' : 'cli-login-title') }}
        </h1>
      </header>

      <div v-if="state === 'preparing'" role="status" class="flex items-center gap-3 text-slate-600 dark:text-slate-300">
        <span class="d-loading d-loading-spinner d-loading-md text-primary" aria-hidden="true" />
        <span>{{ t('cli-login-preparing') }}</span>
      </div>

      <div v-else-if="state === 'direct'" class="space-y-4">
        <h2 class="text-lg font-semibold">
          {{ t('cli-login-direct-title') }}
        </h2>
        <p>{{ t('cli-login-direct-description') }}</p>
        <button class="d-btn" type="button" @click="router.push('/dashboard')">
          {{ t('dashboard') }}
        </button>
      </div>

      <div v-else-if="state === 'empty'" class="space-y-4">
        <p class="d-alert d-alert-warning">
          {{ t('cli-login-no-eligible') }}
        </p>
        <p v-if="skippedNames.length" class="text-sm">
          {{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}
        </p>
        <button class="d-btn" type="button" @click="router.push('/dashboard')">
          {{ t('dashboard') }}
        </button>
      </div>

      <div v-else-if="state === 'ready'" class="space-y-5">
        <template v-if="aiMode">
          <p class="text-slate-600 dark:text-slate-300">
            {{ t('cli-login-ai-description') }}
          </p>
          <div class="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-900/60">
            <div class="flex items-start gap-3">
              <IconSparkles class="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('cli-login-ai-caption') }}
              </p>
            </div>
            <button class="d-btn d-btn-primary mt-5 w-full" type="button" @click="copyAiPrompt">
              <IconClipboard class="h-4 w-4" /> {{ t('cli-login-ai-copy') }}
            </button>
          </div>
          <p class="d-alert d-alert-warning text-sm">
            {{ t('cli-login-ai-security-warning') }}
          </p>
        </template>
        <template v-else>
          <p class="text-slate-600 dark:text-slate-300">
            {{ t('cli-login-paste-instruction') }}
          </p>
          <div class="flex flex-col gap-3 rounded-2xl border border-slate-200 p-3 sm:flex-row sm:items-center dark:border-slate-700">
            <code :class="revealed ? '' : 'select-none blur-[5px]'" class="min-w-0 flex-1 whitespace-normal break-all">{{ displayedKey }}</code>
            <div class="flex shrink-0 items-center gap-2 self-end sm:self-center">
              <button
                ref="revealButtonRef"
                class="d-btn d-btn-ghost d-btn-square d-btn-sm"
                type="button"
                :aria-label="t(revealed ? 'cli-login-hide-key' : 'cli-login-reveal-key')"
                :title="t(revealed ? 'cli-login-hide-key' : 'cli-login-reveal-key')"
                :aria-pressed="revealed"
                @click="toggleReveal"
              >
                <IconEyeSlash v-if="revealed" class="h-4 w-4" />
                <IconEye v-else class="h-4 w-4" />
              </button>
              <button class="d-btn d-btn-primary d-btn-sm" type="button" @click="copyKey">
                <IconClipboard class="h-4 w-4" /> {{ t('copy') }}
              </button>
            </div>
          </div>
          <p class="text-xs text-slate-500">
            {{ t('cli-login-copy-note') }}
          </p>
          <p class="d-alert d-alert-warning text-sm">
            {{ t('cli-login-security-warning') }}
          </p>
        </template>
        <p v-if="hashed" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-hashed-warning') }}
        </p>
        <p v-if="expiresAt" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-expiration-warning', { date: formatLocalDate(expiresAt) }) }}
        </p>
        <p v-if="skippedNames.length" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}
        </p>
        <output v-if="!aiMode" class="flex items-center text-sm" :class="realtimeUnavailable ? 'text-amber-700' : 'text-slate-500'">
          <template v-if="realtimeUnavailable">
            {{ t('cli-login-realtime-unavailable') }}
          </template>
          <template v-else>
            <span>{{ t('cli-login-waiting') }}</span>
            <span class="d-loading d-loading-dots d-loading-xs ml-1" aria-hidden="true" />
          </template>
        </output>
        <p v-if="reused" class="flex items-start gap-1.5 pt-1 text-xs text-slate-400 dark:text-slate-500">
          <span aria-hidden="true">*</span>
          <span>{{ t('cli-login-reused') }}</span>
        </p>
      </div>

      <div v-else-if="state === 'success'" class="space-y-5 text-center">
        <IconCheckCircle class="mx-auto h-12 w-12 text-emerald-500" />
        <h2 class="text-xl font-semibold">
          {{ t('cli-login-success-title') }}
        </h2>
        <button class="d-btn d-btn-primary" type="button" @click="goToDestination">
          {{ t(destination.startsWith('/app/new') ? 'cli-login-continue-setup' : 'dashboard') }}
        </button>
      </div>

      <div v-else class="space-y-4">
        <p class="d-alert d-alert-error">
          {{ t('cli-login-error') }}
        </p>
        <div class="flex gap-2">
          <button class="d-btn d-btn-primary" type="button" @click="prepare">
            {{ t('retry') }}
          </button>
          <button class="d-btn" type="button" @click="router.push('/dashboard')">
            {{ t('dashboard') }}
          </button>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="revealDialogOpen"
        class="d-modal d-modal-open z-50"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-login-reveal-dialog-title"
        aria-describedby="cli-login-reveal-dialog-description"
      >
        <div ref="revealDialogRef" class="d-modal-box w-[calc(100vw-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800">
          <h2 id="cli-login-reveal-dialog-title" class="text-xl font-semibold text-slate-950 dark:text-white">
            {{ t('cli-login-reveal-dialog-title') }}
          </h2>
          <p id="cli-login-reveal-dialog-description" class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('cli-login-reveal-dialog-description') }}
          </p>
          <div class="d-modal-action flex-wrap">
            <button class="d-btn d-btn-ghost" type="button" @click="closeRevealDialog">
              {{ t('cancel') }}
            </button>
            <button class="d-btn" type="button" @click="copyFromRevealDialog">
              <IconClipboard class="h-4 w-4" /> {{ t('copy') }}
            </button>
            <button class="d-btn d-btn-primary" type="button" @click="confirmReveal">
              <IconEye class="h-4 w-4" /> {{ t('cli-login-reveal-key') }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="d-modal-backdrop bg-black/50"
          :aria-label="t('cancel')"
          @click="closeRevealDialog"
        />
      </div>
    </Teleport>
  </main>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
