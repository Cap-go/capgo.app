<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import type { AdminHubKey } from '~/constants/adminHubs'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tabs from '~/components/Tabs.vue'
import { adminCustomersTabs } from '~/constants/adminCustomersTabs'
import { adminHubPathPrefix, getAdminHubPrimaryKey } from '~/constants/adminHubs'
import { adminOnboardingTabs } from '~/constants/adminOnboardingTabs'
import { adminPlatformTabs } from '~/constants/adminPlatformTabs'
import { adminProductTabs } from '~/constants/adminProductTabs'
import { adminRetentionTabs } from '~/constants/adminRetentionTabs'
import { adminRevenueTabs } from '~/constants/adminRevenueTabs'
import { adminTabs } from '~/constants/adminTabs'

const router = useRouter()
const route = useRoute()

const ADMIN_BASE = '/admin/dashboard'

const tabs = computed<Tab[]>(() => {
  return adminTabs.map(tab => ({
    ...tab,
    key: `${ADMIN_BASE}${tab.key}`,
  }))
})

const hubConfig: Record<AdminHubKey, { base: string, tabs: Tab[] }> = {
  onboarding: { base: `${ADMIN_BASE}${adminHubPathPrefix.onboarding}`, tabs: adminOnboardingTabs },
  product: { base: `${ADMIN_BASE}${adminHubPathPrefix.product}`, tabs: adminProductTabs },
  retention: { base: `${ADMIN_BASE}${adminHubPathPrefix.retention}`, tabs: adminRetentionTabs },
  customers: { base: `${ADMIN_BASE}${adminHubPathPrefix.customers}`, tabs: adminCustomersTabs },
  revenue: { base: `${ADMIN_BASE}${adminHubPathPrefix.revenue}`, tabs: adminRevenueTabs },
  platform: { base: `${ADMIN_BASE}${adminHubPathPrefix.platform}`, tabs: adminPlatformTabs },
}

const activeHub = computed<AdminHubKey | null>(() => {
  const path = route.path.replace(/\/$/, '')
  const hubs = Object.keys(adminHubPathPrefix) as AdminHubKey[]
  return hubs.find(hub => path.startsWith(`${ADMIN_BASE}${adminHubPathPrefix[hub]}`)) ?? null
})

const secondaryTabs = computed<Tab[]>(() => {
  const hub = activeHub.value
  if (!hub)
    return []

  const { base, tabs: hubTabs } = hubConfig[hub]
  return hubTabs.map(tab => ({
    ...tab,
    key: tab.key ? `${base}${tab.key}` : base,
  }))
})

const activeTab = computed(() => {
  const path = route.path.replace(/\/$/, '')
  const hub = activeHub.value
  if (hub)
    return `${ADMIN_BASE}${getAdminHubPrimaryKey(hub)}`

  const exact = tabs.value.find((t) => {
    const tabKey = t.key.replace(/\/$/, '')
    return path === tabKey
  })
  if (exact)
    return exact.key

  const prefixMatch = tabs.value
    .map(t => ({ t, tabKey: t.key.replace(/\/$/, '') }))
    .filter(({ tabKey }) => path.startsWith(`${tabKey}/`))
    .sort((a, b) => b.tabKey.length - a.tabKey.length)[0]

  return prefixMatch?.t.key ?? `${ADMIN_BASE}/pulse`
})

const activeSecondaryTab = computed(() => {
  const path = route.path.replace(/\/$/, '')
  if (!secondaryTabs.value.length)
    return undefined

  const exact = secondaryTabs.value.find((t) => {
    const tabKey = t.key.replace(/\/$/, '')
    return path === tabKey
  })
  if (exact)
    return exact.key

  const prefixMatch = secondaryTabs.value
    .map(t => ({ t, tabKey: t.key.replace(/\/$/, '') }))
    .filter(({ tabKey }) => path.startsWith(`${tabKey}/`))
    .sort((a, b) => b.tabKey.length - a.tabKey.length)[0]

  return prefixMatch?.t.key ?? secondaryTabs.value[0]?.key
})

function handleTab(key: string) {
  router.push({ path: key, query: route.query })
}

function handleSecondaryTab(key: string) {
  router.push({ path: key, query: route.query })
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs
      :tabs="tabs"
      :active-tab="activeTab"
      :secondary-tabs="secondaryTabs"
      :secondary-active-tab="activeSecondaryTab"
      no-wrap
      @update:active-tab="handleTab"
      @update:secondary-active-tab="handleSecondaryTab"
    />
    <main class="flex flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div class="flex-1 w-full min-h-0 mx-auto overflow-y-auto">
        <RouterView class="w-full" />
      </div>
    </main>
  </div>
</template>
