<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconBell from '~icons/heroicons/bell'
import IconChart from '~icons/heroicons/chart-bar'
import IconHammer from '~icons/lucide/hammer'
import IconTimer from '~icons/lucide/timer'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import OrgNativeBuildStatsPanel from '~/components/dashboard/OrgNativeBuildStatsPanel.vue'
import OrgNotificationStatsPanel from '~/components/dashboard/OrgNotificationStatsPanel.vue'
import Tabs from '~/components/Tabs.vue'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

type DashboardTab = 'usage' | 'builds' | 'delivery' | 'notifications'

const organizationStore = useOrganizationStore()
const dashboardApps = useDashboardAppsStore()
const { t } = useI18n()
const displayStore = useDisplayStore()
const scrollContainer = ref<HTMLElement | null>(null)
const activeTab = ref<DashboardTab>('usage')

const { currentOrganization } = storeToRefs(organizationStore)

const dashboardTabs = computed<Tab[]>(() => [
  { label: 'dashboard-tab-usage', icon: IconChart, key: 'usage' },
  { label: 'native-builds', icon: IconHammer, key: 'builds' },
  { label: 'update-delivery-latency', icon: IconTimer, key: 'delivery', badge: 'beta' },
  { label: 'notifications', icon: IconBell, key: 'notifications', badge: 'beta' },
])

const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const apps = computed(() => !lacksSecurityAccess.value && dashboardApps.currentOrgId === currentOrganization.value?.gid ? dashboardApps.apps : [])

const hasNoApps = computed(() => {
  return apps.value.length === 0
    && dashboardApps.currentOrgId === currentOrganization.value?.gid
    && dashboardApps.isLoaded
    && !dashboardApps.isLoading
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

watch([() => currentOrganization.value?.gid, lacksSecurityAccess], ([orgId, restricted]) => {
  if (orgId && !restricted)
    void dashboardApps.fetchApps()
}, { immediate: true })
displayStore.NavTitle = t('dashboard')
displayStore.defaultBack = '/apps'

function handleTab(key: string) {
  if (key === 'usage' || key === 'builds' || key === 'delivery' || key === 'notifications')
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
        data-native-scroll
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

          <div v-else-if="!lacksSecurityAccess && activeTab === 'builds'" class="mb-6">
            <OrgNativeBuildStatsPanel
              :key="['org-builds', currentOrganization?.gid || ''].join(':')"
              :org-id="currentOrganization?.gid || ''"
              :apps="apps"
            />
          </div>

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
          <div class="p-8 text-center bg-white rounded-xl border shadow-sm dark:bg-slate-800/60 dark:border-white/10">
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
