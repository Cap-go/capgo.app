<script setup lang="ts">
import type { Tab } from './comp_def'
import { onClickOutside } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconBack from '~icons/lucide/arrow-left'
import IconSettings from '~icons/lucide/settings'
import { isSpoofTab, useAppNavigation } from '~/composables/useAppNavigation'
import { settingsSectionForPath, useSettingsNavigation } from '~/composables/useSettingsNavigation'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import DropdownProfile from '../components/dashboard/DropdownProfile.vue'
import GettingStartedNav from '../components/dashboard/GettingStartedNav.vue'
import LogAsDialogField from './LogAsDialogField.vue'

const props = defineProps<{
  sidebarOpen: boolean
  sidebarCollapsed?: boolean
}>()

const emit = defineEmits(['closeSidebar'])
const main = useMainStore()
const organizationStore = useOrganizationStore()
const route = useRoute()
const isRail = computed(() => !!props.sidebarCollapsed)
const { t } = useI18n()
const sidebar = useTemplateRef('sidebar')
const {
  tabs,
  openTab,
  isTabActive,
  tabLabel,
  spoofLoading,
} = useAppNavigation({ onNavigate: () => emit('closeSidebar') })

const {
  section: settingsSection,
  tabs: settingsTabs,
  activeKey: activeSettingsKey,
} = useSettingsNavigation()

onClickOutside(sidebar, () => emit('closeSidebar'))

// "Go back" from settings returns to the last console page visited before them.
const lastConsolePath = ref('/dashboard')
watch(() => route.fullPath, (fullPath) => {
  if (!settingsSectionForPath(route.path))
    lastConsolePath.value = fullPath
}, { immediate: true })
const backTab = computed<Tab>(() => ({ label: 'go-back', icon: IconBack, key: lastConsolePath.value }))

// Settings of the organization currently selected in the switcher.
const organizationSettingsTab: Tab = { label: 'settings', icon: IconSettings, key: '/settings/organization' }

interface NavGroup { key: string, label?: string, tabs: Tab[] }

const navGroups = computed<NavGroup[]>(() => {
  // Settings get their own flat navigation: top-level pages first, then one titled group per sub-section.
  if (settingsSection.value) {
    return [
      { key: 'settings', label: settingsSection.value, tabs: settingsTabs.value.filter(tab => !tab.children?.length) },
      ...settingsTabs.value
        .filter(tab => tab.children?.length)
        .map(tab => ({ key: tab.key, label: tab.label, tabs: tab.children! })),
    ].filter(group => group.tabs.length)
  }
  // Group destinations the way capgo.app groups products: where you work first,
  // then help and community links that open outside the console.
  const workspaceTabs = tabs.value.filter(tab => !tab.redirect)
  return [
    { key: 'workspace', label: 'section-group-workspace', tabs: organizationStore.currentOrganization ? [...workspaceTabs, organizationSettingsTab] : workspaceTabs },
    { key: 'help', label: 'sidebar-group-help', tabs: tabs.value.filter(tab => tab.redirect) },
  ].filter(group => group.tabs.length)
})

function isNavTabActive(tab: Tab) {
  return settingsSection.value ? tab.key === activeSettingsKey.value : isTabActive(tab.key)
}
</script>

