<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PaymentRequiredModal from '~/components/PaymentRequiredModal.vue'
import Tabs from '~/components/Tabs.vue'
import { appTabs as baseAppTabs } from '~/constants/appTabs'
import { bundleTabs } from '~/constants/bundleTabs'
import { channelTabs } from '~/constants/channelTabs'
import { deviceTabs } from '~/constants/deviceTabs'
import { logTabs } from '~/constants/logTabs'
import { observeTabs } from '~/constants/observeTabs'
import { useOrganizationStore } from '~/stores/organization'

const router = useRouter()
const route = useRoute()
const organizationStore = useOrganizationStore()
const isResolvingAppOrganization = ref(false)

// Decoded app ID from the route. Use this for data lookups.
const appId = computed(() => {
  if (!('app' in route.params))
    return ''

  const appParam = route.params.app
  if (Array.isArray(appParam))
    return appParam[0] ?? ''

  return typeof appParam === 'string' ? appParam : ''
})

// Original encoded app route segment. Use this for URLs so tabs preserve
// app IDs that contain reserved characters such as `/`.
const appRouteSegment = computed(() => {
  const match = route.path.match(/^\/app\/([^/]+)/)
  return match ? match[1] : (appId.value ? encodeURIComponent(appId.value) : '')
})

watch(appId, async (targetAppId) => {
  if (!targetAppId) {
    isResolvingAppOrganization.value = false
    return
  }

  isResolvingAppOrganization.value = true
  try {
    await organizationStore.awaitInitialLoad()
    if (appId.value !== targetAppId)
      return

    const appOrganization = organizationStore.getOrgByAppId(targetAppId)
    if (!appOrganization || organizationStore.currentOrganization?.gid === appOrganization.gid)
      return

    organizationStore.setCurrentOrganization(appOrganization.gid)
  }
  finally {
    if (appId.value === targetAppId)
      isResolvingAppOrganization.value = false
  }
}, { immediate: true })

const appTabs = computed<Tab[]>(() => baseAppTabs)

// Check if org payment has failed - only show info tab in this case
const isOrgUnpaid = computed(() => {
  return organizationStore.currentOrganizationFailed
})

// Check if we're on the info page (which should not show the payment modal)
const isOnInfoPage = computed(() => {
  return route.path.endsWith('/info')
})

// Show payment overlay only when org is unpaid AND not on info page
const showPaymentOverlay = computed(() => {
  return !isResolvingAppOrganization.value && isOrgUnpaid.value && !isOnInfoPage.value
})

// Detect resource type from route (channel, device, or bundle)
const resourceType = computed(() => {
  if (route.path.includes('/channel/'))
    return 'channel'
  if (route.path.includes('/device/'))
    return 'device'
  if (route.path.includes('/bundle/'))
    return 'bundle'
  return null
})

const resourceId = computed(() => {
  if (!resourceType.value)
    return ''
  const match = route.path.match(new RegExp(`\\/${resourceType.value}\\/([^/]+)`))
  return match ? match[1] : ''
})

// Generate tabs with full paths for the current app
const tabs = computed<Tab[]>(() => {
  if (!appRouteSegment.value)
    return appTabs.value

  // Filter tabs when org is unpaid - only show info tab
  const availableTabs = isOrgUnpaid.value
    ? appTabs.value.filter(tab => tab.key === '/info')
    : appTabs.value

  return availableTabs.map(tab => ({
    ...tab,
    key: tab.key ? `/app/${appRouteSegment.value}${tab.key}` : `/app/${appRouteSegment.value}`,
  }))
})
const appSectionType = computed(() => {
  if (/^\/app\/[^/]+\/logs(?:\/|$)/.test(route.path))
    return 'logs'
  if (/^\/app\/[^/]+\/observe(?:\/|$)/.test(route.path))
    return 'observe'
  return null
})

const secondaryTabType = computed(() => resourceType.value ?? appSectionType.value)

const secondaryTabBasePath = computed(() => {
  if (!appRouteSegment.value || !secondaryTabType.value)
    return ''
  if (resourceType.value && resourceId.value)
    return `/app/${appRouteSegment.value}/${resourceType.value}/${resourceId.value}`
  if (secondaryTabType.value === 'logs')
    return `/app/${appRouteSegment.value}/logs`
  if (secondaryTabType.value === 'observe')
    return `/app/${appRouteSegment.value}/observe`
  return ''
})

// Get appropriate secondary tabs based on resource or app section type
const tabsConfig: Record<string, Tab[]> = {
  channel: channelTabs,
  device: deviceTabs,
  bundle: bundleTabs,
  logs: logTabs,
  observe: observeTabs,
}

// Generate secondary tabs with full paths for the current resource or app section
const secondaryTabs = computed<Tab[]>(() => {
  if (!secondaryTabBasePath.value || !secondaryTabType.value)
    return []

  const baseTabs = tabsConfig[secondaryTabType.value] || []

  return baseTabs.map(tab => ({
    ...tab,
    key: tab.key ? `${secondaryTabBasePath.value}${tab.key}` : secondaryTabBasePath.value,
  }))
})

// Parent tab mapping for each resource type
const parentTabMap: Record<string, string> = {
  channel: 'channels',
  device: 'devices',
  bundle: 'bundles',
}

const activeTab = computed(() => {
  const path = route.path.replace(/\/$/, '')

  if (!appRouteSegment.value)
    return tabs.value[0]?.key ?? ''

  if (appSectionType.value === 'logs')
    return `/app/${appRouteSegment.value}/logs/insights`
  // If on a resource detail page (bundle/channel/device), keep parent tab active
  if (resourceType.value) {
    const parentTab = parentTabMap[resourceType.value]
    return `/app/${appRouteSegment.value}/${parentTab}`
  }

  // Prefer exact match.
  const exactTab = tabs.value.find((t) => {
    const tabKey = t.key.replace(/\/$/, '')
    return path === tabKey
  })

  if (exactTab)
    return exactTab.key

  // Fallback: nested pages under a tab should keep the parent tab active.
  const prefixMatch = tabs.value
    .map(t => ({ t, tabKey: t.key.replace(/\/$/, '') }))
    .filter(({ tabKey }) => path.startsWith(`${tabKey}/`))
    .sort((a, b) => b.tabKey.length - a.tabKey.length)[0]

  return prefixMatch?.t.key ?? `/app/${appRouteSegment.value}`
})

const activeSecondaryTab = computed(() => {
  const path = route.path.replace(/\/$/, '')

  // Match the full path to a secondary tab
  const tab = secondaryTabs.value.find((t) => {
    const tabKey = t.key.replace(/\/$/, '')
    return path === tabKey
  })

  return tab?.key ?? secondaryTabBasePath.value
})

function handleTab(key: string) {
  router.push(key)
}

function handleSecondaryTab(key: string) {
  router.push(key)
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
    <main class="relative flex flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div
        class="flex-1 w-full min-h-0 mx-auto"
        :class="showPaymentOverlay ? 'overflow-hidden blur-sm pointer-events-none select-none' : 'overflow-y-auto'"
      >
        <RouterView class="w-full" />
      </div>
      <PaymentRequiredModal v-if="showPaymentOverlay" />
    </main>
  </div>
</template>
