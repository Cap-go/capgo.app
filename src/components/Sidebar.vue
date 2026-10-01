<script setup lang="ts">
import type { Tab } from './comp_def'
import { Capacitor } from '@capacitor/core'
import { onClickOutside } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconDoc from '~icons/gg/loadbar-doc'
import IconChart from '~icons/heroicons/chart-bar'
import IconShield from '~icons/heroicons/shield-check'
import IconDiscord from '~icons/ic/round-discord'
import IconBoxes from '~icons/lucide/boxes'
import IconFlask from '~icons/lucide/flask-conical'
import IconGift from '~icons/lucide/gift'
import IconHeadset from '~icons/lucide/headset'
import IconScanQrCode from '~icons/lucide/scan-qr-code'
import IconVenetianMask from '~icons/lucide/venetian-mask'
import IconApiKey from '~icons/mdi/shield-key'
import IconAppStore from '~icons/simple-icons/appstore'
import { ADMIN_DASHBOARD_URL } from '~/constants/adminDashboard'
import { logAsUser } from '~/services/logAs'
import { isSpoofed, unspoofUser } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import {
  allowOnboardingDashboardExploration,
  getAppGettingStartedPath,
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
const organizationStore = useOrganizationStore()
const isRail = computed(() => !!props.sidebarCollapsed)
const dialogStore = useDialogV2Store()
const router = useRouter()
const { t } = useI18n()
const sidebar = useTemplateRef('sidebar')
const route = useRoute()
const isNativePlatform = Capacitor.isNativePlatform()
const spoofed = ref(isSpoofed())
const spoofLoading = ref(false)
const logAsInput = ref('')

onClickOutside(sidebar, () => emit('closeSidebar'))

function isSpoofTab(tab: Tab) {
  return tab.key === '#log-as' || tab.key === '#unspoof'
}

async function openLogAsDialog() {
  let identifier = ''
  logAsInput.value = ''

  dialogStore.openDialog({
    title: t('log-as'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('log-as'),
        role: 'primary',
        handler: () => {
          identifier = logAsInput.value
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()

  if (identifier) {
    spoofLoading.value = true
    try {
      await logAsUser(identifier, router)
    }
    catch {
      // logAsUser already shows an error toast
    }
    finally {
      spoofLoading.value = false
    }
  }
}

function submitLogAsDialog() {
  const logAsButton = dialogStore.dialogOptions?.buttons?.find(button => button.text === t('log-as') && button.role !== 'cancel')
  if (logAsButton)
    void dialogStore.closeDialog(logAsButton)
}

async function resetSpoofedUser() {
  spoofLoading.value = true
  try {
    const restored = await unspoofUser()
    spoofed.value = isSpoofed()

    if (!restored) {
      if (!spoofed.value)
        toast.error(t('spoof-session-cleared'))
      return
    }

    toast.success(t('spoof-stopped-reload'))
    setTimeout(() => {
      router.replace('/dashboard').then(() => {
        globalThis.location.reload()
      })
    }, 1000)
  }
  finally {
    spoofLoading.value = false
  }
}

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
  if (isSpoofTab(tab) && spoofLoading.value)
    return

  const onboardingUserId = main.user?.id ?? main.auth?.id
  const gettingStartedAppId = route.name === '/app/[app].getting-started' && typeof route.params.app === 'string'
    ? route.params.app
    : null
  const isPendingOnboardingResume = !!gettingStartedAppId
    && organizationStore.getAppByAppId(gettingStartedAppId)?.need_onboarding === true
  const onboardingResumeAppId = isPendingOnboardingResume
    ? gettingStartedAppId
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
    if (dialogStore.lastButtonRole === 'secondary' && onboardingResumeAppId) {
      return router.push(getAppGettingStartedPath(onboardingResumeAppId))
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
    {
      label: 'refer-and-earn',
      icon: IconGift,
      key: '#refer-and-earn',
      onClick: () => window.open('https://capgo.affonso.io', '_blank', 'noopener,noreferrer'),
      redirect: true,
    },
    ...(isNativePlatform
      ? [
          {
            label: 'module-heading',
            icon: IconBoxes,
            key: '/app/modules',
          },
          {
            label: 'tests',
            icon: IconFlask,
            key: '/app/modules_test',
          },
        ]
      : []),
  ]

  // Add admin dashboard link if user is admin
  if (main.isAdmin) {
    baseTabs.splice(2, 0, {
      label: 'admin-dashboard',
      icon: IconShield,
      key: '#admin-dashboard',
      onClick: () => window.open(ADMIN_DASHBOARD_URL, '_blank', 'noopener,noreferrer'),
      redirect: true,
    })
  }

  if (main.isAdmin && !spoofed.value) {
    baseTabs.push({
      label: 'log-as',
      icon: IconVenetianMask,
      key: '#log-as',
      onClick: () => {
        void openLogAsDialog()
      },
    })
  }

  if (spoofed.value) {
    baseTabs.push({
      label: 'reset-spoofed-user',
      icon: IconVenetianMask,
      key: '#unspoof',
      onClick: () => {
        void resetSpoofedUser()
      },
    })
  }

  return baseTabs
})

// Group destinations the way capgo.app groups products: where you work first,
// then help and community links that open outside the console.
const navGroups = computed(() => [
  { key: 'workspace', label: 'section-group-workspace', tabs: tabs.value.filter(tab => !tab.redirect) },
  { key: 'help', label: 'sidebar-group-help', tabs: tabs.value.filter(tab => tab.redirect) },
].filter(group => group.tabs.length))

function tabLabel(tab: Tab) {
  if (tab.key === '/app/modules_test')
    return `${t('module-heading')} ${t('tests')}`
  return t(tab.label)
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
            <CapgoWordtype class="-ml-1 h-6 w-auto shrink-0 text-slate-200 transition-colors group-hover:text-white" />
          </router-link>
        </div>

        <GettingStartedNav :compact="isRail" />

        <!-- Organization dropdown -->
        <div class="shrink-0 py-2">
          <dropdown-organization v-if="main.user" :compact="isRail" />
        </div>

        <!-- Navigation: product areas first, help and community links after -->
        <nav class="flex-1 space-y-5 overflow-y-auto py-2" :aria-label="t('pages')">
          <div v-for="group in navGroups" :key="group.key" :data-test="`sidebar-group-${group.key}`">
            <h3
              class="pl-12 pr-3 mb-2 font-mono text-[11px] font-semibold tracking-widest uppercase whitespace-nowrap text-slate-500 transition-opacity duration-300"
              :class="isRail ? 'opacity-0' : 'opacity-100'"
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
                    'hover:bg-slate-700/50 lg:hover:bg-slate-700/50': !isTabActive(tab.key),
                    'bg-slate-700 text-white lg:bg-slate-700 lg:text-white': isTabActive(tab.key),
                    'cursor-default': isTabActive(tab.key),
                    'opacity-50 cursor-not-allowed': isSpoofTab(tab) && spoofLoading,
                  }"
                  :disabled="isSpoofTab(tab) && spoofLoading"
                  :title="isRail ? tabLabel(tab) : undefined"
                  :aria-label="tab.redirect ? `${tabLabel(tab)} (opens in new tab)` : tabLabel(tab)"
                  :aria-current="isTabActive(tab.key) ? 'page' : undefined"
                  @click="openTab(tab)"
                >
                  <span
                    v-if="isTabActive(tab.key)"
                    class="absolute left-1 w-1 h-5 -translate-y-1/2 rounded-full top-1/2 bg-azure-500"
                    aria-hidden="true"
                  />
                  <span class="flex w-12 h-10 shrink-0 items-center justify-center">
                    <Spinner v-if="isSpoofTab(tab) && spoofLoading" size="w-5 h-5" />
                    <component :is="tab.icon" v-else class="w-5 h-5 transition-colors duration-150 shrink-0" :class="{ 'text-blue-500 lg:text-blue-500': isTabActive(tab.key), 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300': !isTabActive(tab.key) }" />
                  </span>
                  <span
                    class="flex items-center pr-3 font-medium capitalize whitespace-nowrap"
                    :class="[
                      isTabActive(tab.key) ? 'text-blue-500 lg:text-blue-500' : 'text-slate-400 group-hover:text-slate-300 lg:text-slate-400 lg:group-hover:text-slate-300',
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
        <div class="mt-auto shrink-0 pt-2 lg:border-t lg:border-slate-700 lg:mt-0">
          <div v-if="main.user" class="flex items-center">
            <DropdownProfile class="w-full" :compact="isRail" />
          </div>
        </div>
      </div>
    </div>
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('log-as')" to="#dialog-v2-content" defer>
      <div class="w-full">
        <label for="log-as-input" class="sr-only">{{ t('user-email-or-org-id') }}</label>
        <input
          id="log-as-input"
          v-model="logAsInput"
          type="text"
          :placeholder="t('user-email-or-org-id')"
          :aria-label="t('user-email-or-org-id')"
          class="p-3 w-full rounded-lg border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600"
          @keydown.enter.prevent="submitLogAsDialog"
        >
      </div>
    </Teleport>
  </div>
</template>
