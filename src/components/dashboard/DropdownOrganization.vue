<script setup lang="ts">
import type { Organization, OrganizationApp } from '~/stores/organization'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCheck from '~icons/lucide/check'
import IconPlus from '~icons/lucide/plus'
import IconSearch from '~icons/lucide/search'
import IconSettings from '~icons/lucide/settings'
import IconDown from '~icons/material-symbols/keyboard-arrow-down-rounded'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { resolveImagePath } from '~/services/storage'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

type OrganizationInvitationTarget = Pick<Organization, 'gid' | 'name' | 'role' | 'is_invite'>

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const router = useRouter()
const route = useRoute()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
const dialogStore = useDialogV2Store()
const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const dropdown = useTemplateRef<HTMLDetailsElement>('dropdown')
const menu = useTemplateRef<HTMLElement>('orgSwitcherMenu')
const compactMenuOpen = ref(false)
const organizationSearch = ref('')
const compactMenuStyle = ref<Record<string, string>>({})
const hasVisibleOrganizations = computed(() => organizationStore.organizations.length > 0)
const currentLabel = computed(() => currentOrganization.value?.name ?? t('select-organization'))
const currentAppId = computed(() => {
  if (!('app' in route.params))
    return ''

  const appParam = route.params.app
  if (Array.isArray(appParam))
    return appParam[0] ?? ''

  return typeof appParam === 'string' ? appParam : ''
})
const currentApp = computed(() => currentAppId.value ? organizationStore.getAppByAppId(currentAppId.value) : undefined)
const currentAppLabel = computed(() => currentApp.value ? getAppLabel(currentApp.value) : currentAppId.value)
const invitationCount = computed(() => organizationStore.organizations.filter(org => isPendingOrganizationInvite(org)).length)
const triggerAriaLabel = computed(() => {
  const baseLabel = props.compact
    ? currentLabel.value
    : `${currentLabel.value}, ${currentAppLabel.value || t('select-app')}`
  if (invitationCount.value <= 0)
    return baseLabel
  return `${baseLabel}, ${t('org-switcher-pending-invites', invitationCount.value)}`
})
const canCreateOrganizationInContext = !isNativeAppStoreContext()
const ORGANIZATION_SEARCH_THRESHOLD = 8
const showOrganizationSearch = computed(() => {
  const appCount = organizationStore.organizations.reduce((total, org) => total + getOrgApps(org).length, 0)
  return organizationStore.organizations.length + appCount > ORGANIZATION_SEARCH_THRESHOLD
})
const normalizedOrganizationSearch = computed(() => organizationSearch.value.trim().toLowerCase())
const filteredOrganizations = computed(() => {
  const query = normalizedOrganizationSearch.value
  if (!query)
    return organizationStore.organizations
  return organizationStore.organizations.filter(org => org.name.toLowerCase().includes(query) || getOrgApps(org).some(app => appMatchesSearch(app, query)))
})
const ORGANIZATION_LOGO_REFRESH_INTERVAL_MS = 10 * 60 * 1000
const isRefreshingBrokenLogos = ref(false)
const lastOrganizationLogoRefreshAt = ref(0)
const refreshedBrokenLogoKeys = new Set<string>()
let organizationLogoRefreshInterval: number | null = null
let isOrganizationDropdownMounted = false
const handledInviteOrgId = ref<string | null>(null)

function refreshOnFocus() {
  void refreshOrganizationLogosIfNeeded()
}

function refreshOnVisibilityChange() {
  if (document.visibilityState === 'visible')
    void refreshOrganizationLogosIfNeeded()
}

onClickOutside(dropdown, () => closeDropdown({ restoreFocus: false }), { ignore: [menu] })

let compactMenuListenersBound = false
let compactMenuResizeObserver: ResizeObserver | undefined

