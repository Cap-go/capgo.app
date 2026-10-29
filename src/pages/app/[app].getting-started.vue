<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import OnboardingChoosePlanStep from '~/components/dashboard/OnboardingChoosePlanStep.vue'
import { useAppPage } from '~/composables/useAppPage'
import { useBillingPaidAt } from '~/composables/useBillingPaidAt'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { readOnboardingSetupHandoff } from '~/utils/onboardingRedirect'
import { parseUserOnboardingProgress } from '~/utils/userOnboardingProgress'

const { t } = useI18n()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const route = useRoute('/app/[app].getting-started')
// Only a single explicit opt-in enables checklist viewing; arrays and values
// such as "0", "false", or an empty query value keep the normal redirect.
const showChecklist = computed(() => route.query.showChecklist === '1')
const initialChecklistPath = computed(() => route.query.path === 'builder' ? 'builder' as const : undefined)
const { id, app, isLoading } = useAppPage({
  routeName: '/app/[app].getting-started',
  navTitle: t('getting-started'),
})

// Direct-offer orgs (no free trial, never paid) can create their app but cannot
// publish updates until they subscribe. This page is where they land after
// signup, so choosing a plan is shown as the first step, before setup. It hides
// as soon as the org pays (or has credits), since the org is no longer failed.
const hideExternalPurchaseFlows = isNativeAppStoreContext()
// Scope to the org that owns this app, and wait until it is the current org so
// currentOrganizationFailed describes it (not the previously selected org).
const unpaidOrgId = computed(() => {
  const appOrgId = id.value ? organizationStore.getOrgByAppId(id.value)?.gid : undefined
  if (!appOrgId || organizationStore.currentOrganization?.gid !== appOrgId)
    return undefined
  return organizationStore.currentOrganizationFailed ? appOrgId : undefined
})
const { trialSkipped } = useBillingPaidAt(unpaidOrgId, hideExternalPurchaseFlows)
const showChoosePlanStep = computed(() => !!unpaidOrgId.value && trialSkipped.value)

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
  <AppPageFrame flush :found="!!app" :loading="isLoading">
    <OnboardingChoosePlanStep v-if="showChoosePlanStep" />
    <AppOnboardingFlow
      v-if="app && setupFlowAppId === app.app_id"
      :key="`${setupFlowAppId}:${showChecklist}`"
      data-test="getting-started-setup"
      :setup-app-id="setupFlowAppId"
      :show-checklist="showChecklist"
      :initial-checklist-path="initialChecklistPath"
      :pre-org="setupPreOrg"
      onboarding
    />
  </AppPageFrame>
</template>
