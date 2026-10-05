<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import { useAppPage } from '~/composables/useAppPage'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { readOnboardingSetupHandoff } from '~/utils/onboardingRedirect'
import { parseUserOnboardingProgress } from '~/utils/userOnboardingProgress'

const { t } = useI18n()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const { id, app, isLoading } = useAppPage({
  routeName: '/app/[app].getting-started',
  navTitle: t('getting-started'),
})

// Getting started always renders the onboarding setup UI inside the dashboard
// shell. Read once per app: the flow reads its analytics flow at mount.
const setupFlowAppId = ref('')
const setupPreOrg = ref(false)

function resolveSetupPreOrg(appId: string) {
  const handoff = readOnboardingSetupHandoff(window.history.state, appId)
  if (handoff)
    return handoff.flow === 'pre_org'
  const saved = parseUserOnboardingProgress(main.user?.onboarding)
  return saved?.status === 'in_progress' && saved.flow === 'pre_org' && saved.app_id === appId
}

watch(() => id.value, async (appId) => {
  if (!appId)
    return
  await organizationStore.awaitInitialLoad()
  const appOrganization = organizationStore.getOrgByAppId(appId)
  if (appOrganization && organizationStore.currentOrganization?.gid !== appOrganization.gid)
    organizationStore.setCurrentOrganization(appOrganization.gid)
}, { immediate: true })

watch(() => app.value?.app_id, (appId) => {
  if (!appId || setupFlowAppId.value === appId)
    return
  setupPreOrg.value = resolveSetupPreOrg(appId)
  setupFlowAppId.value = appId
}, { immediate: true })
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <AppOnboardingFlow
      v-if="app && setupFlowAppId === app.app_id"
      :key="setupFlowAppId"
      data-test="getting-started-setup"
      :setup-app-id="setupFlowAppId"
      :pre-org="setupPreOrg"
      onboarding
    />
  </AppPageFrame>
</template>