function placeCompactMenu() {
  const trigger = dropdown.value?.querySelector('summary')
  if (!(trigger instanceof HTMLElement))
    return

  const rail = trigger.closest('#sidebar')
  const rect = (rail instanceof HTMLElement ? rail : trigger).getBoundingClientRect()
  const menuWidth = Math.max(menu.value?.offsetWidth || 288, 288)
  const menuHeight = menu.value?.offsetHeight || 0
  const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - menuWidth - 8))
  let top = trigger.getBoundingClientRect().top
  if (menuHeight && top + menuHeight > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - menuHeight - 8)
  }
  compactMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  }
}

function onCompactMenuReposition() {
  if (compactMenuOpen.value)
    placeCompactMenu()
}

function onCompactMenuScroll(event: Event) {
  const target = event.target
  if (target instanceof Node && menu.value?.contains(target))
    return
  onCompactMenuReposition()
}

function bindCompactMenuListeners() {
  if (compactMenuListenersBound)
    return
  window.addEventListener('resize', onCompactMenuReposition)
  window.addEventListener('scroll', onCompactMenuScroll, true)
  const rail = dropdown.value?.closest('#sidebar')
  if (rail instanceof HTMLElement) {
    compactMenuResizeObserver = new ResizeObserver(onCompactMenuReposition)
    compactMenuResizeObserver.observe(rail)
  }
  compactMenuListenersBound = true
}

function unbindCompactMenuListeners() {
  if (!compactMenuListenersBound)
    return
  window.removeEventListener('resize', onCompactMenuReposition)
  window.removeEventListener('scroll', onCompactMenuScroll, true)
  compactMenuResizeObserver?.disconnect()
  compactMenuResizeObserver = undefined
  compactMenuListenersBound = false
}

async function onDropdownToggle() {
  const open = dropdown.value?.open ?? false
  compactMenuOpen.value = props.compact && open
  if (!compactMenuOpen.value) {
    unbindCompactMenuListeners()
    return
  }
  bindCompactMenuListeners()
  await nextTick()
  placeCompactMenu()
}

onMounted(async () => {
  isOrganizationDropdownMounted = true
  await organizationStore.fetchOrganizations()
  if (!isOrganizationDropdownMounted)
    return

  await openInvitationFromRouteIfNeeded()

  lastOrganizationLogoRefreshAt.value = Date.now()

  window.addEventListener('focus', refreshOnFocus)
  document.addEventListener('visibilitychange', refreshOnVisibilityChange)

  organizationLogoRefreshInterval = window.setInterval(() => {
    void refreshOrganizationLogosIfNeeded()
  }, ORGANIZATION_LOGO_REFRESH_INTERVAL_MS)
})

onUnmounted(() => {
  isOrganizationDropdownMounted = false
  compactMenuOpen.value = false
  unbindCompactMenuListeners()
  window.removeEventListener('focus', refreshOnFocus)
  document.removeEventListener('visibilitychange', refreshOnVisibilityChange)
  if (organizationLogoRefreshInterval !== null)
    window.clearInterval(organizationLogoRefreshInterval)
  organizationLogoRefreshInterval = null
})

async function handleOrganizationInvitation(org: OrganizationInvitationTarget) {
  const newName = t('alert-accept-invitation').replace('%ORG%', org.name)
  let invitationHandled = false
  dialogStore.openDialog({
    title: t('alert-confirm-invite'),
    description: `${newName}`,
    buttons: [
      {
        text: t('button-join'),
        role: 'primary',
        id: 'confirm-button',
        handler: async () => {
          const { data, error } = await supabase.rpc('accept_invitation_to_org', {
            org_id: org.gid,
          })

          if (!data || error) {
            console.log('Error accept: ', error)
            return
          }

          if (data === 'OK') {
            invitationHandled = true
            organizationStore.setCurrentOrganization(org.gid)
            await organizationStore.fetchOrganizations()
            toast.success(t('invite-accepted'))
          }
          else if (data === 'NO_INVITE') {
            toast.error(t('alert-no-invite'))
          }
          else if (data === 'INVALID_ROLE') {
            toast.error(t('alert-not-invited'))
          }
          else {
            toast.error(t('alert-unknown-error'))
          }
        },
      },
      {
        text: t('button-deny-invite'),
        id: 'deny-button',
        handler: async () => {
          const userId = main.user?.id
          if (userId === undefined)
            return

          const { error } = await supabase
            .from('org_users')
            .delete()
            .eq('org_id', org.gid)
            .eq('user_id', userId)

          if (error) {
            console.log('Error delete: ', error)
            return
          }

          invitationHandled = true
          await organizationStore.fetchOrganizations()
          toast.success(t('alert-denied-invite'))
        },
      },
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
    ],
  })

  await dialogStore.onDialogDismiss()
  if (invitationHandled)
    await clearInviteOrgQuery()
}

