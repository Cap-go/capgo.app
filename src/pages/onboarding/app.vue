<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconLoader from '~icons/lucide/loader-2'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { clearOnboardingAppDraft } from '~/utils/onboardingAppDraft'

const router = useRouter()
const { t } = useI18n()
const displayStore = useDisplayStore()
const main = useMainStore()
const onboardingFlow = ref<{ persistOnboardingProgress?: () => Promise<unknown> } | null>(null)
const isReady = ref(false)
const isLoggingOut = ref(false)

async function logoutFromOnboarding() {
  if (isLoggingOut.value)
    return

  isLoggingOut.value = true
  try {
    await onboardingFlow.value?.persistOnboardingProgress?.()
    clearOnboardingAppDraft(main.user?.id ?? main.auth?.id)
    await main.logout()
    await router.replace('/login')
  }
  catch (error) {
    console.error('Failed to log out from app onboarding', error)
    toast.error(t('cannot-sign-off'))
  }
  finally {
    isLoggingOut.value = false
  }
}

onMounted(async () => {
  if (!main.auth) {
    await router.replace('/login?to=/onboarding/app')
    return
  }

  displayStore.NavTitle = t('app-onboarding-badge')
  displayStore.defaultBack = '/login'
  isReady.value = true
})
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
    <header class="onboarding-page-actions absolute right-0 top-0 z-20 flex shrink-0 items-center justify-end px-6 py-3 lg:px-10">
      <button
        type="button"
        class="d-btn d-btn-ghost min-h-11 text-slate-600 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white"
        data-test="onboarding-logout"
        :aria-label="t('logout')"
        :disabled="isLoggingOut"
        @click="logoutFromOnboarding"
      >
        <IconLoader v-if="isLoggingOut" class="h-4 w-4 animate-spin" />
        <span :class="{ 'sr-only': isLoggingOut }">{{ t('logout') }}</span>
      </button>
    </header>

    <PageLoader v-if="!isReady" class="min-h-0 flex-1" />
    <div v-else class="min-h-0 flex-1">
      <AppOnboardingFlow ref="onboardingFlow" pre-org onboarding />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: naked
  middleware: auth
</route>

<style scoped>
@media (max-width: 639px) {
  :deep(.onboarding-flow-app-creation) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-badge) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-content > :not([hidden]) ~ :not([hidden])),
  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-actions),
  :deep(.onboarding-flow-intent .onboarding-intent-actions) {
    padding-top: 0.75rem;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-options) {
    gap: 0.5rem;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-option) {
    min-height: 3.25rem;
    align-items: center;
    padding: 0.75rem;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-option-description) {
    display: none;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-eyebrow),
  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id),
  :deep(.onboarding-flow-details-icon .onboarding-details-eyebrow),
  :deep(.onboarding-flow-details-icon .onboarding-icon-upload-helper) {
    display: none;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-heading h2),
  :deep(.onboarding-flow-details-icon .onboarding-details-heading h2) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-app-id-input) {
    margin-top: 0.25rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-store-import),
  :deep(.onboarding-flow-details-icon .onboarding-icon-store-import) {
    margin-block: 0.75rem;
  }

  :deep(.onboarding-flow-details-icon .onboarding-icon-uploader) {
    padding: 0.75rem;
  }
}

@media (max-width: 639px) and (max-height: 700px) {
  :global(body:has(.onboarding-flow-app-creation) .onboarding-page-actions) {
    display: none;
  }

  :deep(.onboarding-flow-intent .onboarding-flow-title),
  :deep(.onboarding-flow-intent .onboarding-intent-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-intent .onboarding-flow-header nav) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-heading h2) {
    margin-top: 0;
  }
}

