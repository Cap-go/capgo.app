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
import IconHeadset from '~icons/lucide/headset'
import IconScanQrCode from '~icons/lucide/scan-qr-code'
import IconApiKey from '~icons/mdi/shield-key'
import IconAppStore from '~icons/simple-icons/appstore'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import {
  allowOnboardingDashboardExploration,
  getOnboardingResumeAppId,
  ONBOARDING_DASHBOARD_EXPLORED_EVENT,
  shouldConfirmOnboardingDashboardExploration,
} from '~/utils/onboardingRedirect'
import DropdownProfile from '../components/dashboard/DropdownProfile.vue'
import GettingStartedNav from '../components/dashboard/GettingStartedNav.vue'

const props = defineProps<{
  sidebarOpen: boolean
  sidebarCollapsed?: boolean
}>()

const emit = defineEmits(['closeSidebar'])
const main = useMainStore()
const isRail = computed(() => !!props.sidebarCollapsed)
const dialogStore = useDialogV2Store()
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
async function openTab(tab: Tab) {
  const onboardingUserId = main.user?.id ?? main.auth?.id
  const resumeQueryAppId = typeof route.query.resume === 'string' ? route.query.resume : null
  const isPendingOnboardingResume = route.path === '/app/new'
    && !!resumeQueryAppId
  const onboardingResumeAppId = isPendingOnboardingResume
    ? resumeQueryAppId
    : getOnboardingResumeAppId(onboardingUserId)
  const requiresOnboardingExplorationConfirmation = shouldConfirmOnboardingDashboardExploration({
    destination: tab.key,
    resumeAppId: onboardingResumeAppId,
    userId: onboardingUserId,
  })

  if (tab.key === '/apikeys' && isPendingOnboardingResume)
    allowOnboardingDashboardExploration(onboardingUserId, onboardingResumeAppId)

  if (requiresOnboardingExplorationConfirmation) {
    emit('closeSidebar')
    dialogStore.openDialog({
      title: t('app-onboarding-explore-dashboard-confirm-title'),
      description: t('app-onboarding-explore-dashboard-confirm-description'),
      buttons: [
        { text: t('app-onboarding-continue-setup'), role: 'secondary' },
        { text: t('app-onboarding-explore-dashboard'), role: 'primary' },
      ],
    })
    const wasCanceled = await dialogStore.onDialogDismiss()
    if (wasCanceled)
      return
    if (dialogStore.lastButtonRole === 'secondary') {
      return router.push({ path: '/app/new', query: { resume: onboardingResumeAppId } })
    }
    if (dialogStore.lastButtonRole !== 'primary')
      return

    window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))
    allowOnboardingDashboardExploration(onboardingUserId, onboardingResumeAppId)
  }

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
    {
      label: 'support',
      icon: IconHeadset,
      key: '#support',
      onClick: () => window.open('https://support.capgo.app', '_blank', 'noopener,noreferrer'),
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
      class="fixed z-60 left-4 top-16 h-[calc(100%-4rem)] w-64 flex shrink-0 flex-col overflow-x-hidden bg-slate-800 rounded-xl shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none lg:static lg:left-0 lg:top-0 lg:h-full lg:overflow-hidden lg:bg-slate-800 lg:rounded-none lg:shadow-none lg:translate-x-0 lg:transition-[width] lg:duration-300 lg:ease-out"
      :class="{
        'translate-x-0': props.sidebarOpen,
        '-translate-x-[120%]': !props.sidebarOpen,
        'lg:w-64': !isRail,
        'lg:w-12': isRail,
      }"
    >
      <!-- Sidebar header -->
      <div
        class="flex border-b shrink-0 border-slate-800 lg:border-slate-700"
        :class="isRail ? 'justify-center px-1 py-3' : 'justify-between px-3 py-4 lg:py-6 lg:px-6'"
      >
        <router-link
          class="flex items-center rounded-lg cursor-pointer focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none focus:ring-offset-slate-800"
          :class="isRail ? 'justify-center' : 'p-1 space-x-2 lg:space-x-3'"
          to="/apps"
          aria-label="Capgo - Go to dashboard"
        >
          <img src="/capgo.webp" alt="Capgo logo" class="shrink-0" :class="isRail ? 'w-7 h-7' : 'w-8 h-8'">
          <span
            class="text-xl font-semibold truncate transition duration-150 hover:text-white font-prompt text-slate-200 lg:text-slate-200 lg:hover:text-white"
            :class="isRail ? 'sr-only' : ''"
          >
            Capgo
          </span>
        </router-link>
      </div>

      <GettingStartedNav :compact="isRail" />

      <!-- Organization dropdown -->
      <div class="shrink-0" :class="isRail ? 'flex justify-center px-1 py-2' : 'px-3 py-4 lg:py-4 lg:px-6'">
        <dropdown-organization v-if="main.user" :compact="isRail" />
      </div>

      <!-- Navigation -->
      <div class="flex-1 space-y-4 overflow-y-auto" :class="isRail ? 'px-1 py-2' : 'px-3 py-4 lg:py-6 lg:px-6'">
        <div>
          <h3
            class="text-xs font-semibold uppercase text-slate-500 lg:text-slate-500"
            :class="isRail ? 'sr-only' : 'mb-3 lg:mb-4 lg:tracking-wider'"
          >
            {{ t('pages') }}
          </h3>
          <ul class="space-y-1 lg:space-y-2">
            <li v-for="tab, i in tabs" :key="i">
              <button
                type="button"
                class="d-btn d-btn-ghost flex items-center w-full rounded-md border-none shadow-none transition duration-150 cursor-pointer lg:rounded-lg focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none text-slate-200 lg:text-slate-200 lg:hover:bg-slate-700/50 hover:bg-slate-700/50 focus:ring-offset-slate-800"
                :class="{
                  'd-btn-square justify-center p-1 min-h-9 h-9 min-w-0': isRail,
                  'justify-start h-auto p-3 lg:p-3 min-h-11': !isRail,
                  'hover:bg-slate-700/50 lg:hover:bg-slate-700/50': !isTabActive(tab.key),
                  'bg-slate-700 text-white lg:bg-slate-700 lg:text-white': isTabActive(tab.key),
                  'cursor-default': isTabActive(tab.key),
                }"
                :title="isRail ? t(tab.label) : undefined"
                :aria-label="tab.redirect ? `${t(tab.label)} (opens in new tab)` : t(tab.label)"
                :aria-current="isTabActive(tab.key) ? 'page' : undefined"
                @click="openTab(tab)"
              >
                <component :is="tab.icon" class="w-5 h-5 transition-colors duration-150 shrink-0" :class="{ 'text-blue-500 lg:text-blue-500': isTabActive(tab.key), 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300': !isTabActive(tab.key) }" />
                <span
                  class="items-center text-sm font-medium capitalize transition-colors duration-150"
                  :class="[
                    isRail ? 'sr-only' : 'flex ml-3',
                    isTabActive(tab.key) ? 'text-blue-500 lg:text-blue-500' : 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300',
                    tab.redirect && !isRail ? 'underline' : '',
                  ]"
                >
                  {{ t(tab.label) }}
                  <svg v-if="tab.redirect && !isRail" class="w-3 h-3 ml-1 opacity-60" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
      <div class="mt-auto shrink-0 lg:border-t lg:border-slate-700" :class="isRail ? 'pt-2' : 'pt-4 lg:pt-6 lg:mt-0'">
        <div v-if="main.user" class="flex items-center" :class="isRail ? 'justify-center' : ''">
          <DropdownProfile class="w-full" :compact="isRail" />
        </div>
      </div>
    </div>
  </div>
</template>
