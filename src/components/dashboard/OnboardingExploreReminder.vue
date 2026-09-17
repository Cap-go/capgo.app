<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import {
  dismissOnboardingExplorationReminder,
  markOnboardingExplorationReminderShown,
  shouldShowOnboardingExplorationReminder,
} from '~/utils/onboardingRedirect'

const props = defineProps<{ appId: string }>()
const main = useMainStore()
const dialogStore = useDialogV2Store()
const router = useRouter()
const { t } = useI18n()

watch([() => props.appId, () => main.user?.id ?? main.auth?.id, () => dialogStore.showDialog], ([appId, userId, dialogOpen]) => {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (!userId || !appId || dialogOpen || !shouldShowOnboardingExplorationReminder({ appId, userId, navigationType: navigation?.type }))
    return

  markOnboardingExplorationReminderShown()
  dialogStore.openDialog({
    id: 'onboarding-exploration-reminder',
    size: '2xl',
    title: t('app-onboarding-exploration-reminder-title'),
    description: t('app-onboarding-exploration-reminder-description'),
    buttons: [
      { text: t('app-onboarding-exploration-reminder-continue'), role: 'secondary' },
      {
        text: t('app-onboarding-exploration-reminder-setup'),
        role: 'primary',
        handler: () => { void router.push({ path: '/onboarding/app', query: { resume: appId, step: 'setup' } }) },
      },
      { text: t('app-onboarding-dont-show-again'), role: 'cancel', handler: () => dismissOnboardingExplorationReminder(userId) },
    ],
  })
}, { immediate: true, flush: 'post' })
</script>

<template>
  <span hidden />
</template>
