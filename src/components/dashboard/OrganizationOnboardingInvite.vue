<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconBuilding from '~icons/lucide/building-2'
import IconLoader from '~icons/lucide/loader-2'
import IconUserPlus from '~icons/lucide/user-plus'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'
import { useOrganizationStore } from '~/stores/organization'

interface SentInvite {
  email: string
  firstName: string
  lastName: string
}

const props = withDefaults(defineProps<{
  analyticsChannel?: string
  continueLabel: string
  continuing?: boolean
  organizationId: string
  organizationName: string
  trackingVersion?: number
}>(), {
  analyticsChannel: 'onboarding-v2',
  continuing: false,
  trackingVersion: 2,
})

const emit = defineEmits<{
  continue: [invitationCount: number]
  inviteOpened: []
  inviteSucceeded: [invite: SentInvite]
}>()

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)
const sentInvites = ref<SentInvite[]>([])
const primaryButtonClass = 'border-primary-500 bg-primary-500 text-white hover:border-primary-500 hover:bg-primary-500/90 disabled:border-slate-300 disabled:bg-slate-300 disabled:text-white disabled:opacity-100 dark:border-primary-500/90 dark:bg-primary-500 dark:hover:border-primary-500 dark:hover:bg-primary-500/90 dark:disabled:border-white/15 dark:disabled:bg-slate-800 dark:disabled:text-slate-500'
const secondaryButtonClass = 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-100 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:disabled:border-white/15 dark:disabled:bg-slate-900 dark:disabled:text-slate-500'

function getInviteDisplayName(invite: SentInvite) {
  return [invite.firstName, invite.lastName].filter(Boolean).join(' ') || invite.email
}

function getInviteInitials(invite: SentInvite) {
  const fullName = `${invite.firstName} ${invite.lastName}`.trim()
  if (fullName) {
    return fullName
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase() ?? '')
      .join('')
  }

  return invite.email.slice(0, 2).toUpperCase()
}

function openInviteModal() {
  organizationStore.setCurrentOrganization(props.organizationId)
  emit('inviteOpened')
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess(invite: SentInvite) {
  sentInvites.value = [
    invite,
    ...sentInvites.value.filter(entry => entry.email !== invite.email),
  ]
  emit('inviteSucceeded', invite)
}

function continueOnboarding() {
  emit('continue', sentInvites.value.length)
}
</script>

<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/15 dark:bg-slate-900/95">
    <div class="space-y-4">
      <div>
        <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
          {{ t('organization-onboarding-invite-title') }}
        </h2>
        <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('organization-onboarding-invite-subtitle') }}
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
        <div class="flex items-start gap-4">
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-slate-800">
            <IconBuilding class="h-5 w-5" />
          </div>
          <div class="min-w-0">
            <div class="truncate text-base font-semibold text-slate-950 dark:text-white">
              {{ organizationName || t('organization-onboarding-org-placeholder') }}
            </div>
            <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ sentInvites.length > 0
                ? t('organization-onboarding-invite-success-state')
                : t('organization-onboarding-invite-empty-state') }}
            </p>
          </div>
        </div>

        <ul v-if="sentInvites.length > 0" class="mt-4 space-y-3">
          <li
            v-for="invite in sentInvites"
            :key="invite.email"
            class="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/15 dark:bg-slate-900/95"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-500 text-xs font-semibold text-white">
              {{ getInviteInitials(invite) }}
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-slate-950 dark:text-white">
                {{ getInviteDisplayName(invite) }}
              </div>
              <div class="truncate text-xs text-slate-500 dark:text-slate-400">
                {{ invite.email }}
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" class="d-btn min-h-11" :class="primaryButtonClass" data-test="onboarding-invite-users" @click="openInviteModal">
          <IconUserPlus class="h-4 w-4" />
          {{ t('organization-onboarding-open-invite') }}
        </button>
        <button type="button" class="d-btn min-h-11" :class="secondaryButtonClass" data-test="onboarding-finish" :disabled="continuing" @click="continueOnboarding">
          <IconLoader v-if="continuing" class="h-4 w-4 animate-spin" />
          <template v-else>
            {{ continueLabel }}
            <IconArrowRight class="h-4 w-4" />
          </template>
        </button>
      </div>
    </div>
  </div>

  <InviteTeammateModal
    ref="inviteModalRef"
    :analytics-channel="analyticsChannel"
    :tracking-version="trackingVersion"
    @success="onInviteSuccess"
  />
</template>
