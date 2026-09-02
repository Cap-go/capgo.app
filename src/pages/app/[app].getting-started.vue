<script setup lang="ts">
import type { GettingStartedStep } from '~/utils/appOnboardingProgress'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconCheck from '~icons/lucide/check'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import GettingStartedCicdPanel from '~/components/dashboard/GettingStartedCicdPanel.vue'
import GettingStartedCliPanel from '~/components/dashboard/GettingStartedCliPanel.vue'
import { useAppPage } from '~/composables/useAppPage'
import { isTerminalAppOnboarding } from '~/services/appOnboarding'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import {
  areGettingStartedEssentialsDone,
  buildGettingStartedSteps,
  gettingStartedProgress,
  parseAppOnboardingLedger,
} from '~/utils/appOnboardingProgress'
import { isCicdSetupValidated } from '~/utils/gettingStartedCicd'
import {
  isStoreReleaseValidated,
  markStoreReleaseValidated,
} from '~/utils/gettingStartedDismiss'
import { liveUpdateUploadPath } from '~/utils/gettingStartedLiveUpdate'

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const { id, app, isLoading } = useAppPage({
  routeName: '/app/[app].getting-started',
  navTitle: t('getting-started'),
})

const storeModal = useTemplateRef<{ openModal: () => void }>('storeModal')
const builderModalOpen = ref(false)
const builderDone = ref(false)
let builderReqToken = 0

const orgApp = computed(() => id.value ? organizationStore.getAppByAppId(id.value) : undefined)
const appName = computed(() => app.value?.name || orgApp.value?.name || id.value)
const appIcon = computed(() => orgApp.value?.icon_url || '')
const iconLoading = computed(() => orgApp.value?.icon_url_loading === true)

const ledger = computed(() => parseAppOnboardingLedger(app.value?.onboarding))
const userId = computed(() => main.user?.id ?? main.auth?.id ?? '')
const cliSetupCompleted = ref(isTerminalAppOnboarding(app.value?.onboarding))
const steps = computed(() => buildGettingStartedSteps(ledger.value, {
  builderDone: builderDone.value,
  storeReleaseValidated: isStoreReleaseValidated(userId.value, id.value),
  cicdSetupValidated: isCicdSetupValidated(userId.value, id.value),
  cliSetupCompleted: cliSetupCompleted.value,
}))
const progress = computed(() => gettingStartedProgress(steps.value))
const focusedStepId = computed(() => steps.value.find(step => step.group === 'essential' && !step.done)?.id)
const stepGroups = computed(() => {
  const essential = steps.value.filter(step => step.group === 'essential')
  const grow = steps.value.filter(step => step.group === 'grow')
  return [
    { id: 'essential', titleKey: 'getting-started-essential', steps: essential, doneCount: essential.filter(step => step.done).length },
    { id: 'grow', titleKey: 'getting-started-grow', steps: grow, doneCount: grow.filter(step => step.done).length },
  ]
})
const allDone = computed(() => areGettingStartedEssentialsDone(steps.value))

function acronym(name: string) {
  const trimmed = name.trim()
  if (!trimmed)
    return '?'
  const parts = trimmed.split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : (parts[0]?.[1] ?? '')
  return (first + second).toUpperCase()
}

function onCliInstallProgress(payload: { isTerminal: boolean }) {
  cliSetupCompleted.value = payload.isTerminal
}

watch(() => app.value?.onboarding, (value) => {
  if (isTerminalAppOnboarding(value))
    cliSetupCompleted.value = true
})

async function checkBuilderDone(appId: string) {
  const token = ++builderReqToken
  builderDone.value = false
  try {
    await organizationStore.awaitInitialLoad()
    const orgId = organizationStore.getOrgByAppId(appId)?.gid
    if (!orgId)
      return
    const { count, error } = await supabase
      .from('build_requests')
      .select('id', { count: 'exact', head: true })
      .eq('owner_org', orgId)
      .eq('app_id', appId)
      .in('status', ['succeeded', 'released'])
    if (token !== builderReqToken || error)
      return
    builderDone.value = (count ?? 0) > 0
  }
  catch (error) {
    console.error('Cannot load getting started builder status', error)
  }
}

function runStep(step: GettingStartedStep) {
  if (step.done)
    return
  if (step.id === 'live_update') {
    void router.push(liveUpdateUploadPath(id.value))
    return
  }
  if (step.id === 'store_release') {
    storeModal.value?.openModal()
    return
  }
  if (step.id === 'cicd')
    return
  builderModalOpen.value = true
}

function onStoreReleaseApplied(appId: string) {
  markStoreReleaseValidated(userId.value, appId)
}

