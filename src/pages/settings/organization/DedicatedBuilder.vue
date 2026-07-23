<script setup lang="ts">
import type { DedicatedBuilder } from '~/services/dedicatedBuilder'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCheck from '~icons/heroicons/check-circle'
import IconClock from '~icons/heroicons/clock'
import IconCpu from '~icons/heroicons/cpu-chip'
import IconServer from '~icons/heroicons/server-stack'
import IconSparkles from '~icons/heroicons/sparkles'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import Spinner from '~/components/Spinner.vue'
import { formatLocalDateTime } from '~/services/date'
import {
  fetchDedicatedBuilder,
  requestDedicatedBuilder,
  updateDedicatedBuilder,
} from '~/services/dedicatedBuilder'
import { checkPermissions } from '~/services/permissions'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()
const { currentOrganization } = storeToRefs(organizationStore)

displayStore.NavTitle = t('dedicated-builder')

const isLoading = ref(true)
const isSubmitting = ref(false)
const isSavingFallback = ref(false)
const showAdminModal = ref(false)
const dedicatedBuilder = ref<DedicatedBuilder | null>(null)

const useCase = ref('')
const monthlyBuildsEstimate = ref<number | null>(null)
const platformIos = ref(true)
const platformAndroid = ref(true)

const canReadBilling = computedAsync(async () => {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.read_billing', { orgId })
}, false)

const canUpdateBilling = computedAsync(async () => {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_billing', { orgId })
}, false)

const status = computed(() => dedicatedBuilder.value?.status ?? null)
const isPending = computed(() => status.value === 'requested' || status.value === 'provisioning')
const isActive = computed(() => status.value === 'active')
const showRequestForm = computed(() => !dedicatedBuilder.value || status.value === 'cancelled')

const workerStatusLabel = computed(() => {
  const workerStatus = dedicatedBuilder.value?.worker_status
  if (!workerStatus || workerStatus === 'unknown')
    return t('dedicated-builder-worker-unknown')
  return t(`dedicated-builder-worker-${workerStatus}`)
})

const workerStatusClass = computed(() => {
  switch (dedicatedBuilder.value?.worker_status) {
    case 'idle':
      return 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30'
    case 'busy':
      return 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30'
    case 'offline':
      return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30'
    default:
      return 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800'
  }
})

async function loadDedicatedBuilder() {
  const orgId = currentOrganization.value?.gid
  if (!orgId || !canReadBilling.value) {
    dedicatedBuilder.value = null
    isLoading.value = false
    return
  }

  isLoading.value = true
  try {
    dedicatedBuilder.value = await fetchDedicatedBuilder(orgId)
  }
  catch (error) {
    console.error('Failed to load dedicated builder', error)
    toast.error(t('dedicated-builder-load-error'))
  }
  finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  await organizationStore.dedupFetchOrganizations()
  await loadDedicatedBuilder()
})

watch(currentOrganization, async () => {
  await loadDedicatedBuilder()
})

watch(canReadBilling, async (allowed) => {
  if (allowed)
    await loadDedicatedBuilder()
})

async function submitRequest() {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return

  if (!canUpdateBilling.value) {
    showAdminModal.value = true
    return
  }

  if (!platformIos.value && !platformAndroid.value) {
    toast.error(t('dedicated-builder-platforms-required'))
    return
  }

  isSubmitting.value = true
  try {
    const platforms = [
      ...(platformIos.value ? ['ios'] : []),
      ...(platformAndroid.value ? ['android'] : []),
    ]
    dedicatedBuilder.value = await requestDedicatedBuilder({
      orgId,
      useCase: useCase.value.trim() || undefined,
      monthlyBuildsEstimate: monthlyBuildsEstimate.value,
      platforms,
    })
    toast.success(t('dedicated-builder-request-success'))
  }
  catch (error: any) {
    console.error('Failed to request dedicated builder', error)
    const message = error?.message?.includes('dedicated_builder_exists')
      ? t('dedicated-builder-already-exists')
      : t('dedicated-builder-request-error')
    toast.error(message)
  }
  finally {
    isSubmitting.value = false
  }
}

