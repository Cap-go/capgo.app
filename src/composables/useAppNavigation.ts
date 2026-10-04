import type { Tab } from '~/components/comp_def'
import { Capacitor } from '@capacitor/core'
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

// Shared across every consumer (web sidebar and native chrome) so the log-as
// dialog input and spoof state stay in sync whichever surface opened them.
const spoofed = ref(isSpoofed())
const spoofLoading = ref(false)
const logAsInput = ref('')

export function normalizeNavigationPath(path: string) {
  let normalizedPath = path

  while (normalizedPath.length > 1 && normalizedPath.endsWith('/'))
    normalizedPath = normalizedPath.slice(0, -1)

  return normalizedPath || '/'
}

export function isNavigationPathActive(tabKey: string, path: string) {
  if (tabKey === '#' || tabKey.startsWith('#'))
    return false

  const currentPath = normalizeNavigationPath(path)
  const activePaths = tabKey === '/apps' ? ['/apps', '/app'] : [tabKey]

  return activePaths.some((activePath) => {
    const tabPath = normalizeNavigationPath(activePath)

    return currentPath === tabPath || currentPath.startsWith(`${tabPath}/`)
  })
}

export function isSpoofTab(tab: Tab) {
  return tab.key === '#log-as' || tab.key === '#unspoof'
}

/**
 * Console destinations shared by the web sidebar and the native Capacitor
 * tabbar/menu, plus the navigation side effects (onboarding confirmation,
 * log-as, unspoof) that must behave the same on both surfaces.
 */
export function useAppNavigation(options: { onNavigate?: () => void } = {}) {
  const main = useMainStore()
  const organizationStore = useOrganizationStore()
  const dialogStore = useDialogV2Store()
  const router = useRouter()
  const route = useRoute()
  const { t } = useI18n()
  const isNativePlatform = Capacitor.isNativePlatform()

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

  function isTabActive(tab: string) {
    return isNavigationPathActive(tab, route.path)
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
      options.onNavigate?.()
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
    options.onNavigate?.()
  }

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

  function tabLabel(tab: Tab) {
    if (tab.key === '/app/modules_test')
      return `${t('module-heading')} ${t('tests')}`
    return t(tab.label)
  }

  return {
    tabs,
    openTab,
    isTabActive,
    tabLabel,
    spoofLoading,
    logAsInput,
    submitLogAsDialog,
  }
}
