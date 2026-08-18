<script setup lang="ts">
import { useLocalStorage, useMediaQuery } from '@vueuse/core'
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
const sidebarCollapsedPreference = useLocalStorage('capgo-sidebar-collapsed', false)
const isDesktop = useMediaQuery('(min-width: 1024px)')
const sidebarCollapsed = computed(() => isDesktop.value && sidebarCollapsedPreference.value)

function toggleSidebarCollapse() {
  sidebarCollapsedPreference.value = !sidebarCollapsedPreference.value
}

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

  const singleOrganization = selectableOrganizations.value.length === 1
    ? selectableOrganizations.value[0]
    : undefined
  if (!singleOrganization || singleOrganization.app_count !== 1)
    return

  const { data, error } = await supabase
    .from('apps')
    .select('app_id, need_onboarding')
    .eq('owner_org', singleOrganization.gid)
    .limit(1)
    .maybeSingle()

  if (lookupRun !== onboardingLookupRun)
    return

  if (error) {
    console.error('Cannot resolve pending onboarding app', error)
    return
  }

  pendingOnboardingAppId.value = getOnboardingExploreBannerAppId({
    app: data,
    organizationAppCount: singleOrganization.app_count,
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
    <Sidebar
      :sidebar-open="sidebarOpen"
      :sidebar-collapsed="sidebarCollapsed"
      @close-sidebar="sidebarOpen = false"
    />
    <!-- Content area -->
    <div
      data-test="dashboard-shell"
      class="flex flex-col flex-1 h-full overflow-hidden transition-[padding-inline,padding-block] duration-500 ease-in-out motion-reduce:!transition-none"
      :class="sidebarCollapsed ? 'lg:px-0 lg:py-0' : 'lg:px-3 lg:py-3'"
    >
      <div
        class="flex flex-col h-full overflow-hidden border border-gray-200 dark:border-gray-700 bg-slate-100 dark:bg-slate-900 transition-[border-radius,box-shadow,border-color] duration-500 ease-in-out motion-reduce:!transition-none"
        :class="sidebarCollapsed ? 'lg:rounded-none lg:border-transparent lg:dark:border-transparent lg:shadow-none' : 'lg:rounded-xl lg:shadow-sm'"
      >
        <!-- Site header -->
        <Navbar
          :sidebar-open="sidebarOpen"
          :sidebar-collapsed="sidebarCollapsed"
          @toggle-sidebar="sidebarOpen = !sidebarOpen"
          @toggle-sidebar-collapse="toggleSidebarCollapse"
        />
        <!-- App and settings layouts are nested inside this shared dashboard shell. -->
        <OnboardingExploreBanner v-if="pendingOnboardingAppId" :app-id="pendingOnboardingAppId" />
        <main class="w-full h-full overflow-hidden">
          <RouterView class="h-full overflow-y-auto grow" />
        </main>
      </div>
    </div>
  </div>
</template>