@media (max-width: 639px) and (max-height: 630px) {
  :deep(.onboarding-flow-app-creation) {
    padding-block: 0.5rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card) {
    padding: 0.75rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-title),
  :deep(.onboarding-flow-details-app-id .onboarding-flow-title),
  :deep(.onboarding-flow-details-icon .onboarding-flow-title) {
    display: none;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-header nav),
  :deep(.onboarding-flow-details-app-id .onboarding-flow-header nav),
  :deep(.onboarding-flow-details-icon .onboarding-flow-header nav) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 800px) {
  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name)) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-badge) {
    display: none;
  }

  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-flow-content
      > :not([hidden])
      ~ :not([hidden])
  ),
  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-details-card-content
      > :not([hidden])
      ~ :not([hidden])
  ),
  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-intent-card-content
      > :not([hidden])
      ~ :not([hidden])
  ) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-card),
  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-intent-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-preview-icon) {
    width: 4rem;
    height: 4rem;
    border-radius: 1.125rem;
  }

  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-preview > p:first-of-type
  ) {
    margin-top: 0.5rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-app-id-input) {
    margin-top: 0.25rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id) {
    display: grid;
    grid-template-columns: 3.25rem auto;
    grid-template-rows: auto auto;
    column-gap: 0.75rem;
    justify-content: center;
    padding-block: 0;
    text-align: left;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id .onboarding-details-preview-icon) {
    grid-row: 1 / span 2;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 0.875rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id > p:first-of-type) {
    align-self: end;
    margin-top: 0;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id > p:last-child) {
    align-self: start;
  }
}

@media (min-width: 640px) and (max-height: 700px) {
  :deep(.onboarding-flow-details-name) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-badge) {
    display: none;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-content > :not([hidden]) ~ :not([hidden])),
  :deep(.onboarding-flow-details-name .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-details-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-details-preview-icon) {
    width: 4rem;
    height: 4rem;
    border-radius: 1.125rem;
  }

  :deep(.onboarding-flow-details-name .onboarding-details-preview > p:first-of-type) {
    margin-top: 0.5rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-heading h2),
  :deep(.onboarding-flow-app-creation .onboarding-details-heading p:last-child) {
    margin-top: 0.25rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-store-import),
  :deep(.onboarding-flow-details-icon .onboarding-icon-store-import) {
    margin-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-actions),
  :deep(.onboarding-flow-intent .onboarding-intent-actions) {
    padding-top: 0.75rem;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-eyebrow),
  :deep(.onboarding-flow-details-icon .onboarding-details-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-details-app-id .onboarding-details-heading h2),
  :deep(.onboarding-flow-details-icon .onboarding-details-heading h2) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 640px) {
  :deep(.onboarding-flow-details-icon .onboarding-icon-upload-helper) {
    display: none;
  }

  :deep(.onboarding-flow-details-icon .onboarding-icon-uploader) {
    padding: 0.75rem;
  }
}

@media (min-width: 640px) and (max-height: 600px) {
  :deep(.onboarding-flow-details-app-id .onboarding-details-preview-app-id) {
    display: none;
  }
}

@media (min-width: 640px) and (max-height: 590px) {
  :deep(.onboarding-flow-details-icon .onboarding-icon-identity) {
    display: none;
  }
}

@media (min-width: 640px) and (max-height: 550px) {
  :deep(.onboarding-flow-intent .onboarding-intent-eyebrow),
  :deep(.onboarding-flow-details-name .onboarding-details-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-heading h2),
  :deep(.onboarding-flow-details-name .onboarding-details-heading h2) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 530px) {
  :deep(.onboarding-flow-details-name .onboarding-details-preview),
  :deep(.onboarding-flow-details-icon .onboarding-flow-title) {
    display: none;
  }

  :deep(.onboarding-flow-details-icon .onboarding-flow-header nav) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-width: 700px) and (max-height: 620px) {
  :deep(.onboarding-flow-intent .onboarding-intent-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-intent .onboarding-intent-heading h2) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-details-icon .onboarding-icon-identity) {
    display: none;
  }
}

@media (min-width: 640px) and (max-height: 500px) {
  :deep(.onboarding-flow-intent .onboarding-flow-title),
  :deep(.onboarding-flow-details-name .onboarding-flow-title),
  :deep(.onboarding-flow-details-app-id .onboarding-flow-title) {
    display: none;
  }

  :deep(.onboarding-flow-intent .onboarding-flow-header nav),
  :deep(.onboarding-flow-details-name .onboarding-flow-header nav),
  :deep(.onboarding-flow-details-app-id .onboarding-flow-header nav) {
    margin-top: 0;
  }
}
</style>