async function clearInviteOrgQuery() {
  if (!('invite_org' in route.query))
    return

  const nextQuery = { ...route.query }
  delete nextQuery.invite_org
  await router.replace({ query: nextQuery })
  handledInviteOrgId.value = null
}

async function openInvitationFromRouteIfNeeded() {
  const inviteOrgId = typeof route.query.invite_org === 'string' ? route.query.invite_org : ''
  if (!inviteOrgId || inviteOrgId === handledInviteOrgId.value)
    return

  const inviteOrg = organizationStore.organizations.find(org => org.gid === inviteOrgId)
  if (!inviteOrg)
    return

  handledInviteOrgId.value = inviteOrgId
  if (isInvitation(inviteOrg))
    await handleOrganizationInvitation(inviteOrg)
}

function closeDropdown(options?: { restoreFocus?: boolean }) {
  const wasCompactOpen = compactMenuOpen.value
  organizationSearch.value = ''
  compactMenuOpen.value = false
  unbindCompactMenuListeners()
  dropdown.value?.removeAttribute('open')
  if (wasCompactOpen && options?.restoreFocus !== false)
    dropdown.value?.querySelector('summary')?.focus()
}

onKeyStroke('Escape', (event) => {
  if (!compactMenuOpen.value)
    return
  event.preventDefault()
  closeDropdown({ restoreFocus: true })
})

function getLogoRefreshKey(org?: Organization | null) {
  if (!org)
    return ''
  const storagePath = resolveImagePath(org.logo_storage_path).normalized
  if (storagePath)
    return storagePath
  const gid = org.gid?.trim()
  if (gid)
    return gid
  const logo = resolveImagePath(org.logo).normalized
  if (logo)
    return logo
  return ''
}

async function refreshBrokenOrganizationLogo(org?: Organization | null) {
  const failedLogo = org?.logo?.trim()
  const refreshKey = getLogoRefreshKey(org)
  if (!failedLogo || !refreshKey || refreshedBrokenLogoKeys.has(refreshKey) || isRefreshingBrokenLogos.value)
    return

  refreshedBrokenLogoKeys.add(refreshKey)
  await refreshOrganizationLogosIfNeeded(true)
}

async function refreshOrganizationLogosIfNeeded(force = false) {
  if (isRefreshingBrokenLogos.value)
    return

  if (!force && Date.now() - lastOrganizationLogoRefreshAt.value < ORGANIZATION_LOGO_REFRESH_INTERVAL_MS)
    return

  isRefreshingBrokenLogos.value = true
  try {
    await organizationStore.refreshOrganizationLogos()
    lastOrganizationLogoRefreshAt.value = Date.now()
  }
  catch (error) {
    console.error('Failed to refresh organization logos', error)
  }
  finally {
    isRefreshingBrokenLogos.value = false
  }
}

function onOrganizationClick(org: Organization) {
  closeDropdown()

  // Check if the user is invited to the organization
  if (isPendingOrganizationInvite(org)) {
    handleOrganizationInvitation(org)
    return
  }

  organizationStore.setCurrentOrganization(org.gid)
  // Org row opens the org global dashboard; settings gear opens org settings.
  // When already on dashboard, the watch on currentOrganization in
  // organization.ts will trigger data reload via main.updateDashboard().
  if (router.currentRoute.value.path !== '/dashboard')
    router.push('/dashboard')
}

async function createNewOrg() {
  if (!canCreateOrganizationInContext)
    return

  closeDropdown()
  await router.push({
    path: '/onboarding/organization',
    query: {
      source: 'org-switcher',
      to: '/dashboard',
    },
  })
}

