<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
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
}>(), {
  analyticsChannel: 'onboarding-v2',
  showManualSetupLink: true,
  trackingVersion: 2,
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
    <div class="flex flex-wrap items-start justify-between gap-3">
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
