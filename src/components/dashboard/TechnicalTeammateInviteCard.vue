<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'

interface InviteSuccessPayload {
  email: string
  firstName: string
  lastName: string
}

withDefaults(defineProps<{
  analyticsChannel?: string
  trackingVersion?: number
}>(), {
  analyticsChannel: 'onboarding-v2',
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
    <h3 class="text-lg font-semibold text-slate-950 dark:text-white">
      {{ t('onboarding-invite-option-title') }}
    </h3>
    <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {{ t('onboarding-invite-option-subtitle') }}
    </p>
    <button
      type="button"
      class="inline-flex items-center px-4 py-2 mt-4 text-sm font-semibold transition-colors duration-200 rounded-md cursor-pointer focus:ring-2 focus:ring-offset-2 bg-muted-blue-50 text-muted-blue-800 hover:bg-muted-blue-100 focus:outline-hidden focus:ring-muted-blue-500"
      data-test="onboarding-technical-invite"
      @click="openInviteDialog"
    >
      {{ t('onboarding-invite-option-cta') }}
    </button>
    <p class="mt-4 text-xs text-gray-400">
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