async function openOrganizationSettings(org: Organization, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  if (isPendingOrganizationInvite(org))
    return

  if (!isSelected(org))
    organizationStore.setCurrentOrganization(org.gid)

  closeDropdown()
  await router.push('/settings/organization')
}

function isSelected(org: Organization) {
  return !!(currentOrganization.value && org.gid === currentOrganization.value.gid)
}

function isInvitation(org: Organization) {
  return isPendingOrganizationInvite(org)
}

function getOrgApps(org: Organization) {
  return organizationStore.getAppsByOrgId(org.gid)
}

function getAppLabel(app: Pick<OrganizationApp, 'app_id' | 'name'>) {
  return app.name || app.app_id
}

function appMatchesSearch(app: Pick<OrganizationApp, 'app_id' | 'name'>, query: string) {
  return getAppLabel(app).toLowerCase().includes(query) || app.app_id.toLowerCase().includes(query)
}

function getVisibleOrgApps(org: Organization) {
  const apps = getOrgApps(org)
  const query = normalizedOrganizationSearch.value
  if (!query || org.name.toLowerCase().includes(query))
    return apps
  return apps.filter(app => appMatchesSearch(app, query))
}

function isSelectedApp(app: OrganizationApp) {
  return app.app_id === currentAppId.value
}

async function onAppClick(org: Organization, app: OrganizationApp, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  if (isInvitation(org))
    return

  if (!isSelected(org))
    organizationStore.setCurrentOrganization(org.gid)

  closeDropdown()

  if (!isSelectedApp(app))
    await router.push(`/app/${encodeURIComponent(app.app_id)}`)
}

function acronym(name: string) {
  const trimmed = name.trim()
  if (!trimmed)
    return '?'
  const parts = trimmed.split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : (parts[0]?.[1] ?? '')
  return (first + second).toUpperCase()
}

watch(
  () => route.query.invite_org,
  (inviteOrg) => {
    if (typeof inviteOrg !== 'string' || !inviteOrg)
      handledInviteOrgId.value = null
    void openInvitationFromRouteIfNeeded()
  },
  { immediate: true },
)

watch(
  () => organizationStore.organizations.map(org => `${org.gid}:${org.role}:${org.is_invite}`),
  () => {
    void openInvitationFromRouteIfNeeded()
  },
)
</script>