<template>
  <div>
    <!-- Sidebar backdrop (mobile only) -->
    <div
      class="fixed inset-0 transition-opacity duration-200 lg:hidden z-60"
      :class="{
        'bg-slate-900/50 cursor-pointer': props.sidebarOpen,
        'bg-slate-900/0 pointer-events-none': !props.sidebarOpen,
      }"
      aria-hidden="true"
      @click="emit('closeSidebar')"
    />

    <!-- Sidebar -->
    <div
      id="sidebar"
      ref="sidebar"
      class="fixed z-60 left-4 top-16 h-[calc(100%-4rem)] w-64 flex shrink-0 flex-col overflow-x-hidden bg-slate-800 rounded-xl shadow-lg transition-transform duration-200 ease-out motion-reduce:!transition-none lg:static lg:left-0 lg:top-0 lg:h-full lg:overflow-hidden lg:bg-slate-800 lg:rounded-none lg:shadow-none lg:translate-x-0 lg:transition-[width] lg:duration-500 lg:ease-in-out"
      :class="{
        'translate-x-0': props.sidebarOpen,
        '-translate-x-[120%]': !props.sidebarOpen,
        'lg:w-64': !isRail,
        'lg:w-12': isRail,
      }"
    >
      <div
        class="flex h-full w-64 min-w-64 flex-col transition-[padding-inline] duration-500 ease-in-out motion-reduce:!transition-none"
        :class="isRail ? 'px-0' : 'px-3'"
      >
        <!-- Sidebar header -->
        <div class="flex border-b shrink-0 border-slate-800 lg:border-slate-700 py-4">
          <router-link
            class="group flex items-center rounded-lg cursor-pointer focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none focus:ring-offset-slate-800"
            to="/apps"
            aria-label="Capgo - Go to dashboard"
          >
            <span class="flex w-12 h-11 shrink-0 items-center justify-center">
              <img src="/capgo.webp" alt="Capgo logo" class="w-8 h-8 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.3,1.6,0.5,1)] group-hover:rotate-90 group-hover:scale-105 motion-reduce:transition-none">
            </span>
            <!-- The rail is 48px wide: hide the wordmark so its first letter does not peek past the logo. -->
            <CapgoWordtype
              class="-ml-1 h-6 w-auto shrink-0 text-slate-200 transition-[opacity,translate,color] duration-300 ease-in-out group-hover:text-white motion-reduce:transition-none"
              :class="isRail ? 'pointer-events-none -translate-x-3 opacity-0' : 'translate-x-0 opacity-100'"
              :aria-hidden="isRail"
            />
          </router-link>
        </div>

        <GettingStartedNav v-if="!settingsSection" :compact="isRail" />

        <button
          v-if="settingsSection"
          type="button"
          data-test="sidebar-settings-back"
          class="mt-2 mb-2 d-btn d-btn-ghost flex justify-start items-center w-full h-auto min-h-10 p-0 rounded-lg border-none shadow-none font-normal text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
          :title="isRail ? t('go-back') : undefined"
          :aria-label="t('go-back')"
          @click="openTab(backTab)"
        >
          <span class="flex w-12 h-10 shrink-0 items-center justify-center">
            <IconBack class="w-5 h-5" />
          </span>
          <span class="pr-3 text-sm font-medium whitespace-nowrap">{{ t('go-back') }}</span>
        </button>

        <!-- Organization dropdown (hidden in settings: switching org sends you back to the dashboard) -->
        <div v-if="!settingsSection" class="shrink-0 py-2">
          <dropdown-organization v-if="main.user" :compact="isRail" />
        </div>

        <!-- Navigation: product areas first, help and community links after -->
        <nav
          class="flex-1 overflow-y-auto overflow-x-hidden py-2 transition-[row-gap] duration-500 ease-in-out motion-reduce:!transition-none flex flex-col"
          :class="isRail ? 'gap-y-2' : 'gap-y-5'"
          :aria-label="t('pages')"
        >
          <div v-for="group, groupIndex in navGroups" :key="group.key" :data-test="`sidebar-group-${group.key}`">
            <!-- The rail hides group headings, so a short rule keeps the groups visually apart. -->
            <div
              v-if="groupIndex > 0"
              class="mx-3 h-px bg-slate-700 transition-[opacity,margin] duration-300 ease-in-out motion-reduce:!transition-none"
              :class="isRail ? 'mb-2 opacity-100' : 'mb-0 opacity-0'"
              aria-hidden="true"
            />
            <!-- Collapse the heading's height in the rail so icons don't float under an invisible label. -->
            <h3
              v-if="group.label"
              class="overflow-hidden pl-12 pr-3 font-mono text-[11px] leading-4 font-semibold tracking-widest uppercase whitespace-nowrap text-slate-500 transition-[opacity,height,margin] duration-300 ease-in-out motion-reduce:!transition-none"
              :class="isRail ? 'h-0 mb-0 opacity-0' : 'h-4 mb-2 opacity-100'"
            >
              {{ t(group.label) }}
            </h3>
            <ul class="space-y-1">
              <li v-for="tab, i in group.tabs" :key="i">
                <button
                  type="button"
                  class="relative d-btn d-btn-ghost flex justify-start items-center w-full h-auto p-0 rounded-md border-none shadow-none transition-colors duration-150 cursor-pointer lg:rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500 text-slate-200 lg:text-slate-200 lg:hover:bg-slate-700/50 hover:bg-slate-700/50"
                  :class="{
                    'min-h-11': !tab.redirect,
                    'min-h-10': tab.redirect,
                    'hover:bg-slate-700/50 lg:hover:bg-slate-700/50': !isNavTabActive(tab),
                    'bg-slate-700 text-white lg:bg-slate-700 lg:text-white': isNavTabActive(tab),
                    'cursor-default': isNavTabActive(tab),
                    'opacity-50 cursor-not-allowed': isSpoofTab(tab) && spoofLoading,
                  }"
                  :disabled="isSpoofTab(tab) && spoofLoading"
                  :title="isRail ? tabLabel(tab) : undefined"
                  :aria-label="tab.redirect ? `${tabLabel(tab)} (opens in new tab)` : tabLabel(tab)"
                  :aria-current="isNavTabActive(tab) ? 'page' : undefined"
                  @click="openTab(tab)"
                >
                  <span
                    v-if="isNavTabActive(tab)"
                    class="absolute left-1 w-1 h-5 -translate-y-1/2 rounded-full top-1/2 bg-azure-500"
                    aria-hidden="true"
                  />
                  <span class="flex w-12 h-10 shrink-0 items-center justify-center">
                    <Spinner v-if="isSpoofTab(tab) && spoofLoading" size="w-5 h-5" />
                    <component :is="tab.icon" v-else class="w-5 h-5 transition-colors duration-150 shrink-0" :class="{ 'text-blue-500 lg:text-blue-500': isNavTabActive(tab), 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300': !isNavTabActive(tab) }" />
                  </span>
                  <span
                    class="flex items-center pr-3 font-medium capitalize whitespace-nowrap"
                    :class="[
                      isNavTabActive(tab) ? 'text-blue-500 lg:text-blue-500' : 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300',
                      tab.redirect ? 'text-[13px]' : 'text-sm',
                    ]"
                  >
                    {{ isSpoofTab(tab) && spoofLoading ? t('loading') : tabLabel(tab) }}
                    <svg v-if="tab.redirect" class="w-3 h-3 ml-1 opacity-60" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
                      <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
                    </svg>
                  </span>
                </button>
              </li>
            </ul>
          </div>
        </nav>

        <!-- User menu -->
        <div class="mt-auto shrink-0 pt-2 pb-3 lg:border-t lg:border-slate-700 lg:mt-0">
          <div v-if="main.user" class="flex items-center">
            <DropdownProfile class="w-full" :compact="isRail" />
          </div>
        </div>
      </div>
    </div>
    <LogAsDialogField />
  </div>
</template>
