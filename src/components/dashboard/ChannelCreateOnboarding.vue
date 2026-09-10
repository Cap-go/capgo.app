<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconCircleCheck from '~icons/lucide/circle-check-big'
import IconGitBranch from '~icons/lucide/git-branch'
import IconGlobe from '~icons/lucide/globe-2'
import IconLoader from '~icons/lucide/loader-2'
import IconServer from '~icons/lucide/server'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconUsers from '~icons/lucide/users-round'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  appId: string
}>()

const emit = defineEmits<(event: 'continue') => void>()

interface SavedChannel {
  name: string
  public: boolean
  allow_device_self_set: boolean
}

const CHANNEL_NAME_PATTERN = /^[\w.-]+$/
const suggestedNames = ['production', 'beta', 'development'] as const
const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const channelName = ref('')
const allowSelfAssign = ref(true)
const isInitializing = ref(true)
const isSubmitting = ref(false)
const hasRequiredPermissions = ref(false)
const showNameError = ref(false)
const submitError = ref('')
const completedChannel = ref<SavedChannel | null>(null)
const createdInOnboarding = ref(false)
const currentOrganization = computed(() => organizationStore.currentOrganization)
const normalizedChannelName = computed(() => channelName.value.trim())
const channelPreviewName = computed(() => normalizedChannelName.value || t('channel-create-onboarding-preview-placeholder'))
const channelNameError = computed(() => {
  if (!normalizedChannelName.value)
    return t('channel-create-onboarding-name-required')
  if (!CHANNEL_NAME_PATTERN.test(normalizedChannelName.value))
    return t('channel-create-onboarding-name-invalid')
  return ''
})
const canSubmit = computed(() => (
  hasRequiredPermissions.value
  && !isInitializing.value
  && !isSubmitting.value
  && !channelNameError.value
))

function selectSuggestedName(name: typeof suggestedNames[number]) {
  channelName.value = name
  showNameError.value = false
  submitError.value = ''
}

async function loadExistingChannel() {
  const { data, error } = await supabase
    .from('channels')
    .select('name, public, allow_device_self_set')
    .eq('app_id', props.appId)
    .eq('public', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error)
    throw error

  if (data)
    completedChannel.value = data
}

async function initialize() {
  isInitializing.value = true
  submitError.value = ''
  try {
    await organizationStore.awaitInitialLoad()
    await loadExistingChannel()
    if (completedChannel.value)
      return

    // Creating a public/default channel is guarded by both permissions in the channels INSERT policy.
    const [canCreateChannel, canUpdateAppSettings] = await Promise.all([
      checkPermissions('app.create_channel', { appId: props.appId }),
      checkPermissions('app.update_settings', { appId: props.appId }),
    ])
    hasRequiredPermissions.value = canCreateChannel && canUpdateAppSettings
  }
  catch (error) {
    console.error('Cannot prepare onboarding channel creation', error)
    submitError.value = t('channel-create-onboarding-load-error')
  }
  finally {
    isInitializing.value = false
  }
}

async function createChannel() {
  showNameError.value = true
  submitError.value = ''
  if (!canSubmit.value)
    return

  if (!main.user || !currentOrganization.value?.gid) {
    submitError.value = t('channel-create-onboarding-load-error')
    return
  }

  const normalizedName = normalizedChannelName.value
  isSubmitting.value = true
  try {
    const { data: existingChannel, error: existingError } = await supabase
      .from('channels')
      .select('name, public, allow_device_self_set')
      .eq('app_id', props.appId)
      .eq('name', normalizedName)
      .order('public', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingError)
      throw existingError

    if (existingChannel) {
      if (existingChannel.public)
        completedChannel.value = existingChannel
      else
        submitError.value = t('channel-create-onboarding-name-taken')
      return
    }

    const { error } = await supabase
      .from('channels')
      .insert({
        name: normalizedName,
        app_id: props.appId,
        owner_org: currentOrganization.value.gid,
        created_by: main.user.id,
        public: true,
        allow_device_self_set: allowSelfAssign.value,
        version: null,
      })

    if (error)
      throw error

    // Avoid coupling a successful INSERT to channel-read RLS on the response row.
    completedChannel.value = {
      name: normalizedName,
      public: true,
      allow_device_self_set: allowSelfAssign.value,
    }
    createdInOnboarding.value = true
  }
  catch (error) {
    console.error('Cannot create onboarding channel', error)
    submitError.value = t('channel-create-onboarding-submit-error')
  }
  finally {
    isSubmitting.value = false
  }
}

