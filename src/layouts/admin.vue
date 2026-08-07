<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tabs from '~/components/Tabs.vue'
import { adminTabs } from '~/constants/adminTabs'

const router = useRouter()
const route = useRoute()

// Generate tabs with full paths
const tabs = computed<Tab[]>(() => {
  return adminTabs.map(tab => ({
    ...tab,
    key: tab.key ? `/admin/dashboard${tab.key}` : '/admin/dashboard',
  }))
})

const activeTab = computed(() => {
  const path = route.path.replace(/\/$/, '')

  // Match the full path to a tab
  const tab = tabs.value.find((t) => {
    const tabKey = t.key.replace(/\/$/, '')
    return path === tabKey
  })

  return tab?.key ?? '/admin/dashboard'
})

function handleTab(key: string) {
  router.push({ path: key, query: route.query })
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs
      :tabs="tabs"
      :active-tab="activeTab"
      no-wrap
      @update:active-tab="handleTab"
    />
    <main class="flex flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div class="flex-1 w-full min-h-0 mx-auto overflow-y-auto">
        <RouterView class="w-full" />
      </div>
    </main>
  </div>
</template>
