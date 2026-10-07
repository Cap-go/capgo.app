import type { PluginListenerHandle } from '@capacitor/core'
import type { NativeNavigationTab } from '@capgo/capacitor-native-navigation'
import type { Tab } from '~/components/comp_def'
import { ActionSheet, ActionSheetButtonStyle } from '@capacitor/action-sheet'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { NativeNavigation } from '@capgo/capacitor-native-navigation'
import { useMediaQuery } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { isNavigationPathActive, useAppNavigation } from '~/composables/useAppNavigation'
import { useDisplayStore } from '~/stores/display'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

type PrimaryTabId = 'dashboard' | 'apps' | 'preview' | 'apikeys'
type NativeTabId = PrimaryTabId | 'more'

const PRIMARY_TABS: Record<PrimaryTabId, Tab> = {
  dashboard: { label: 'dashboard', key: '/dashboard' },
  apps: { label: 'apps', key: '/apps' },
  preview: { label: 'test-preview', key: '/scan' },
  apikeys: { label: 'api-keys', key: '/apikeys' },
}

// Lucide paths: Android renders these SVGs, iOS uses the SF Symbol.
const TAB_ICONS: Record<NativeTabId, NativeNavigationTab['icon']> = {
  dashboard: {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    ios: { sfSymbol: 'chart.bar' },
  },
  apps: {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    ios: { sfSymbol: 'square.grid.2x2' },
  },
  preview: {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    ios: { sfSymbol: 'qrcode.viewfinder' },
  },
  apikeys: {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
    ios: { sfSymbol: 'key' },
  },
  more: {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    ios: { sfSymbol: 'ellipsis.circle' },
  },
}

const ROOT_PATHS = ['/dashboard', '/apps', '/apikeys']

const BRAND_TINT = '#119EFF'
const DARK_COLORS = { background: '#0F172A', foreground: '#F8FAFC', inactiveTint: '#94A3B8' }
const LIGHT_COLORS = { background: '#F1F5F9', foreground: '#0F172A', inactiveTint: '#64748B' }

export const isNativeChromeEnabled = Capacitor.isNativePlatform()

/**
 * Drives the native Capacitor navbar and tabbar from the router so the
 * dashboard shell uses platform chrome instead of the web header/sidebar.
 * Active only while the dashboard layout is mounted.
 */
