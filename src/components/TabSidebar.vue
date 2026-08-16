<script setup lang="ts">
import type { Tab } from './comp_def'
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const props = defineProps<{
  tabs: Tab[]
  activeTab: string
  noRoute?: boolean
}>()

const emit = defineEmits(['update:activeTab'])
const router = useRouter()
const { t } = useI18n()

function openLink(link: string) {
  emit('update:activeTab', link)
}
function isActive(to: string) {
  return router.currentRoute.value.path === to
}

function findTab(key: string) {
  return props.tabs.find(t => t.key === key)
}

watch(props, (p) => {
  // console.log('activeTab', p.activeTab)
  const tab = findTab(p.activeTab)
  if (!tab || props.noRoute)
    return
  if (tab.onClick) {
    tab.onClick(p.activeTab)
  }
  else {
    router.push(tab.key)
  }
})
watch(router.currentRoute, (p) => {
  emit('update:activeTab', p.path)
})
onMounted(() => {
  if (props.activeTab && props.activeTab !== router.currentRoute.value.path) {
    console.log('activeTab', props.activeTab)
    openLink(props.activeTab)
  }
})
</script>

<template>
  <div>
    <!-- Content -->
    <div class="mb-8 h-full bg-white rounded-lg border shadow-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <div class="flex flex-col h-full md:flex-row md:-mr-px">
        <div class="hidden overflow-x-scroll flex-nowrap py-6 px-3 border-b md:flex md:overflow-auto md:space-y-3 md:border-b-0 md:border-r no-scrollbar min-w-60 border-slate-300">
          <!-- Group 1 -->
          <div class="w-full">
            <ul class="flex flex-nowrap mr-3 md:block md:mr-0">
              <li v-for="(m, i) in tabs" :key="i" class="mr-0.5 w-full cursor-pointer md:mr-0 md:mb-0.5" @click="openLink(m.key)">
                <button type="button" :id="`tab-${m.label}`" class="flex items-center py-2 px-2.5 w-full whitespace-nowrap rounded-sm cursor-pointer hover:bg-gray-400 first-letter:uppercase" :class="{ 'text-blue-600 hover:text-blue-800': isActive(m.key), 'text-slate-400 hover:text-slate-100': !isActive(m.key) }">
                  <component :is="m.icon" class="mr-2 w-4 h-4 fill-current shrink-0" />
                  <span class="hidden text-sm font-medium md:block first-letter:uppercase">{{ t(m.label) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
        <Tabs :active-tab="activeTab" class="block w-full md:hidden" no-wrap :tabs="tabs" @update:active-tab="openLink" />
        <slot class="overflow-y-scroll h-full" />
      </div>
    </div>
  </div>
</template>
