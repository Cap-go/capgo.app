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
  <div class="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
    <header class="relative z-20 flex shrink-0 items-center justify-end px-6 py-5 lg:px-10">
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
