<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StepsBundle from '~/components/dashboard/StepsBundle.vue'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'
import {
  isLiveUpdateGuide,
  liveUpdateChannelPath,
  pickProductionChannel,
} from '~/utils/gettingStartedLiveUpdate'

const route = useRoute('/app/[app].bundles.new')
const router = useRouter()
const supabase = useSupabase()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)

const appId = computed(() => String(route.params.app || ''))
const isLoading = ref(true)
const bundlesCount = ref<number | null>(null)

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const isOnboarding = computed(() => (bundlesCount.value ?? 0) === 0)
const liveUpdateGuide = computed(() => isLiveUpdateGuide(route.query.guide))

async function fetchBundlesCount() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !appId.value) {
    bundlesCount.value = 0
    return
  }
  const { count } = await supabase
    .from('app_versions')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('app_id', appId.value)
    .eq('deleted', false)
    .neq('storage_provider', 'revert_to_builtin')

  bundlesCount.value = count ?? 0
}

function bundlesListPath() {
  return `/app/${encodeURIComponent(appId.value)}/bundles`
}

function onClose() {
  if (liveUpdateGuide.value) {
    router.push(`/app/${encodeURIComponent(appId.value)}/getting-started`)
    return
  }
  router.push(bundlesListPath())
}

async function resolveLiveUpdateNextPath() {
  const { data } = await supabase
    .from('channels')
    .select('id, name, public')
    .eq('app_id', appId.value)

  const channel = pickProductionChannel(data ?? [])
  return liveUpdateChannelPath(appId.value, channel?.id)
}

async function onDone() {
  if (liveUpdateGuide.value) {
    router.push(await resolveLiveUpdateNextPath())
    return
  }
  router.push(`${bundlesListPath()}?refresh=true`)
}

async function init() {
  isLoading.value = true
  try {
    if (lacksSecurityAccess.value)
      return

    await organizationStore.awaitInitialLoad()
    await fetchBundlesCount()
  }
  finally {
    isLoading.value = false
  }
}

watch(currentOrganization, () => init())
watch(() => appId.value, () => init())

onMounted(() => {
  displayStore.NavTitle = ''
  displayStore.defaultBack = liveUpdateGuide.value
    ? `/app/${encodeURIComponent(appId.value)}/getting-started`
    : `/app/${encodeURIComponent(appId.value)}/bundles`
  init()
})
</script>

<template>
  <div class="h-full">
    <div v-if="lacksSecurityAccess" class="overflow-y-auto px-0 pt-0 mx-auto mb-8 w-full h-full sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <FailedCard />
    </div>

    <PageLoader v-else-if="isLoading" />

    <div v-else>
      <StepsBundle
        :onboarding="isOnboarding"
        :app-id="appId"
        @done="onDone"
        @close-step="onClose"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
