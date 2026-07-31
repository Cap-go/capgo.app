<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import type { Database } from '~/types/supabase.types'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconBell from '~icons/heroicons/bell'
import IconChart from '~icons/heroicons/chart-bar'
import IconTimer from '~icons/lucide/timer'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import OrgNotificationStatsPanel from '~/components/dashboard/OrgNotificationStatsPanel.vue'
import Tabs from '~/components/Tabs.vue'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

type DashboardTab = 'usage' | 'delivery' | 'notifications'

const route = useRoute('/dashboard')
const organizationStore = useOrganizationStore()
const isLoading = ref(true)
const supabase = useSupabase()
const { t } = useI18n()
const displayStore = useDisplayStore()
const apps = ref<Database['public']['Tables']['apps']['Row'][]>([])
const scrollContainer = ref<HTMLElement | null>(null)
const activeTab = ref<DashboardTab>('usage')

const { currentOrganization } = storeToRefs(organizationStore)

const dashboardTabs = computed<Tab[]>(() => [
  { label: 'dashboard-tab-usage', icon: IconChart, key: 'usage' },
  { label: 'update-delivery-latency', icon: IconTimer, key: 'delivery', badge: 'beta' },
  { label: 'notifications', icon: IconBell, key: 'notifications', badge: 'beta' },
])

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const hasNoApps = computed(() => {
  return apps.value.length === 0
    && !isLoading.value
    && !organizationStore.currentOrganizationFailed
    && !lacksSecurityAccess.value
})

const paymentFailed = computed(() => {
  return organizationStore.currentOrganizationFailed && !lacksSecurityAccess.value
})

const shouldBlurContent = computed(() => hasNoApps.value || paymentFailed.value)

watch(shouldBlurContent, (blur) => {
  if (blur && scrollContainer.value)
    scrollContainer.value.scrollTop = 0
}, { flush: 'post' })

async function getMyApps() {
  await organizationStore.awaitInitialLoad()

  if (lacksSecurityAccess.value) {
    apps.value = []
    return
  }

  const currentGid = organizationStore.currentOrganization?.gid

  if (!currentGid) {
    console.error('Current organization is null, cannot fetch apps')
    apps.value = []
    return
  }

  const { data } = await supabase
    .from('apps')
    .select()
    .eq('owner_org', currentGid)

  apps.value = data ?? []
}

watch(currentOrganization, async () => {
  await getMyApps()
})

onMounted(async () => {
  if (route.path === '/dashboard') {
    isLoading.value = true
    await getMyApps()
    isLoading.value = false
    displayStore.NavTitle = t('dashboard')
  }
})
displayStore.NavTitle = t('dashboard')
displayStore.defaultBack = '/apps'

function handleTab(key: string) {
  if (key === 'usage' || key === 'delivery' || key === 'notifications')
    activeTab.value = key
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs
      v-if="!lacksSecurityAccess"
      :tabs="dashboardTabs"
      :active-tab="activeTab"
      no-wrap
      @update:active-tab="handleTab"
    />

    <main class="relative flex flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div
        ref="scrollContainer"
        class="relative flex-1 w-full min-h-0 px-4 pt-2 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl"
        :class="shouldBlurContent ? 'overflow-hidden' : 'overflow-y-auto'"
      >
        <FailedCard v-if="lacksSecurityAccess" />

        <TrialBanner v-if="!lacksSecurityAccess" />

        <div :class="{ 'blur-sm pointer-events-none select-none': shouldBlurContent }">
          <Usage
            v-if="!lacksSecurityAccess && activeTab === 'usage'"
            :force-demo="paymentFailed"
          />

          <div v-else-if="!lacksSecurityAccess && activeTab === 'delivery'" class="mb-6">
            <DeliveryLatencyPanel
              :key="['org', currentOrganization?.gid || ''].join(':')"
              scope="org"
              :org-id="currentOrganization?.gid || ''"
              :force-demo="paymentFailed"
            />
          </div>

          <div v-else-if="!lacksSecurityAccess && activeTab === 'notifications'" class="mb-6">
            <OrgNotificationStatsPanel
              :key="['org-notif', currentOrganization?.gid || ''].join(':')"
              :org-id="currentOrganization?.gid || ''"
              :force-demo="paymentFailed"
            />
          </div>
        </div>

        <div
          v-if="hasNoApps"
          class="flex absolute inset-0 z-10 flex-col justify-center items-center bg-white/60 dark:bg-gray-900/60"
        >
          <div class="p-8 text-center bg-white rounded-xl border shadow-lg dark:bg-gray-800 dark:border-gray-700">
            <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
              {{ t('no-apps-yet') }}
            </h2>
            <p class="mb-6 text-gray-600 dark:text-gray-400">
              {{ t('add-your-first-app-to-see-dashboard') }}
            </p>
            <router-link
              to="/app/new"
              class="inline-flex gap-2 items-center px-6 py-3 text-white bg-blue-600 rounded-lg transition-colors hover:bg-blue-700"
            >
              <span class="i-heroicons-plus-circle text-xl" />
              {{ t('add-app') }}
            </router-link>
          </div>
        </div>

        <PaymentRequiredModal v-if="paymentFailed" />
      </div>
    </main>
  </div>
</template>
