<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import Banner from '~/components/Banner.vue'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import AppOnboardingPageFrame from '~/components/dashboard/AppOnboardingPageFrame.vue'
import OnboardingSetupModeChoice from '~/components/dashboard/OnboardingSetupModeChoice.vue'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { clearOnboardingAppDraft } from '~/utils/onboardingAppDraft'
import { initialOnboardingSetupScreen } from '~/utils/onboardingSetupMode'

const router = useRouter()
const route = useRoute('/onboarding/app')
const { t } = useI18n()
const displayStore = useDisplayStore()
const main = useMainStore()
const onboardingFlow = ref<{ persistOnboardingProgress?: () => Promise<unknown> } | null>(null)
const isReady = ref(false)
const isLoggingOut = ref(false)
// Existing users reach this page from "Create new organization".
const isNewOrganization = route.query.new_org === '1'
// First-time users pick AI or manual setup before the wizard. Anyone already inside the
// manual wizard (saved progress, resume link, extra organization) keeps it unchanged.
const setupScreen = ref(initialOnboardingSetupScreen({
  onboarding: main.user?.onboarding,
  newOrganization: isNewOrganization,
  resuming: typeof route.query.resume === 'string' || typeof route.query.step === 'string',
}))

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
  <AppOnboardingPageFrame :can-cancel="isNewOrganization" :is-logging-out="isLoggingOut" @cancel="router.push('/dashboard')" @logout="logoutFromOnboarding">
    <template #actions>
      <!-- Keep trial status visible on wide screens without overlapping the title. -->
      <div class="hidden xl:flex">
        <Banner desktop />
      </div>
    </template>
    <PageLoader v-if="!isReady" class="min-h-0 flex-1" />
    <OnboardingSetupModeChoice
      v-else-if="setupScreen !== 'manual'"
      class="min-h-0 flex-1"
      :initial-screen="setupScreen"
      @manual="setupScreen = 'manual'"
    />
    <div v-else class="min-h-0 flex-1">
      <AppOnboardingFlow ref="onboardingFlow" pre-org onboarding :new-organization="isNewOrganization" />
    </div>
  </AppOnboardingPageFrame>
</template>

<route lang="yaml">
meta:
  layout: naked
  middleware: auth
</route>