watch(() => id.value, async (appId) => {
  if (!appId)
    return
  await organizationStore.awaitInitialLoad()
  const appOrganization = organizationStore.getOrgByAppId(appId)
  if (appOrganization && organizationStore.currentOrganization?.gid !== appOrganization.gid)
    organizationStore.setCurrentOrganization(appOrganization.gid)
  void checkBuilderDone(appId)
}, { immediate: true })
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <div v-if="app" class="mx-auto max-w-3xl px-4 py-6 sm:px-0" data-test="getting-started-page">
      <div
        v-if="allDone"
        class="mb-6 flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/40"
        role="status"
      >
        <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
          <IconCheck class="size-3.5" />
        </span>
        <div>
          <p class="font-semibold text-emerald-900 dark:text-emerald-100">
            {{ t('getting-started-complete') }}
          </p>
          <p class="text-sm text-emerald-800 dark:text-emerald-200">
            {{ t('getting-started-complete-desc') }}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <img
          v-if="appIcon"
          :src="appIcon"
          :alt="`${appName} icon`"
          class="size-12 rounded-lg object-cover d-mask d-mask-squircle"
          width="48"
          height="48"
        >
        <span
          v-else-if="iconLoading"
          class="flex size-12 items-center justify-center rounded-lg bg-slate-200 dark:bg-slate-800 d-mask d-mask-squircle"
        >
          <span class="size-5 rounded-full border-2 border-azure-500 border-t-transparent animate-spin" />
          <span class="sr-only">{{ t('loading') }}</span>
        </span>
        <span
          v-else
          class="flex size-12 items-center justify-center rounded-lg bg-slate-200 text-lg font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200 d-mask d-mask-squircle"
          aria-hidden="true"
        >
          {{ acronym(appName) }}
        </span>
        <div class="min-w-0">
          <p class="truncate text-lg font-semibold text-slate-950 dark:text-white">
            {{ appName }}
          </p>
          <p class="truncate font-mono text-sm text-slate-500 dark:text-slate-400">
            {{ id }}
          </p>
        </div>
      </div>

      <div class="mt-6 flex items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-slate-950 dark:text-white">
            {{ t('getting-started') }}
          </h1>
          <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('getting-started-description') }}
          </p>
        </div>
        <p class="shrink-0 tabular-nums text-sm font-medium text-slate-500 dark:text-slate-400">
          {{ t('getting-started-count', { done: progress.done, total: progress.total }) }}
        </p>
      </div>

      <div class="mt-4">
        <div class="mb-1 flex justify-end">
          <span class="tabular-nums text-xs font-semibold text-azure-700 dark:text-azure-300">
            {{ t('getting-started-percent', { percent: progress.percent }) }}
          </span>
        </div>
        <div
          class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          role="progressbar"
          :aria-valuenow="progress.percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('getting-started-count', { done: progress.done, total: progress.total })"
        >
          <div
            class="h-full rounded-full bg-azure-500 transition-transform duration-200 ease-out motion-reduce:transition-none"
            :style="{ transform: `scaleX(${progress.percent / 100})`, transformOrigin: 'left center' }"
          />
        </div>
      </div>

      <section
        v-for="(group, index) in stepGroups"
        :key="group.id"
        :class="index === 0 ? 'mt-8' : 'mt-6'"
      >
        <details class="group" open>
          <summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-2 text-sm font-semibold uppercase tracking-wide text-slate-500 marker:content-none focus:outline-none focus:ring-2 focus:ring-azure-500 dark:text-slate-400 [&::-webkit-details-marker]:hidden">
            <span class="flex items-center gap-2">
              <IconCheck
                v-if="group.doneCount === group.steps.length"
                class="size-4 text-emerald-600 dark:text-emerald-300"
              />
              {{ t(group.titleKey) }}
              {{ group.doneCount }}/{{ group.steps.length }}
            </span>
          </summary>
          <ul class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white shadow-sm dark:divide-white/10 dark:border-white/10 dark:bg-slate-800 dark:shadow-none dark:inset-ring dark:inset-ring-white/5">
            <li
              v-for="step in group.steps"
              :key="step.id"
              class="px-4 py-3"
              :class="step.id === focusedStepId ? 'bg-azure-50/70 dark:bg-azure-950/20' : ''"
              :data-test="`getting-started-step-${step.id}`"
            >
              <div class="flex items-center gap-3">
                <span
                  class="flex size-6 shrink-0 items-center justify-center rounded-full"
                  :class="step.done ? 'bg-emerald-600 text-white' : 'border-2 border-slate-300 dark:border-slate-600'"
                  :aria-hidden="true"
                >
                  <IconCheck v-if="step.done" class="size-3.5" />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="font-semibold text-slate-950 dark:text-white">
                    {{ t(step.titleKey) }}
                  </p>
                  <p class="text-sm leading-5 text-slate-500 dark:text-slate-400">
                    {{ t(step.descKey) }}
                  </p>
                </div>
                <span
                  v-if="step.done"
                  class="shrink-0 text-sm font-medium text-slate-400 dark:text-slate-500"
                >
                  {{ t('getting-started-done') }}
                </span>
                <button
                  v-else-if="step.id !== 'cicd' && step.id !== 'cli_install'"
                  type="button"
                  class="d-btn d-btn-ghost d-btn-sm h-11 min-h-11 shrink-0 px-3 text-azure-700 dark:text-azure-300"
                  data-test="getting-started-step-action"
                  @click="runStep(step)"
                >
                  {{ t(step.actionKey) }}
                </button>
              </div>
              <p
                v-if="step.id === 'cli_install' && step.done"
                class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300"
              >
                {{ t('getting-started-self-test-hint') }}
              </p>
              <GettingStartedCliPanel
                v-if="step.id === 'cli_install'"
                :key="id"
                :app-id="id"
                :app-name="appName"
                :existing-app="app.existing_app"
                :initial-onboarding="app.onboarding"
                @progress="onCliInstallProgress"
              />
              <GettingStartedCicdPanel
                v-if="step.id === 'cicd' && !step.done && userId"
                :app-id="id"
                :user-id="userId"
              />
            </li>
          </ul>
        </details>
      </section>
    </div>

    <StoreReleaseValidationModal
      v-if="id"
      ref="storeModal"
      :app-id="id"
      @applied="onStoreReleaseApplied"
    />
    <BuilderPresentationModal
      :open="builderModalOpen"
      :app-id="id"
      @close="builderModalOpen = false"
    />
  </AppPageFrame>
</template>
