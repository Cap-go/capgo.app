<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BuilderIntroduction from '~/components/dashboard/BuilderIntroduction.vue'
import Navbar from '~/components/Navbar.vue'
import Sidebar from '~/components/Sidebar.vue'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const available = import.meta.env.DEV
const sidebarOpen = ref(false)
const sidebarCollapsed = ref(false)
const displayStore = useDisplayStore()

onMounted(() => {
  displayStore.NavTitle = t('builds')
})
</script>

<template>
  <div v-if="available" class="flex h-full overflow-hidden bg-slate-100 pt-safe safe-areas lg:bg-slate-800 dark:bg-slate-900 lg:dark:bg-slate-800" data-test="builder-dashboard-preview">
    <Sidebar :sidebar-open="sidebarOpen" :sidebar-collapsed="sidebarCollapsed" @close-sidebar="sidebarOpen = false" />
    <div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden lg:p-3">
      <div class="flex h-full flex-col overflow-hidden border-gray-200 bg-slate-100 lg:rounded-xl lg:border lg:shadow-sm dark:border-gray-700 dark:bg-slate-900">
        <Navbar
          :sidebar-open="sidebarOpen"
          :sidebar-collapsed="sidebarCollapsed"
          @toggle-sidebar="sidebarOpen = !sidebarOpen"
          @toggle-sidebar-collapse="sidebarCollapsed = !sidebarCollapsed"
        />
        <main class="h-full w-full overflow-y-auto px-0 pt-6 sm:px-6 md:pt-8 lg:px-8">
          <BuilderIntroduction entitlement="plan" />
        </main>
      </div>
    </div>
  </div>
  <div v-else />
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