<template>
  <div>
    <details
      v-if="hasVisibleOrganizations"
      ref="dropdown"
      data-test="org-switcher"
      class="relative w-full"
      @toggle="onDropdownToggle"
    >
      <summary
        class="relative shadow-none d-btn d-btn-sm border border-gray-700 text-white bg-[#1a1d24] hover:bg-gray-700 hover:text-white active:text-white focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800 h-auto min-h-11 justify-start w-full p-0"
        :aria-label="triggerAriaLabel"
      >
        <div class="flex items-center min-w-0 w-full text-left">
          <span class="relative flex w-12 h-11 shrink-0 items-center justify-center">
            <img
              v-if="currentOrganization?.logo"
              :src="currentOrganization.logo"
              :alt="`${currentOrganization.name} logo`"
              class="object-cover rounded-sm d-mask d-mask-squircle shrink-0 size-6"
              @error="refreshBrokenOrganizationLogo(currentOrganization)"
            >
            <div
              v-else-if="currentOrganization?.logo_is_loading"
              class="flex items-center justify-center bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0 size-6"
              :aria-label="t('loading')"
            >
              <span class="size-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              <span class="sr-only">{{ t('loading') }}</span>
            </div>
            <div
              v-else
              class="flex items-center justify-center text-xs font-semibold text-gray-300 bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0 size-6"
            >
              {{ acronym(currentLabel) }}
            </div>
            <span
              v-if="props.compact && invitationCount > 0"
              class="absolute top-1.5 right-1.5 size-2 rounded-full bg-amber-300"
              aria-hidden="true"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ currentLabel }}</span>
            <span class="block truncate text-xs font-normal text-slate-400">
              {{ currentAppLabel || t('select-app') }}
            </span>
          </span>
          <div
            v-if="invitationCount > 0"
            class="inline-flex items-center gap-1 px-2 py-0.5 ml-2 text-[11px] font-medium rounded-full border border-amber-400/30 bg-amber-500/10 text-amber-200 shrink-0"
          >
            <span class="size-1.5 rounded-full bg-amber-300" />
            <span>{{ invitationCount }}</span>
          </div>
          <IconDown class="size-6 ml-1 mr-2 fill-current shrink-0 text-slate-400" />
        </div>
      </summary>
      <Teleport to="body" :disabled="!props.compact">
        <div
          v-show="!props.compact || compactMenuOpen"
          ref="orgSwitcherMenu"
          data-test="org-switcher-menu"
          class="flex flex-col max-h-[min(34rem,70vh)] overflow-hidden rounded-xl border border-slate-600/70 bg-slate-800 text-slate-200 shadow-2xl shadow-black/40"
          :class="props.compact
            ? 'fixed z-[100] w-80'
            : 'absolute top-full inset-x-0 mt-1.5 z-50'"
          :style="props.compact ? compactMenuStyle : undefined"
          @click="closeDropdown()"
        >
          <div class="flex items-center justify-between px-3 pt-3 pb-1.5">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{{ t('organizations') }}</span>
            <span class="text-[11px] tabular-nums text-slate-500">{{ organizationStore.organizations.length }}</span>
          </div>
          <div v-if="showOrganizationSearch" class="px-2 pb-2" @click.stop>
            <label class="flex items-center gap-2 h-9 px-2.5 rounded-lg border border-slate-600 bg-slate-900/60 text-slate-400 focus-within:border-azure-500 focus-within:ring-2 focus-within:ring-azure-500/30">
              <IconSearch class="size-4 shrink-0" aria-hidden="true" />
              <input
                v-model="organizationSearch"
                type="search"
                data-test="org-switcher-search"
                class="w-full min-w-0 bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
                :placeholder="t('search-organizations')"
                :aria-label="t('search-organizations')"
              >
            </label>
          </div>
          <ul class="flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5 space-y-0.5">
            <li
              v-for="org in filteredOrganizations"
              :key="org.gid"
              class="group/org"
            >
              <div
                class="flex items-center gap-1 rounded-lg transition-colors duration-150"
                :class="isSelected(org) ? 'bg-slate-700/70' : 'hover:bg-slate-700/50'"
              >
                <button
                  type="button"
                  class="flex flex-1 min-w-0 items-center gap-2.5 h-10 pl-2 pr-1 text-left text-sm font-medium text-white rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
                  :aria-current="isSelected(org) ? 'true' : undefined"
                  :aria-label="org.name"
                  :title="org.name"
                  @click="onOrganizationClick(org)"
                >
                  <img
                    v-if="org.logo"
                    :src="org.logo"
                    :alt="`${org.name} logo`"
                    class="object-cover size-6 rounded-md shrink-0 ring-1 ring-white/10"
                    @error="refreshBrokenOrganizationLogo(org)"
                  >
                  <span
                    v-else-if="org.logo_is_loading"
                    class="flex items-center justify-center size-6 rounded-md bg-slate-700 shrink-0"
                    :aria-label="t('loading')"
                  >
                    <span class="size-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                    <span class="sr-only">{{ t('loading') }}</span>
                  </span>
                  <span
                    v-else
                    class="flex items-center justify-center size-6 rounded-md bg-slate-600 text-[10px] font-semibold text-slate-100 shrink-0"
                  >
                    {{ acronym(org.name) }}
                  </span>
                  <span class="block truncate min-w-0 flex-1">{{ org.name }}</span>
                  <span
                    v-if="isInvitation(org)"
                    class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border border-amber-400/25 bg-amber-500/10 text-amber-200 shrink-0"
                  >
                    <span class="size-1.5 rounded-full bg-amber-300" />
                    {{ t('sso-status-pending') }}
                  </span>
                  <IconCheck v-else-if="isSelected(org) && !currentAppId" class="size-4 shrink-0 text-azure-400" aria-hidden="true" />
                </button>
                <button
                  v-if="!isInvitation(org)"
                  type="button"
                  class="flex items-center justify-center size-8 mr-1 rounded-md text-slate-400 shrink-0 cursor-pointer transition-opacity duration-150 hover:bg-slate-600/60 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
                  :class="isSelected(org) ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover/org:opacity-100'"
                  :aria-label="`${t('settings')} ${org.name}`"
                  :title="t('settings')"
                  @click="openOrganizationSettings(org, $event)"
                >
                  <IconSettings class="size-4" />
                </button>
              </div>
              <ul v-if="!isInvitation(org) && getVisibleOrgApps(org).length > 0" class="py-0.5 space-y-0.5">
                <li v-for="app in getVisibleOrgApps(org)" :key="app.app_id">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2.5 min-h-10 py-1.5 pl-6 pr-2 rounded-lg text-left cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
                    :class="isSelectedApp(app) ? 'bg-azure-500/15 text-white' : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'"
                    :aria-current="isSelectedApp(app) ? 'page' : undefined"
                    :title="`${getAppLabel(app)} (${app.app_id})`"
                    @click="onAppClick(org, app, $event)"
                  >
                    <img
                      v-if="app.icon_url"
                      :src="app.icon_url"
                      :alt="`${getAppLabel(app)} icon`"
                      class="object-cover size-5 rounded-md shrink-0 ring-1 ring-white/10"
                    >
                    <span
                      v-else-if="app.icon_url_loading"
                      class="flex size-5 items-center justify-center rounded-md bg-slate-700 shrink-0"
                      :aria-label="t('loading')"
                    >
                      <span class="size-2.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                      <span class="sr-only">{{ t('loading') }}</span>
                    </span>
                    <span v-else class="flex size-5 items-center justify-center rounded-md bg-slate-700 text-[9px] font-semibold text-slate-300 shrink-0">
                      {{ acronym(getAppLabel(app)) }}
                    </span>
                    <span class="min-w-0 flex-1 leading-tight">
                      <span class="block truncate text-[13px] font-medium">{{ getAppLabel(app) }}</span>
                      <span class="block truncate font-mono text-[11px]" :class="isSelectedApp(app) ? 'text-slate-400' : 'text-slate-500'">{{ app.app_id }}</span>
                    </span>
                    <IconCheck v-if="isSelectedApp(app)" class="size-4 shrink-0 text-azure-400" aria-hidden="true" />
                  </button>
                </li>
              </ul>
              <p v-else-if="!isInvitation(org) && isSelected(org) && !normalizedOrganizationSearch" class="py-1.5 pl-[2.625rem] pr-2 text-xs text-slate-500">
                {{ t('no-apps') }}
              </p>
            </li>
            <li v-if="filteredOrganizations.length === 0" class="px-3 py-6 text-center text-sm text-slate-400">
              {{ t('no-results') }}
            </li>
          </ul>
          <div v-if="canCreateOrganizationInContext" class="p-1.5 border-t border-slate-700">
            <button
              type="button"
              class="flex w-full items-center gap-2.5 h-10 px-2 rounded-lg text-sm font-medium text-slate-300 cursor-pointer transition-colors duration-150 hover:bg-slate-700/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
              @click="createNewOrg"
            >
              <span class="flex items-center justify-center size-6 rounded-md border border-dashed border-slate-500 text-slate-400 shrink-0">
                <IconPlus class="size-3.5" />
              </span>
              {{ t('add-organization') }}
            </button>
          </div>
        </div>
      </Teleport>
    </details>
    <div v-else-if="canCreateOrganizationInContext" class="p-px rounded-lg from-cyan-500 to-purple-500 bg-linear-to-r">
      <button type="button" class="block w-full text-white d-btn d-btn-outline bg-slate-800 d-btn-sm" @click="createNewOrg">
        {{ t('create-new-org') }}
      </button>
    </div>
    <div v-else class="rounded-lg border border-gray-700 bg-[#1a1d24] px-3 py-2 text-sm text-slate-300">
      {{ t('select-organization') }}
    </div>
  </div>
</template>
