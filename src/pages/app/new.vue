<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AddAppSetupChoice from '~/components/dashboard/AddAppSetupChoice.vue'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import { canPrepareAgentKey } from '~/services/aiAgentKey'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const route = useRoute('/app/new')
const capgo = useConsole()
const displayStore = useDisplayStore()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)

const isLoading = ref(true)
const appsCount = ref<number | null>(null)
// The user first picks their AI agent or the manual wizard, unless they already chose manual.
const showManualFlow = ref(route.query.mode === 'manual')
// The AI prompt carries an organization API key: only users who own or may create one get the choice.
const canUseAiAgent = ref(false)
// Each init() supersedes the previous one (organization switch): only the latest may apply.
let initGeneration = 0

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const isOnboarding = computed(() => (appsCount.value ?? 0) === 0)

async function fetchAppsCount() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    appsCount.value = 0
    return
  }

  const { count } = await capgo
    .from('apps')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)

  appsCount.value = count ?? 0
}

async function init() {
  const generation = ++initGeneration
  isLoading.value = true
  try {
    if (lacksSecurityAccess.value)
      return

    await organizationStore.awaitInitialLoad()
    const orgId = organizationStore.currentOrganization?.gid
    const userId = main.user?.id ?? main.auth?.id
    const [, canManageKeys] = await Promise.all([
      fetchAppsCount(),
      orgId && userId ? canPrepareAgentKey(capgo, { userId, orgId, appId: null, task: 'add-app' }) : Promise.resolve(false),
    ])
    if (generation === initGeneration)
      canUseAiAgent.value = canManageKeys
  }
  finally {
    if (generation === initGeneration)
      isLoading.value = false
  }
}

watch(currentOrganization, () => init())

onMounted(() => {
  displayStore.NavTitle = ''
  displayStore.defaultBack = '/apps'
  init()
})
</script>

<template>
  <div class="h-full">
    <div v-if="lacksSecurityAccess" class="overflow-y-auto px-0 pt-0 mx-auto mb-8 w-full h-full sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <FailedCard />
    </div>

    <PageLoader v-else-if="isLoading" />

    <AddAppSetupChoice v-else-if="canUseAiAgent && !showManualFlow" @manual="showManualFlow = true" />

    <AppOnboardingFlow v-else :onboarding="isOnboarding" />
  </div>
</template>
