<script setup lang="ts">
import type { Component } from 'vue'
import type { AppDeletionDetail, AppDeletionReason } from '~/utils/appDeletionFeedback'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowLeft from '~icons/heroicons/arrow-left'
import ArrowPathRoundedSquare from '~icons/heroicons/arrow-path-rounded-square'
import ChatBubbleLeftEllipsis from '~icons/heroicons/chat-bubble-left-ellipsis'
import CheckCircle from '~icons/heroicons/check-circle'
import ExclamationTriangle from '~icons/heroicons/exclamation-triangle'
import Identification from '~icons/heroicons/identification'
import NoSymbol from '~icons/heroicons/no-symbol'
import Square3Stack3D from '~icons/heroicons/square-3-stack-3d'
import Trash from '~icons/heroicons/trash'
import WrenchScrewdriver from '~icons/heroicons/wrench-screwdriver'
import { APP_DELETION_DETAILS, canContinueAppDeletion, isAppDeletionConfirmationValid } from '~/utils/appDeletionFeedback'

const props = defineProps<{
  stage: 'feedback' | 'confirm'
  appName: string
  appId: string
  appIcon?: string | null
  appAcronym: string
  organizationName?: string | null
  createdAt?: string | null
  reason: AppDeletionReason | null
  detail: AppDeletionDetail | null
  note: string
  confirmation: string
  deleting?: boolean
}>()

const emit = defineEmits<{
  'cancel': []
  'continue': []
  'back': []
  'confirm': []
  'update:reason': [value: AppDeletionReason]
  'update:detail': [value: AppDeletionDetail | null]
  'update:note': [value: string]
  'update:confirmation': [value: string]
}>()

const { t } = useI18n()

interface ReasonOption {
  id: AppDeletionReason
  icon: Component
  title: string
  description: string
}

const reasonOptions = computed<ReasonOption[]>(() => [
  { id: 'app_id_wrong', icon: Identification, title: t('app-delete-reason-app-id'), description: t('app-delete-reason-app-id-desc') },
  { id: 'setup_failed', icon: WrenchScrewdriver, title: t('app-delete-reason-setup'), description: t('app-delete-reason-setup-desc') },
  { id: 'duplicate_test', icon: Square3Stack3D, title: t('app-delete-reason-duplicate'), description: t('app-delete-reason-duplicate-desc') },
  { id: 'replacing_app', icon: ArrowPathRoundedSquare, title: t('app-delete-reason-replacing'), description: t('app-delete-reason-replacing-desc') },
  { id: 'no_longer_needed', icon: NoSymbol, title: t('app-delete-reason-not-needed'), description: t('app-delete-reason-not-needed-desc') },
  { id: 'other', icon: ChatBubbleLeftEllipsis, title: t('app-delete-reason-other'), description: t('app-delete-reason-other-desc') },
])

const detailLabels = computed<Record<AppDeletionDetail, string>>(() => ({
  expected_different_id: t('app-delete-detail-expected-id'),
  capgo_changed_ending: t('app-delete-detail-capgo-changed-id'),
  entered_incorrectly: t('app-delete-detail-entered-id'),
  wrong_project: t('app-delete-detail-wrong-project'),
  not_sure: t('app-delete-detail-not-sure'),
  local_project_connection: t('app-delete-detail-project-connection'),
  cli_command_failed: t('app-delete-detail-cli-failed'),
  first_bundle_failed: t('app-delete-detail-bundle-failed'),
  wrong_organization: t('app-delete-detail-wrong-org'),
  setup_in_progress: t('app-delete-detail-setup-progress'),
  created_by_mistake: t('app-delete-detail-created-mistake'),
  temporary_test: t('app-delete-detail-temporary-test'),
  same_app_exists: t('app-delete-detail-same-app'),
  onboarding_created_extra: t('app-delete-detail-onboarding-extra'),
  fixing_app_id: t('app-delete-detail-fixing-id'),
  restarting_setup: t('app-delete-detail-restarting'),
  moving_organization: t('app-delete-detail-moving-org'),
  rebuilt_local_project: t('app-delete-detail-rebuilt-project'),
  switching_environments: t('app-delete-detail-switching-env'),
  app_discontinued: t('app-delete-detail-discontinued'),
  project_paused: t('app-delete-detail-paused'),
  no_ota_updates: t('app-delete-detail-no-ota'),
  moving_service: t('app-delete-detail-moving-service'),
  cost: t('app-delete-detail-cost'),
  technical_limitations: t('app-delete-detail-technical'),
  something_else: t('app-delete-detail-something-else'),
  no_feedback: t('app-delete-detail-no-feedback'),
}))

const activeReason = computed(() => reasonOptions.value.find(option => option.id === props.reason))
const activeDetails = computed(() => props.reason ? APP_DELETION_DETAILS[props.reason] : [])
const canContinue = computed(() => canContinueAppDeletion(props))
const canConfirm = computed(() => isAppDeletionConfirmationValid(props.confirmation, props.appId))
const formattedCreatedAt = computed(() => props.createdAt
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(props.createdAt))
  : null)

