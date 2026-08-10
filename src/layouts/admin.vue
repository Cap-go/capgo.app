<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tabs from '~/components/Tabs.vue'
import { adminCustomersTabs } from '~/constants/adminCustomersTabs'
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

type HubKey = 'onboarding' | 'product' | 'retention' | 'customers' | 'revenue' | 'platform'

const hubConfig: Record<HubKey, { base: string, tabs: Tab[] }> = {
  onboarding: { base: `${ADMIN_BASE}/onboarding`, tabs: adminOnboardingTabs },
  product: { base: `${ADMIN_BASE}/product`, tabs: adminProductTabs },
  retention: { base: `${ADMIN_BASE}/retention`, tabs: adminRetentionTabs },
  customers: { base: `${ADMIN_BASE}/customers`, tabs: adminCustomersTabs },
  revenue: { base: `${ADMIN_BASE}/revenue`, tabs: adminRevenueTabs },
  platform: { base: `${ADMIN_BASE}/platform`, tabs: adminPlatformTabs },
}

const activeHub = computed<HubKey | null>(() => {
  const path = route.path.replace(/\/$/, '')
  if (path.startsWith(`${ADMIN_BASE}/onboarding`))
    return 'onboarding'
  if (path.startsWith(`${ADMIN_BASE}/product`))
    return 'product'
  if (path.startsWith(`${ADMIN_BASE}/retention`))
    return 'retention'
  if (path.startsWith(`${ADMIN_BASE}/customers`))
    return 'customers'
  if (path.startsWith(`${ADMIN_BASE}/revenue`))
    return 'revenue'
  if (path.startsWith(`${ADMIN_BASE}/platform`))
    return 'platform'
  return null
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

  if (hub === 'onboarding')
    return `${ADMIN_BASE}/onboarding`
  if (hub === 'product')
    return `${ADMIN_BASE}/product/updates`
  if (hub === 'retention')
    return `${ADMIN_BASE}/retention`
  if (hub === 'customers')
    return `${ADMIN_BASE}/customers/organizations`
  if (hub === 'revenue')
    return `${ADMIN_BASE}/revenue`
  if (hub === 'platform')
    return `${ADMIN_BASE}/platform/replication`

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

  const hub = activeHub.value
  return prefixMatch?.t.key ?? (hub ? hubConfig[hub].base : undefined)
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
