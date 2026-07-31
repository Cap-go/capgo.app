<script setup lang="ts">
import type { Tab } from './comp_def'
import { Capacitor } from '@capacitor/core'
import { onClickOutside } from '@vueuse/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import IconDoc from '~icons/gg/loadbar-doc'
import IconChart from '~icons/heroicons/chart-bar'
import IconShield from '~icons/heroicons/shield-check'
import IconDiscord from '~icons/ic/round-discord'
import IconScanQrCode from '~icons/lucide/scan-qr-code'
import IconApiKey from '~icons/mdi/shield-key'
import IconAppStore from '~icons/simple-icons/appstore'
import { useMainStore } from '~/stores/main'
import DropdownProfile from '../components/dashboard/DropdownProfile.vue'

const props = defineProps <{
  sidebarOpen: boolean
}>()

const emit = defineEmits(['closeSidebar'])
const main = useMainStore()
const router = useRouter()
const { t } = useI18n()
const sidebar = useTemplateRef('sidebar')
const route = useRoute()
const isNativePlatform = Capacitor.isNativePlatform()

onClickOutside(sidebar, () => emit('closeSidebar'))

function normalizeSidebarPath(path: string) {
  let normalizedPath = path

  while (normalizedPath.length > 1 && normalizedPath.endsWith('/'))
    normalizedPath = normalizedPath.slice(0, -1)

  return normalizedPath || '/'
}

function isTabActive(tab: string) {
  if (tab === '#')
    return false

  const currentPath = normalizeSidebarPath(route.path)
  const activePaths = tab === '/apps' ? ['/apps', '/app'] : [tab]

  return activePaths.some((activePath) => {
    const tabPath = normalizeSidebarPath(activePath)

    return currentPath === tabPath || currentPath.startsWith(`${tabPath}/`)
  })
}
function openTab(tab: Tab) {
  if (tab.onClick)
    tab.onClick(tab.key)
  else
    router.push(tab.key)
  emit('closeSidebar')
}

// Computed tabs list that includes admin link if user is admin
const tabs = computed<Tab[]>(() => {
  const baseTabs: Tab[] = [
    {
      label: 'dashboard',
      icon: IconChart,
      key: '/dashboard',
    },
    {
      label: 'apps',
      icon: IconAppStore,
      key: '/apps',
    },
    ...(isNativePlatform
      ? [{
          label: 'test-preview',
          icon: IconScanQrCode,
          key: '/scan',
        }]
      : []),
    {
      label: 'api-keys',
      icon: IconApiKey,
      key: '/apikeys',
    },
    {
      label: 'documentation',
      icon: IconDoc,
      key: '#',
      onClick: () => window.open('https://capgo.app/docs', '_blank', 'noopener,noreferrer'),
      redirect: true,
    },
    {
      label: 'discord',
      icon: IconDiscord,
      key: '#',
      onClick: () => window.open('https://discord.capgo.app', '_blank', 'noopener,noreferrer'),
      redirect: true,
    },
  ]

  // Add admin dashboard link if user is admin
  if (main.isAdmin) {
    baseTabs.splice(2, 0, {
      label: 'admin-dashboard',
      icon: IconShield,
      key: '/admin/dashboard',
    })
  }

  return baseTabs
})
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
      class="fixed z-60 left-4 top-16 h-[calc(100%-4rem)] w-64 flex shrink-0 flex-col bg-slate-800 transition-all duration-200 ease-in-out rounded-xl shadow-lg lg:static lg:left-0 lg:top-0 lg:w-64 lg:h-full lg:bg-slate-800 lg:rounded-none lg:shadow-none lg:translate-x-0"
      :class="{
        'translate-x-0': props.sidebarOpen,
        '-translate-x-[120%]': !props.sidebarOpen,
      }"
    >
      <!-- Sidebar header -->
      <div class="flex justify-between px-3 py-4 border-b lg:py-6 lg:px-6 lg:border-b border-slate-800 shrink-0 lg:border-slate-700">
        <router-link
          class="flex items-center p-1 space-x-2 rounded-lg cursor-pointer lg:space-x-3 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none focus:ring-offset-slate-800"
          to="/apps"
          aria-label="Capgo - Go to dashboard"
        >
          <img src="/capgo.webp" alt="Capgo logo" class="w-8 h-8">
          <span class="text-xl font-semibold truncate transition duration-150 hover:text-white font-prompt text-slate-200 lg:text-slate-200 lg:hover:text-white">Capgo</span>
        </router-link>
      </div>

      <!-- Organization dropdown -->
      <div class="px-3 py-4 lg:py-4 lg:px-6 shrink-0">
        <dropdown-organization v-if="main.user" />
      </div>

      <!-- Navigation -->
      <div class="flex-1 px-3 py-4 space-y-4 overflow-y-auto lg:py-6 lg:px-6">
        <div>
          <h3 class="mb-3 text-xs font-semibold uppercase lg:mb-4 lg:tracking-wider text-slate-500 lg:text-slate-500">
            {{ t('pages') }}
          </h3>
          <ul class="space-y-1 lg:space-y-2">
            <li v-for="tab, i in tabs" :key="i">
              <button
                class="flex items-center p-3 w-full rounded-md transition duration-150 cursor-pointer lg:p-3 lg:rounded-lg focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none text-slate-200 min-h-11 lg:text-slate-200 lg:hover:bg-slate-700/50 hover:bg-slate-700/50 focus:ring-offset-slate-800"
                :class="{
                  'hover:bg-slate-700/50 lg:hover:bg-slate-700/50': !isTabActive(tab.key),
                  'bg-slate-700 text-white lg:bg-slate-700 lg:text-white': isTabActive(tab.key),
                  'cursor-default': isTabActive(tab.key),
                }"
                :aria-label="tab.redirect ? `${t(tab.label)} (opens in new tab)` : t(tab.label)"
                :aria-current="isTabActive(tab.key) ? 'page' : undefined"
                @click="openTab(tab)"
              >
                <component :is="tab.icon" class="w-5 h-5 transition-colors duration-150 shrink-0" :class="{ 'text-blue-500 lg:text-blue-500': isTabActive(tab.key), 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300': !isTabActive(tab.key) }" />
                <span class="flex items-center ml-3 text-sm font-medium capitalize transition-colors duration-150" :class="{ 'text-blue-500 lg:text-blue-500': isTabActive(tab.key), 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300': !isTabActive(tab.key), 'underline': tab.redirect }">
                  {{ t(tab.label) }}
                  <svg v-if="tab.redirect" class="w-3 h-3 ml-1 opacity-60" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
                    <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
                  </svg>
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <!-- User menu -->
      <div class="pt-4 mt-auto lg:pt-6 lg:mt-0 lg:border-t shrink-0 lg:border-slate-700">
        <div v-if="main.user" class="flex items-center">
          <DropdownProfile class="w-full" />
        </div>
      </div>
    </div>
  </div>
</template>