function selectReason(reason: AppDeletionReason) {
  if (reason !== props.reason) {
    emit('update:detail', null)
    emit('update:note', '')
  }
  emit('update:reason', reason)
}
</script>

<template>
  <div v-if="stage === 'feedback'" class="-mx-1">
    <div class="mb-6 pr-10">
      <p class="mb-1 text-xs font-semibold tracking-wider text-blue-600 uppercase dark:text-blue-400">
        {{ t('app-delete-eyebrow') }}
      </p>
      <h2 class="text-2xl font-bold text-slate-900 dark:text-white">
        {{ t('app-delete-feedback-title', { name: appName }) }}
      </h2>
      <p class="mt-2 text-sm text-slate-500 dark:text-slate-300">
        {{ t('app-delete-feedback-subtitle') }}
      </p>
    </div>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)]">
      <aside class="space-y-4">
        <div class="p-4 border rounded-xl border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/70">
          <div class="flex items-center gap-3">
            <img v-if="appIcon" :src="appIcon" :alt="appName" class="object-cover w-12 h-12 rounded-xl">
            <div v-else class="flex items-center justify-center w-12 h-12 text-sm font-bold text-white bg-blue-600 rounded-xl">
              {{ appAcronym }}
            </div>
            <div class="min-w-0">
              <p class="font-semibold truncate text-slate-900 dark:text-white">
                {{ appName }}
              </p>
              <p class="font-mono text-xs truncate text-slate-500 dark:text-slate-400">
                {{ appId }}
              </p>
            </div>
          </div>
          <dl class="pt-4 mt-4 space-y-2 text-xs border-t border-slate-200 dark:border-slate-700">
            <div v-if="organizationName" class="flex justify-between gap-3">
              <dt class="text-slate-500 dark:text-slate-400">
                {{ t('organization') }}
              </dt>
              <dd class="font-medium text-right text-slate-700 dark:text-slate-200">
                {{ organizationName }}
              </dd>
            </div>
            <div v-if="formattedCreatedAt" class="flex justify-between gap-3">
              <dt class="text-slate-500 dark:text-slate-400">
                {{ t('app-delete-created') }}
              </dt>
              <dd class="font-medium text-right text-slate-700 dark:text-slate-200">
                {{ formattedCreatedAt }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="p-4 border border-blue-100 rounded-xl bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/30">
          <p class="flex items-center gap-2 text-sm font-semibold text-blue-900 dark:text-blue-100">
            <CheckCircle class="w-5 h-5 text-blue-600 dark:text-blue-400" />
            {{ t('app-delete-why-ask') }}
          </p>
          <p class="mt-2 text-xs leading-5 text-blue-800/80 dark:text-blue-200/80">
            {{ t('app-delete-why-ask-desc') }}
          </p>
        </div>
      </aside>

      <section>
        <fieldset>
          <legend class="mb-3 text-sm font-semibold text-slate-900 dark:text-white">
            {{ t('app-delete-feedback-question') }}
          </legend>
          <div class="space-y-2">
            <template v-for="option in reasonOptions" :key="option.id">
              <button
                type="button"
                class="w-full p-3 text-left transition border rounded-xl"
                :class="reason === option.id
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/15 dark:border-blue-400 dark:bg-blue-950/30'
                  : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-blue-700 dark:hover:bg-slate-800/50'"
                :aria-pressed="reason === option.id"
                @click="selectReason(option.id)"
              >
                <span class="flex items-start gap-3">
                  <span
                    class="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
                    :class="reason === option.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'"
                  >
                    <component :is="option.icon" class="w-5 h-5" />
                  </span>
                  <span class="min-w-0 grow">
                    <span class="block text-sm font-semibold text-slate-900 dark:text-white">{{ option.title }}</span>
                    <span class="block mt-0.5 text-xs text-slate-500 dark:text-slate-400">{{ option.description }}</span>
                  </span>
                  <span
                    class="flex items-center justify-center w-5 h-5 mt-2 border rounded-full shrink-0"
                    :class="reason === option.id ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 dark:border-slate-600'"
                  >
                    <CheckCircle v-if="reason === option.id" class="w-4 h-4" />
                  </span>
                </span>
              </button>

              <div v-if="reason === option.id" class="p-4 border rounded-xl border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-800/40">
                <p class="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {{ t('app-delete-details-question') }} <span class="font-normal text-slate-400">{{ t('optional') }}</span>
                </p>
                <div class="flex flex-wrap gap-2 mt-3">
                  <button
                    v-for="detailId in activeDetails"
                    :key="detailId"
                    type="button"
                    class="px-3 py-1.5 text-xs font-medium transition border rounded-full"
                    :class="detail === detailId
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300'"
                    :aria-pressed="detail === detailId"
                    @click="emit('update:detail', detail === detailId ? null : detailId)"
                  >
                    {{ detailLabels[detailId] }}
                  </button>
                </div>
                <label v-if="detail !== 'no_feedback'" for="app-delete-note" class="block mt-4 text-xs font-medium text-slate-600 dark:text-slate-300">
                  {{ reason === 'app_id_wrong' ? t('app-delete-expected-id') : reason === 'no_longer_needed' ? t('app-delete-moving-service') : t('app-delete-note') }}
                </label>
                <textarea
                  v-if="detail !== 'no_feedback'"
                  id="app-delete-note"
                  :value="note"
                  rows="2"
                  :placeholder="t('app-delete-note-placeholder')"
                  class="w-full px-3 py-2 mt-1 text-sm bg-white border rounded-lg resize-none border-slate-300 text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                  @input="emit('update:note', ($event.target as HTMLTextAreaElement).value)"
                />
              </div>
            </template>
          </div>
        </fieldset>
      </section>
    </div>

    <div class="flex flex-col-reverse gap-2 pt-5 mt-6 border-t sm:flex-row sm:justify-end border-slate-200 dark:border-slate-700">
      <button type="button" class="d-btn d-btn-outline" @click="emit('cancel')">
        {{ t('button-cancel') }}
      </button>
      <button type="button" class="d-btn d-btn-warning" :disabled="!canContinue" @click="emit('continue')">
        {{ t('app-delete-continue') }}
      </button>
    </div>
  </div>

  <div v-else class="max-w-2xl mx-auto">
    <div class="mb-5 pr-10">
      <p class="mb-1 text-xs font-semibold tracking-wider text-red-600 uppercase dark:text-red-400">
        {{ t('app-delete-final-check') }}
      </p>
      <h2 class="text-2xl font-bold text-slate-900 dark:text-white">
        {{ t('app-delete-confirm-title', { name: appName }) }}
      </h2>
      <p class="mt-2 text-sm text-slate-500 dark:text-slate-300">
        {{ t('app-delete-confirm-subtitle') }}
      </p>
    </div>

    <div class="flex gap-3 p-4 border border-red-200 rounded-xl bg-red-50 dark:border-red-900/60 dark:bg-red-950/30">
      <ExclamationTriangle class="w-6 h-6 text-red-600 shrink-0 dark:text-red-400" />
      <div>
        <p class="text-sm font-semibold text-red-900 dark:text-red-100">
          {{ t('app-delete-permanent') }}
        </p>
        <p class="mt-1 text-xs leading-5 text-red-800/80 dark:text-red-200/80">
          {{ t('app-delete-permanent-desc') }}
        </p>
      </div>
    </div>

    <div class="grid gap-3 mt-4 sm:grid-cols-2">
      <div class="p-4 border rounded-xl border-slate-200 dark:border-slate-700">
        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">
          {{ t('app-delete-your-reason') }}
        </p>
        <p class="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
          {{ activeReason?.title }}
        </p>
        <p v-if="detail" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ detailLabels[detail] }}
        </p>
      </div>
      <div class="p-4 border rounded-xl border-slate-200 dark:border-slate-700">
        <p class="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Trash class="w-4 h-4 text-red-500" /> {{ t('app-delete-removes') }}
        </p>
        <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ t('app-delete-removes-desc') }}
        </p>
      </div>
    </div>

    <label for="app-delete-confirmation" class="block mt-5 text-sm font-semibold text-slate-900 dark:text-white">
      {{ t('app-delete-type-to-confirm') }}
      <code class="px-1.5 py-0.5 ml-1 text-xs rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{{ appId }}</code>
    </label>
    <input
      id="app-delete-confirmation"
      :value="confirmation"
      type="text"
      autocomplete="off"
      spellcheck="false"
      :placeholder="appId"
      class="w-full px-3 py-2 mt-2 font-mono text-sm bg-white border rounded-lg border-slate-300 text-slate-900 focus:border-red-500 focus:outline-hidden focus:ring-2 focus:ring-red-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
      @input="emit('update:confirmation', ($event.target as HTMLInputElement).value)"
    >

    <div class="flex flex-col-reverse gap-2 pt-5 mt-6 border-t sm:flex-row sm:justify-between border-slate-200 dark:border-slate-700">
      <button type="button" class="d-btn d-btn-ghost" :disabled="deleting" @click="emit('back')">
        <ArrowLeft class="w-4 h-4" /> {{ t('button-back') }}
      </button>
      <div class="flex flex-col-reverse gap-2 sm:flex-row">
        <button type="button" class="d-btn d-btn-outline" :disabled="deleting" @click="emit('cancel')">
          {{ t('button-cancel') }}
        </button>
        <button type="button" class="d-btn d-btn-warning" :disabled="!canConfirm || deleting" @click="emit('confirm')">
          <span v-if="deleting" class="loading loading-spinner loading-sm" />
          {{ t('app-delete-delete-permanently') }}
        </button>
      </div>
    </div>
  </div>
</template>
