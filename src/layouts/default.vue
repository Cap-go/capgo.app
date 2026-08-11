<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import OnboardingExploreBanner from '~/components/dashboard/OnboardingExploreBanner.vue'
import { useRealtimeCLIFeed } from '~/composables/useRealtimeCLIFeed'
import { useSupabase } from '~/services/supabase'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { getOnboardingExploreBannerAppId } from '~/utils/onboardingRedirect'
import Navbar from '../components/Navbar.vue'
import Sidebar from '../components/Sidebar.vue'

const sidebarOpen = ref(false)
const pendingOnboardingAppId = ref('')
const route = useRoute()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
let onboardingLookupRun = 0

const selectableOrganizations = computed(() => organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org)))
const selectableOrganizationIds = computed(() => selectableOrganizations.value.map(org => org.gid).sort().join(','))

async function refreshPendingOnboardingApp() {
  const lookupRun = ++onboardingLookupRun
  pendingOnboardingAppId.value = ''

  if (/^\/app\/new\/?$/.test(route.path) || route.path === '/onboarding' || route.path.startsWith('/onboarding/'))
    return

  await organizationStore.awaitInitialLoad()

  const singleOrganization = selectableOrganizations.value[0]
  if (selectableOrganizations.value.length !== 1 || !singleOrganization)
    return

  const { data, error } = await supabase
    .from('apps')
    .select('app_id, need_onboarding')
    .eq('owner_org', singleOrganization.gid)
    .limit(2)

  if (lookupRun !== onboardingLookupRun)
    return

  if (error) {
    console.error('Cannot resolve pending onboarding app', error)
    return
  }

  pendingOnboardingAppId.value = getOnboardingExploreBannerAppId({
    apps: data ?? [],
    organizationCount: selectableOrganizations.value.length,
  }) ?? ''
}

watch([
  () => route.path,
  selectableOrganizationIds,
], refreshPendingOnboardingApp, { immediate: true })

// Initialize realtime CLI activity feed (toasts for CLI actions)
useRealtimeCLIFeed()
</script>

<template>
  <div class="flex h-full overflow-hidden bg-slate-800 pt-safe safe-areas">
    <!-- Sidebar -->
    <Sidebar :sidebar-open="sidebarOpen" @close-sidebar="sidebarOpen = false" />
    <!-- Content area -->
    <div class="flex flex-col flex-1 h-full overflow-hidden lg:p-3">
      <div class="flex flex-col h-full overflow-hidden border border-gray-200 lg:rounded-xl lg:shadow-sm dark:border-gray-700 bg-slate-100 dark:bg-slate-900">
        <!-- Site header -->
        <Navbar :sidebar-open="sidebarOpen" @toggle-sidebar="sidebarOpen = !sidebarOpen" />
        <!-- App and settings layouts are nested inside this shared dashboard shell. -->
        <OnboardingExploreBanner v-if="pendingOnboardingAppId" :app-id="pendingOnboardingAppId" />
        <main class="w-full h-full overflow-hidden">
          <RouterView class="h-full overflow-y-auto grow" />
        </main>
      </div>
    </div>
  </div>
</template>
