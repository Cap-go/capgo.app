<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconMail from '~icons/lucide/mail'
import IconUserPlus from '~icons/lucide/user-plus'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'

interface InviteSuccessPayload {
  email: string
  firstName: string
  lastName: string
}

withDefaults(defineProps<{
  analyticsChannel?: string
  showManualSetupLink?: boolean
  trackingVersion?: number
  compact?: boolean
  handoff?: boolean
}>(), {
  analyticsChannel: 'onboarding-v2',
  showManualSetupLink: true,
  trackingVersion: 2,
  compact: false,
  handoff: false,
})

const emit = defineEmits<{
  opened: []
  success: [invite: InviteSuccessPayload]
}>()

const { t } = useI18n()
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)

function openInviteDialog() {
  emit('opened')
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess(invite: InviteSuccessPayload) {
  emit('success', invite)
}
</script>

<template>
  <div>
    <div v-if="handoff" class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-4">
        <IconUserPlus class="h-6 w-6 shrink-0 text-azure-500" aria-hidden="true" />
        <div>
          <h3 class="text-base font-semibold text-slate-950 dark:text-white">
            {{ t('setup-checklist-delegate-title') }}
          </h3>
          <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {{ t('setup-checklist-delegate-description') }}
          </p>
        </div>
      </div>
      <button
        type="button"
        class="d-btn min-h-12 shrink-0 self-start border-azure-500 bg-white px-4 text-sky-700 hover:border-azure-600 hover:bg-azure-500/5 focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 sm:self-auto dark:bg-slate-900 dark:text-azure-300 dark:hover:bg-azure-500/10"
        data-test="onboarding-technical-invite"
        @click="openInviteDialog"
      >
        <IconMail class="h-4 w-4" aria-hidden="true" />
        {{ t('setup-checklist-delegate-cta') }}
      </button>
    </div>
    <div v-else-if="compact">
      <button
        type="button"
        class="d-btn d-btn-ghost h-auto min-h-11 justify-start px-0 text-left font-normal text-sky-700 hover:bg-transparent hover:text-sky-800 dark:text-azure-300"
        data-test="onboarding-technical-invite"
        @click="openInviteDialog"
      >
        <IconUserPlus class="h-5 w-5 shrink-0" aria-hidden="true" />
        {{ t('setup-checklist-delegate-action') }}
        <IconArrowRight class="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
      <p class="pl-7 text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('setup-checklist-delegate-description') }}
      </p>
    </div>
    <div v-else class="flex flex-wrap items-start justify-between gap-3">
      <div class="max-w-2xl">
        <h3 class="font-medium text-slate-950 dark:text-white">
          {{ t('onboarding-invite-option-title') }}
        </h3>
        <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('onboarding-invite-option-subtitle') }}
        </p>
      </div>
      <button
        type="button"
        class="d-btn min-h-11 border-slate-300 bg-white px-4 text-slate-700 hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-100 dark:hover:border-white/30 dark:hover:bg-slate-900"
        data-test="onboarding-technical-invite"
        @click="openInviteDialog"
      >
        <IconUserPlus class="h-4 w-4" aria-hidden="true" />
        {{ t('onboarding-invite-option-cta') }}
      </button>
    </div>
    <p v-if="showManualSetupLink" class="mt-4 text-xs text-gray-400">
      {{ t('onboarding-manual-setup-prefix') }}
      <a
        href="https://capgo.app/docs/getting-started/add-an-app/#manual-setup"
        target="_blank"
        rel="noopener noreferrer"
        class="underline hover:text-gray-600"
      >{{ t('onboarding-manual-setup-link') }}</a>
    </p>
  </div>

  <InviteTeammateModal
    ref="inviteModalRef"
    :analytics-channel="analyticsChannel"
    invite-kind="technical"
    :tracking-version="trackingVersion"
    @success="onInviteSuccess"
  />
</template>
