<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconRefresh from '~icons/lucide/refresh-cw'
import { setCiCdReminderDismissed } from '~/services/cicdReminder'
import { useOrganizationStore } from '~/stores/organization'
import { parseCiCdSetupState, resolveCiGuideContext } from '~/utils/cicdSetupState'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

const props = defineProps<{ appId: string }>()
const { t } = useI18n()
const organizationStore = useOrganizationStore()
const restoring = ref(false)
const onboarding = computed(() => organizationStore.getAppByAppId(props.appId)?.onboarding)
const dismissed = computed(() => !!parseCiCdSetupState(onboarding.value).dismissedAt)
const cicdLocation = computed(() => {
  const context = resolveCiGuideContext({ onboarding: onboarding.value })
  return {
    path: `/app/${encodeURIComponent(props.appId)}/ci-cd`,
    query: { product: context.product, ...(context.platform ? { platform: context.platform } : {}) },
  }
})

async function restoreReminder() {
  if (restoring.value)
    return
  restoring.value = true
  const appId = props.appId
  try {
    const value = await setCiCdReminderDismissed(appId, false)
    organizationStore.updateAppOnboarding(appId, value)
    toast.success(t('cicd-reminder-restored'))
  }
  catch (error) {
    console.error('Cannot restore CI/CD reminder', error)
    toast.error(t('cicd-reminder-restore-error'))
  }
  finally {
    restoring.value = false
  }
}

const linkClass = 'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 dark:text-azure-300 dark:hover:bg-white/5'
</script>

<template>
  <section class="rounded-xl border border-slate-200 p-4 dark:border-slate-700" data-test="app-setup-guides" :aria-label="t('app-setup-guides-title')">
    <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
      {{ t('app-setup-guides-title') }}
    </h3>
    <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
      {{ t('app-setup-guides-description') }}
    </p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <RouterLink :to="{ path: getAppGettingStartedPath(appId), query: { showChecklist: '1' } }" :class="linkClass" data-test="getting-started-guide-open">
        {{ t('getting-started') }}
        <IconArrowRight class="size-4" aria-hidden="true" />
      </RouterLink>
      <RouterLink :to="cicdLocation" :class="linkClass" data-test="cicd-guide-open">
        {{ t('setup-checklist-cicd-start') }}
        <IconArrowRight class="size-4" aria-hidden="true" />
      </RouterLink>
      <button v-if="dismissed" type="button" :class="linkClass" :disabled="restoring" class="disabled:opacity-50" data-test="cicd-reminder-restore" @click="restoreReminder">
        <IconRefresh class="size-4" aria-hidden="true" />
        {{ t('cicd-reminder-restore') }}
      </button>
    </div>
  </section>
</template>