export function useNativeChrome() {
  const router = useRouter()
  const route = useRoute()
  const { t } = useI18n()
  const displayStore = useDisplayStore()
  const organizationStore = useOrganizationStore()
  const isDark = useMediaQuery('(prefers-color-scheme: dark)')
  const { tabs, openTab, tabLabel } = useAppNavigation()
  const listeners: PluginListenerHandle[] = []
  let active = false
  let moreMenuOpen = false

  const title = computed(() => {
    if (displayStore.NavTitle)
      return displayStore.NavTitle
    // Index access instead of .at(): older native WebViews lack Array.prototype.at.
    const last = displayStore.pathTitle[displayStore.pathTitle.length - 1]
    if (!last)
      return ''
    const name = last.translate === false ? last.name : t(last.name)
    return name.charAt(0).toUpperCase() + name.slice(1)
  })

  const selectedTabId = computed<NativeTabId>(() => {
    if (isNavigationPathActive('/apikeys', route.path))
      return 'apikeys'
    if (isNavigationPathActive('/dashboard', route.path))
      return 'dashboard'
    if (isNavigationPathActive('/apps', route.path) && !route.path.startsWith('/app/plugins'))
      return 'apps'
    if (isNavigationPathActive('/scan', route.path))
      return 'preview'
    return 'more'
  })

  const showBack = computed(() => !ROOT_PATHS.includes(route.path.replace(/\/+$/, '')) && !!router.options.history.state.back)

  // The navbar's trailing button shows the current organization and opens the switcher.
  const organizationLabel = computed(() => {
    const name = organizationStore.currentOrganization?.name ?? ''
    return name.length > 18 ? `${name.slice(0, 17)}…` : name
  })

  const moreTabs = computed<Tab[]>(() => [
    { label: 'settings', key: '/settings/account' },
    ...tabs.value.filter(tab => !Object.values(PRIMARY_TABS).some(primary => primary.key === tab.key)),
  ])
  const selectableOrganizations = computed(() => organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org)))

  function palette() {
    return isDark.value ? DARK_COLORS : LIGHT_COLORS
  }

  async function renderNavbar() {
    if (!active)
      return
    const colors = palette()
    await NativeNavigation.setNavbar({
      title: title.value,
      backButton: { visible: showBack.value },
      rightItems: organizationLabel.value ? [{ id: 'organization', title: organizationLabel.value }] : [],
      colors: { ...colors, tint: BRAND_TINT },
      animated: true,
    })
  }

  async function renderTabbar() {
    if (!active)
      return
    const colors = palette()
    const ids: NativeTabId[] = ['dashboard', 'apps', 'preview', 'apikeys', 'more']
    await NativeNavigation.setTabbar({
      selectedId: selectedTabId.value,
      labelVisibilityMode: 'labeled',
      colors: { ...colors, tint: BRAND_TINT },
      tabs: ids.map(id => ({
        id,
        title: id === 'more' ? t('more-menu') : t(PRIMARY_TABS[id].label),
        icon: TAB_ICONS[id],
      })),
    })
  }

  async function renderStatusBar() {
    if (!active)
      return
    await StatusBar.setStyle({ style: isDark.value ? Style.Dark : Style.Light }).catch(() => {})
  }

  async function chooseOrganization() {
    const orgs = selectableOrganizations.value
    const { index } = await ActionSheet.showActions({
      title: t('switch-organization'),
      options: [
        ...orgs.map(org => ({ title: org.gid === organizationStore.currentOrganization?.gid ? `✓ ${org.name}` : org.name })),
        { title: t('organization') },
        { title: t('button-cancel'), style: ActionSheetButtonStyle.Cancel },
      ],
    })
    if (index === orgs.length) {
      await router.push('/settings/organization')
      return
    }
    const org = orgs[index]
    if (!org || org.gid === organizationStore.currentOrganization?.gid)
      return
    organizationStore.setCurrentOrganization(org.gid)
    if (route.path !== '/dashboard')
      await router.push('/dashboard')
  }

  async function openMoreMenu() {
    if (moreMenuOpen)
      return
    moreMenuOpen = true
    try {
      const entries = moreTabs.value
      const { index } = await ActionSheet.showActions({
        title: organizationStore.currentOrganization?.name,
        options: [
          ...entries.map(tab => ({ title: tabLabel(tab) })),
          { title: t('button-cancel'), style: ActionSheetButtonStyle.Cancel },
        ],
      })
      const tab = entries[index]
      if (tab)
        await openTab(tab)
    }
    finally {
      moreMenuOpen = false
      // Tapping "More" selects it natively; restore the tab for the real route.
      await renderTabbar()
    }
  }

  async function goBack() {
    if (!router.options.history.state.back)
      return
    const navigated = new Promise<void>((resolve) => {
      const stop = router.afterEach(() => {
        stop()
        resolve()
      })
      window.setTimeout(() => {
        stop()
        resolve()
      }, 600)
    })
    router.back()
    await navigated
  }

  onMounted(async () => {
    if (!isNativeChromeEnabled)
      return
    active = true
    // The layout can unmount while these awaits are pending: drop late handles.
    const register = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending
      if (active)
        listeners.push(handle)
      else
        void handle.remove()
    }
    await NativeNavigation.configure({ enabled: true, contentInsetMode: 'css' })
    if (!active)
      return
    await Promise.all([
      register(NativeNavigation.addListener('tabSelect', ({ id }) => {
        if (id === 'more') {
          void openMoreMenu()
          return
        }
        const tab = PRIMARY_TABS[id as PrimaryTabId]
        if (tab)
          void openTab(tab).finally(() => renderTabbar())
      })),
      register(NativeNavigation.addListener('navbarBack', () => {
        void goBack()
      })),
      register(NativeNavigation.addListener('navbarItemTap', ({ id }) => {
        if (id === 'organization')
          void chooseOrganization()
      })),
    ])
    await Promise.all([renderNavbar(), renderTabbar(), renderStatusBar()])
  })

  watch([title, showBack, organizationLabel, isDark], () => {
    void renderNavbar()
  })
  watch([selectedTabId, isDark, () => t('more-menu')], () => {
    void renderTabbar()
  })
  watch(isDark, () => {
    void renderStatusBar()
  })

  onBeforeUnmount(() => {
    if (!active)
      return
    active = false
    listeners.splice(0).forEach(listener => void listener.remove())
    void NativeNavigation.setNavbar({ hidden: true })
    void NativeNavigation.setTabbar({ hidden: true })
  })

  return { goBack, canGoBack: () => showBack.value }
}
