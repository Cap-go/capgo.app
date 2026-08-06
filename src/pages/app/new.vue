<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import AppOnboardingFlow from '~/components/dashboard/AppOnboardingFlow.vue'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const supabase = useSupabase()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)

const isLoading = ref(true)
const appsCount = ref<number | null>(null)

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

  const { count } = await supabase
    .from('apps')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)

  appsCount.value = count ?? 0
}

async function init() {
  isLoading.value = true
  try {
    if (lacksSecurityAccess.value)
      return

    await organizationStore.awaitInitialLoad()
    await fetchAppsCount()
  }
  finally {
    isLoading.value = false
  }
}

watch(() => currentOrganization.value?.gid, (orgId, previousOrgId) => {
  if (!orgId || orgId === previousOrgId)
    return
  if (lacksSecurityAccess.value)
    return
  // Refresh the app count for the newly selected org without toggling the
  // full-page loader — flipping isLoading would remount AppOnboardingFlow and
  // discard whatever the user had already typed into the setup form.
  void fetchAppsCount()
})

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

    <AppOnboardingFlow v-else :onboarding="isOnboarding" />
  </div>
</template>