async function toggleFallback(nextValue: boolean) {
  const orgId = currentOrganization.value?.gid
  if (!orgId || !dedicatedBuilder.value)
    return

  if (!canUpdateBilling.value) {
    showAdminModal.value = true
    return
  }

  isSavingFallback.value = true
  try {
    dedicatedBuilder.value = await updateDedicatedBuilder(orgId, {
      allow_shared_fallback: nextValue,
    })
    toast.success(t('dedicated-builder-fallback-updated'))
  }
  catch (error) {
    console.error('Failed to update fallback', error)
    toast.error(t('dedicated-builder-fallback-error'))
  }
  finally {
    isSavingFallback.value = false
  }
}

function cancelRequest() {
  const orgId = currentOrganization.value?.gid
  if (!orgId || !dedicatedBuilder.value)
    return

  if (!canUpdateBilling.value) {
    showAdminModal.value = true
    return
  }

  dialogStore.openDialog({
    title: t('dedicated-builder-cancel-title'),
    description: t('dedicated-builder-cancel-description'),
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      {
        text: t('dedicated-builder-cancel-confirm'),
        role: 'danger',
        handler: async () => {
          try {
            dedicatedBuilder.value = await updateDedicatedBuilder(orgId, { cancel: true })
            toast.success(t('dedicated-builder-cancel-success'))
          }
          catch (error) {
            console.error('Failed to cancel dedicated builder', error)
            toast.error(t('dedicated-builder-cancel-error'))
          }
        },
      },
    ],
  })
}
</script>

