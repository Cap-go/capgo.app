<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import OnboardingExploreBanner from '~/components/dashboard/OnboardingExploreBanner.vue'
import { useRealtimeCLIFeed } from '~/composables/useRealtimeCLIFeed'
import { useSupabase } from '~/services/supabase'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
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

function getRouteAppId() {
  const match = route.path.match(/^\/app\/([^/]+)/)
  if (!match?.[1] || match[1] === 'new')
    return ''

  try {
    return decodeURIComponent(match[1])
  }
  catch {
    return match[1]
  }
}

async function refreshPendingOnboardingApp() {
  const lookupRun = ++onboardingLookupRun
  pendingOnboardingAppId.value = ''

  if (/^\/app\/new\/?$/.test(route.path) || route.path === '/onboarding' || route.path.startsWith('/onboarding/'))
    return

  await organizationStore.awaitInitialLoad()

  const singleOrganization = selectableOrganizations.value.length === 1
    ? selectableOrganizations.value[0]
    : undefined
  const routeAppId = getRouteAppId()

  let query = supabase
    .from('apps')
    .select('app_id')
    .eq('need_onboarding', true)
    .order('created_at', { ascending: false })
    .limit(1)

  if (singleOrganization)
    query = query.eq('owner_org', singleOrganization.gid)
  else if (routeAppId)
    query = query.eq('app_id', routeAppId)
  else
    return

  const { data, error } = await query.maybeSingle()

  if (lookupRun !== onboardingLookupRun)
    return

  if (error) {
    console.error('Cannot resolve pending onboarding app', error)
    return
  }

  pendingOnboardingAppId.value = data?.app_id ?? ''
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