onMounted(() => {
  void initialize()
})
</script>

<template>
  <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-white/15 dark:bg-slate-900/95" data-test="channel-create-onboarding">
    <header class="flex flex-col gap-4 border-b border-slate-200 px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-7 dark:border-white/10">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-primary-500 dark:text-sky-300">
          {{ t('channel-create-onboarding-kicker') }}
        </p>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-[1.75rem] dark:text-white">
          {{ t('channel-create-onboarding-title') }}
        </h2>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('channel-create-onboarding-description') }}
        </p>
      </div>
      <span class="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-slate-950 dark:text-slate-300">
        <IconGitBranch class="h-3.5 w-3.5 text-primary-500" />
        {{ appId }}
      </span>
    </header>

    <div v-if="isInitializing" class="flex min-h-[25rem] items-center justify-center gap-3 text-sm text-slate-500" role="status">
      <IconLoader class="h-5 w-5 animate-spin text-primary-500" />
      {{ t('channel-create-onboarding-loading') }}
    </div>

    <div v-else-if="completedChannel" class="grid min-h-[25rem] lg:grid-cols-[1.05fr_0.95fr]" data-test="channel-create-success">
      <div class="relative isolate flex items-center overflow-hidden bg-slate-950 px-6 py-8 text-white sm:px-10">
        <div class="absolute inset-0 -z-10 opacity-70" aria-hidden="true">
          <div class="absolute left-[-4rem] top-[-6rem] h-72 w-72 rounded-full bg-primary-500/20 blur-3xl" />
          <div class="absolute bottom-[-8rem] right-[-3rem] h-72 w-72 rounded-full bg-emerald-400/15 blur-3xl" />
        </div>
        <div class="mx-auto w-full max-w-lg">
          <span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-400/20">
            <IconCircleCheck class="h-7 w-7" />
          </span>
          <p class="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">
            {{ createdInOnboarding ? t('channel-create-onboarding-created-label') : t('channel-create-onboarding-existing-label') }}
          </p>
          <h3 class="mt-2 text-3xl font-semibold tracking-tight">
            {{ t('channel-create-onboarding-success-title') }}
          </h3>
          <p class="mt-3 max-w-md text-sm leading-6 text-slate-300">
            {{ t('channel-create-onboarding-success-description') }}
          </p>
        </div>
      </div>

      <div class="flex flex-col justify-center px-6 py-8 sm:px-10">
        <div class="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5 dark:border-emerald-400/25 dark:bg-emerald-400/10">
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <p class="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                {{ t('channel-create-onboarding-channel-label') }}
              </p>
              <p class="mt-1 truncate font-mono text-xl font-semibold text-slate-950 dark:text-white">
                {{ completedChannel.name }}
              </p>
            </div>
            <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white">
              <IconGitBranch class="h-5 w-5" />
            </span>
          </div>
          <div class="mt-5 grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-emerald-200/80 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/50">
              <p class="text-xs text-slate-500 dark:text-slate-400">
                {{ t('channel-create-onboarding-default-title') }}
              </p>
              <p class="mt-1 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
                <IconCheck class="h-4 w-4 text-emerald-500" />
                {{ completedChannel.public ? t('enabled') : t('disabled') }}
              </p>
            </div>
            <div class="rounded-xl border border-emerald-200/80 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/50">
              <p class="text-xs text-slate-500 dark:text-slate-400">
                {{ t('channel-create-onboarding-self-assign-short') }}
              </p>
              <p class="mt-1 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
                <IconCheck v-if="completedChannel.allow_device_self_set" class="h-4 w-4 text-emerald-500" />
                {{ completedChannel.allow_device_self_set ? t('enabled') : t('disabled') }}
              </p>
            </div>
          </div>
        </div>

        <button type="button" class="d-btn mt-6 min-h-12 w-full border-0 bg-primary-500 text-white hover:bg-primary-600" data-test="channel-create-continue" @click="emit('continue')">
          {{ t('channel-create-onboarding-continue') }}
          <IconArrowRight class="h-4 w-4" />
        </button>
      </div>
    </div>

    <div v-else class="grid min-h-[25rem] lg:grid-cols-[1.05fr_0.95fr]">
      <aside class="relative isolate overflow-hidden border-b border-slate-200 bg-slate-50 px-6 py-7 sm:px-8 lg:border-b-0 lg:border-r dark:border-white/10 dark:bg-slate-950 dark:text-white">
        <div class="absolute inset-0 -z-10 opacity-70" aria-hidden="true">
          <div class="absolute right-[-6rem] top-[-7rem] h-72 w-72 rounded-full bg-primary-500/15 blur-3xl dark:bg-primary-500/25" />
          <div class="absolute bottom-[-8rem] left-[-4rem] h-72 w-72 rounded-full bg-sky-400/10 blur-3xl" />
        </div>
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-primary-600 dark:text-sky-300">
          {{ t('channel-create-onboarding-preview-label') }}
        </p>
        <div class="mt-5 grid grid-cols-[2.75rem_1fr_3rem_1fr_7rem] items-center gap-2" aria-hidden="true">
          <span class="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-sky-600 dark:border-white/10 dark:bg-white/10 dark:text-sky-200">
            <IconSmartphone class="h-5 w-5" />
          </span>
          <span class="h-px bg-gradient-to-r from-sky-400/40 to-sky-400" />
          <span class="flex h-12 w-12 items-center justify-center justify-self-center rounded-xl bg-primary-500 text-white shadow-lg shadow-primary-500/25">
            <IconServer class="h-5 w-5" />
          </span>
          <span class="h-px bg-gradient-to-r from-primary-400 to-emerald-400" />
          <span class="flex h-11 w-11 items-center justify-center justify-self-center rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-300/30 dark:bg-emerald-400/15 dark:text-emerald-200">
            <IconGitBranch class="h-5 w-5 shrink-0" />
          </span>
        </div>
        <div class="mt-3 grid grid-cols-[2.75rem_1fr_3rem_1fr_7rem] items-start gap-2 text-center text-[0.68rem] font-medium text-slate-500 dark:text-slate-400">
          <span>{{ t('device') }}</span>
          <span />
          <span>{{ t('channel-create-onboarding-capgo') }}</span>
          <span />
          <span class="truncate font-mono text-emerald-600 dark:text-emerald-300">{{ channelPreviewName }}</span>
        </div>

        <div class="mt-7 space-y-3">
          <div class="flex gap-3 rounded-xl border border-slate-200 bg-white p-3.5 dark:border-white/10 dark:bg-white/[0.06]">
            <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300">
              <IconGlobe class="h-4 w-4" />
            </span>
            <div>
              <p class="text-sm font-semibold text-slate-900 dark:text-white">
                {{ t('channel-create-onboarding-default-title') }}
              </p>
              <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {{ t('channel-create-onboarding-default-description') }}
              </p>
            </div>
            <IconCheck class="ml-auto mt-1 h-4 w-4 shrink-0 text-emerald-500 dark:text-emerald-300" />
          </div>
          <div class="flex gap-3 rounded-xl border border-slate-200 bg-white p-3.5 dark:border-white/10 dark:bg-white/[0.06]">
            <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300">
              <IconUsers class="h-4 w-4" />
            </span>
            <div>
              <p class="text-sm font-semibold text-slate-900 dark:text-white">
                {{ t(allowSelfAssign ? 'channel-create-onboarding-self-assign-title' : 'channel-create-onboarding-self-assign-disallow-title') }}
              </p>
              <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {{ t(allowSelfAssign ? 'channel-create-onboarding-self-assign-description' : 'channel-create-onboarding-self-assign-disallow-description') }}
              </p>
            </div>
            <IconCheck v-if="allowSelfAssign" class="ml-auto mt-1 h-4 w-4 shrink-0 text-emerald-500 dark:text-emerald-300" />
          </div>
        </div>
      </aside>

      <form class="flex flex-col justify-center px-6 py-7 sm:px-8" @submit.prevent="createChannel">
        <div>
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-white">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-500/10 text-primary-600 dark:bg-primary-400/15 dark:text-primary-300">
              <IconSparkles class="h-4 w-4" />
            </span>
            {{ t('channel-create-onboarding-form-title') }}
          </div>

          <label for="onboarding-channel-name" class="mt-5 block text-sm font-semibold text-slate-800 dark:text-slate-100">
            {{ t('channel-name') }}
          </label>
          <div class="relative mt-2">
            <IconGitBranch class="pointer-events-none absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="onboarding-channel-name"
              v-model="channelName"
              type="text"
              autocomplete="off"
              class="d-input h-12 w-full border-slate-300 bg-white pl-10 font-mono text-sm text-slate-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/15 dark:bg-slate-950 dark:text-white"
              :class="showNameError && channelNameError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : ''"
              :placeholder="t('channel-create-onboarding-name-placeholder')"
              :aria-invalid="showNameError && Boolean(channelNameError)"
              aria-describedby="onboarding-channel-name-help"
              data-test="channel-create-name"
              @input="submitError = ''"
              @blur="showNameError = true"
            >
          </div>
          <p id="onboarding-channel-name-help" class="mt-2 min-h-5 text-xs" :class="showNameError && channelNameError ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'">
            {{ showNameError && channelNameError ? channelNameError : t('channel-create-onboarding-name-help') }}
          </p>

          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="name in suggestedNames"
              :key="name"
              type="button"
              class="rounded-full border px-3 py-1.5 font-mono text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              :class="normalizedChannelName === name ? 'border-primary-500 bg-primary-500 text-white' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:text-slate-950 dark:border-white/10 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-white/20 dark:hover:text-white'"
              @click="selectSuggestedName(name)"
            >
              {{ name }}
              <span v-if="name === 'production'" class="ml-1 opacity-70">· {{ t('recommended') }}</span>
            </button>
          </div>

          <label class="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 transition hover:border-violet-300 dark:border-white/10 dark:bg-slate-950/70 dark:hover:border-violet-400/40">
            <input v-model="allowSelfAssign" type="checkbox" class="d-checkbox d-checkbox-primary mt-0.5 h-4.5 w-4.5 shrink-0">
            <span>
              <span class="block text-sm font-semibold text-slate-900 dark:text-white">{{ t(allowSelfAssign ? 'channel-create-onboarding-self-assign-title' : 'channel-create-onboarding-self-assign-disallow-title') }}</span>
              <span class="mt-1 block min-h-10 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ t(allowSelfAssign ? 'channel-create-onboarding-toggle-description' : 'channel-create-onboarding-self-assign-disallow-description') }}</span>
            </span>
          </label>

          <p v-if="submitError" class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200" role="alert">
            {{ submitError }}
          </p>
          <p v-else-if="!hasRequiredPermissions" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200" role="alert">
            {{ t('no-permission') }}
          </p>
        </div>

        <button type="submit" class="d-btn mt-5 min-h-12 w-full border-0 bg-primary-500 text-white hover:bg-primary-600 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-700 dark:disabled:text-slate-400" data-test="channel-create-submit" :disabled="!canSubmit">
          <IconLoader v-if="isSubmitting" class="h-4 w-4 animate-spin" />
          <template v-else>
            {{ t('channel-create-onboarding-submit') }}
            <IconArrowRight class="h-4 w-4" />
          </template>
        </button>
      </form>
    </div>
  </section>
</template>