<template>
  <div class="w-full max-w-4xl px-4 py-6 mx-auto sm:px-6 lg:px-8">
    <div class="mb-8">
      <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
        {{ t('dedicated-builder') }}
      </h1>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {{ t('dedicated-builder-page-subtitle') }}
      </p>
    </div>

    <div v-if="isLoading" class="flex justify-center py-16">
      <Spinner size="h-8 w-8" />
    </div>

    <template v-else>
      <!-- Benefits / empty state -->
      <section v-if="showRequestForm" class="space-y-6">
        <div class="p-6 border rounded-2xl border-slate-200 dark:border-slate-700 bg-gradient-to-br from-slate-50 to-sky-50 dark:from-slate-900 dark:to-slate-800">
          <div class="flex items-start gap-3">
            <div class="flex items-center justify-center w-10 h-10 rounded-xl bg-azure-500/10 text-azure-600 dark:text-azure-400">
              <IconServer class="w-5 h-5" />
            </div>
            <div>
              <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
                {{ t('dedicated-builder-hero-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {{ t('dedicated-builder-hero-desc') }}
              </p>
            </div>
          </div>

          <ul class="grid gap-3 mt-6 sm:grid-cols-3">
            <li class="p-3 rounded-xl bg-white/70 dark:bg-slate-900/50">
              <IconSparkles class="w-5 h-5 text-azure-500" />
              <p class="mt-2 text-sm font-medium text-slate-900 dark:text-white">
                {{ t('dedicated-builder-benefit-queue') }}
              </p>
            </li>
            <li class="p-3 rounded-xl bg-white/70 dark:bg-slate-900/50">
              <IconCpu class="w-5 h-5 text-azure-500" />
              <p class="mt-2 text-sm font-medium text-slate-900 dark:text-white">
                {{ t('dedicated-builder-benefit-worker') }}
              </p>
            </li>
            <li class="p-3 rounded-xl bg-white/70 dark:bg-slate-900/50">
              <IconCheck class="w-5 h-5 text-azure-500" />
              <p class="mt-2 text-sm font-medium text-slate-900 dark:text-white">
                {{ t('dedicated-builder-benefit-fallback') }}
              </p>
            </li>
          </ul>
        </div>

        <form class="p-6 space-y-5 border rounded-2xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900" @submit.prevent="submitRequest">
          <h3 class="text-base font-semibold text-slate-900 dark:text-white">
            {{ t('dedicated-builder-request-title') }}
          </h3>

          <div>
            <label for="dedicated-builder-use-case" class="label">
              <span class="label-text">{{ t('dedicated-builder-use-case') }}</span>
            </label>
            <textarea
              id="dedicated-builder-use-case"
              v-model="useCase"
              rows="3"
              class="w-full textarea textarea-bordered"
              :placeholder="t('dedicated-builder-use-case-placeholder')"
              :disabled="!canUpdateBilling || isSubmitting"
            />
          </div>

          <div>
            <label for="dedicated-builder-monthly" class="label">
              <span class="label-text">{{ t('dedicated-builder-monthly-estimate') }}</span>
            </label>
            <input
              id="dedicated-builder-monthly"
              v-model.number="monthlyBuildsEstimate"
              type="number"
              min="0"
              class="w-full input input-bordered"
              :placeholder="t('dedicated-builder-monthly-estimate-placeholder')"
              :disabled="!canUpdateBilling || isSubmitting"
            >
          </div>

          <fieldset>
            <legend class="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t('dedicated-builder-platforms') }}
            </legend>
            <div class="flex flex-wrap gap-4">
              <label class="inline-flex items-center gap-2 cursor-pointer">
                <input
                  v-model="platformIos"
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  :disabled="!canUpdateBilling || isSubmitting"
                >
                <span>{{ t('platform-ios') }}</span>
              </label>
              <label class="inline-flex items-center gap-2 cursor-pointer">
                <input
                  v-model="platformAndroid"
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  :disabled="!canUpdateBilling || isSubmitting"
                >
                <span>{{ t('platform-android') }}</span>
              </label>
            </div>
          </fieldset>

          <div class="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              class="d-btn d-btn-primary"
              :disabled="isSubmitting || !canUpdateBilling"
            >
              <Spinner v-if="isSubmitting" size="h-4 w-4" />
              {{ t('dedicated-builder-request-cta') }}
            </button>
            <button
              v-if="!canUpdateBilling"
              type="button"
              class="d-btn d-btn-ghost"
              @click="showAdminModal = true"
            >
              {{ t('dedicated-builder-need-permission') }}
            </button>
          </div>
        </form>
      </section>

      <!-- Pending / provisioning -->
      <section v-else-if="isPending" class="space-y-6">
        <div class="p-6 border rounded-2xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div class="flex items-start gap-3">
            <IconClock class="w-6 h-6 text-amber-500 shrink-0" />
            <div>
              <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
                {{ status === 'provisioning' ? t('dedicated-builder-provisioning-title') : t('dedicated-builder-requested-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {{ status === 'provisioning' ? t('dedicated-builder-provisioning-desc') : t('dedicated-builder-requested-desc') }}
              </p>
              <p v-if="dedicatedBuilder?.created_at" class="mt-3 text-xs text-slate-500">
                {{ t('dedicated-builder-requested-at', { date: formatLocalDateTime(dedicatedBuilder.created_at) }) }}
              </p>
            </div>
          </div>

          <ol class="mt-6 space-y-3">
            <li class="flex items-center gap-3 text-sm">
              <IconCheck class="w-5 h-5 text-green-500" />
              <span>{{ t('dedicated-builder-step-requested') }}</span>
            </li>
            <li class="flex items-center gap-3 text-sm" :class="status === 'provisioning' ? 'text-slate-900 dark:text-white' : 'text-slate-400'">
              <IconClock class="w-5 h-5" :class="status === 'provisioning' ? 'text-amber-500' : ''" />
              <span>{{ t('dedicated-builder-step-provisioning') }}</span>
            </li>
            <li class="flex items-center gap-3 text-sm text-slate-400">
              <IconServer class="w-5 h-5" />
              <span>{{ t('dedicated-builder-step-active') }}</span>
            </li>
          </ol>

          <div class="flex flex-wrap gap-3 mt-6">
            <button
              type="button"
              class="d-btn d-btn-ghost"
              :disabled="!canUpdateBilling"
              @click="cancelRequest"
            >
              {{ t('dedicated-builder-cancel-cta') }}
            </button>
          </div>
        </div>
      </section>

      <!-- Active worker -->
      <section v-else-if="isActive && dedicatedBuilder" class="space-y-6">
        <div class="p-6 border rounded-2xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex items-start gap-3">
              <div class="flex items-center justify-center w-10 h-10 rounded-xl bg-azure-500/10 text-azure-600">
                <IconServer class="w-5 h-5" />
              </div>
              <div>
                <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
                  {{ dedicatedBuilder.worker_name || t('dedicated-builder-your-worker') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {{ t('dedicated-builder-active-desc') }}
                </p>
              </div>
            </div>
            <span class="px-3 py-1 text-xs font-semibold rounded-full" :class="workerStatusClass">
              {{ workerStatusLabel }}
            </span>
          </div>

          <dl class="grid gap-4 mt-6 sm:grid-cols-2">
            <div>
              <dt class="text-xs uppercase tracking-wide text-slate-500">
                {{ t('dedicated-builder-pool-id') }}
              </dt>
              <dd class="mt-1 font-mono text-sm text-slate-900 dark:text-white">
                {{ dedicatedBuilder.pool_id || t('dedicated-builder-pool-pending') }}
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-slate-500">
                {{ t('dedicated-builder-active-builds') }}
              </dt>
              <dd class="mt-1 text-sm text-slate-900 dark:text-white">
                {{ dedicatedBuilder.active_dedicated_builds }}
              </dd>
            </div>
            <div v-if="dedicatedBuilder.activated_at">
              <dt class="text-xs uppercase tracking-wide text-slate-500">
                {{ t('dedicated-builder-activated-at') }}
              </dt>
              <dd class="mt-1 text-sm text-slate-900 dark:text-white">
                {{ formatLocalDateTime(dedicatedBuilder.activated_at) }}
              </dd>
            </div>
            <div v-if="dedicatedBuilder.platforms?.length">
              <dt class="text-xs uppercase tracking-wide text-slate-500">
                {{ t('dedicated-builder-platforms') }}
              </dt>
              <dd class="mt-1 text-sm text-slate-900 dark:text-white">
                {{ dedicatedBuilder.platforms.join(', ') }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="p-6 border rounded-2xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 class="text-base font-semibold text-slate-900 dark:text-white">
                {{ t('dedicated-builder-fallback-title') }}
              </h3>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {{ t('dedicated-builder-fallback-desc') }}
              </p>
            </div>
            <label class="inline-flex items-center gap-3 cursor-pointer">
              <span class="sr-only">{{ t('dedicated-builder-fallback-title') }}</span>
              <input
                type="checkbox"
                class="toggle toggle-primary"
                :checked="dedicatedBuilder.allow_shared_fallback"
                :disabled="!canUpdateBilling || isSavingFallback"
                :aria-label="t('dedicated-builder-fallback-title')"
                @change="toggleFallback(($event.target as HTMLInputElement).checked)"
              >
              <span class="text-sm text-slate-700 dark:text-slate-200">
                {{ dedicatedBuilder.allow_shared_fallback ? t('enabled') : t('disabled') }}
              </span>
            </label>
          </div>
        </div>

        <div class="p-6 border rounded-2xl border-dashed border-slate-300 dark:border-slate-600">
          <h3 class="text-base font-semibold text-slate-900 dark:text-white">
            {{ t('dedicated-builder-how-it-works-title') }}
          </h3>
          <ol class="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300 list-decimal list-inside">
            <li>{{ t('dedicated-builder-how-it-works-1') }}</li>
            <li>{{ t('dedicated-builder-how-it-works-2') }}</li>
            <li>{{ t('dedicated-builder-how-it-works-3') }}</li>
          </ol>
        </div>
      </section>

      <!-- Suspended -->
      <section v-else-if="status === 'suspended'" class="p-6 border rounded-2xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
          {{ t('dedicated-builder-suspended-title') }}
        </h2>
        <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {{ t('dedicated-builder-suspended-desc') }}
        </p>
      </section>
    </template>

    <RbacPermissionOnlyModal
      v-if="showAdminModal"
      :title="t('dedicated-builder-access-required')"
      permission="org.update_billing"
      @click="showAdminModal = false"
    />
  </div>
</template>

<route lang="yaml">
path: /settings/organization/dedicated-builder
meta:
  layout: settings
</route>
