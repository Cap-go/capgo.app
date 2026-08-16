<script setup lang="ts">
import type { Organization, OrganizationApp } from '~/stores/organization'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
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

function placeCompactMenu() {
  const trigger = dropdown.value?.querySelector('summary')
  if (!(trigger instanceof HTMLElement))
    return

  const rect = trigger.getBoundingClientRect()
  const menuWidth = Math.max(menu.value?.offsetWidth || 288, 288)
  const menuHeight = menu.value?.offsetHeight || 0
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))
  const gap = 4
  let top = rect.bottom + gap
  if (menuHeight && top + menuHeight > window.innerHeight - 8) {
    const above = rect.top - gap - menuHeight
    top = above >= 8 ? above : Math.max(8, window.innerHeight - menuHeight - 8)
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
  compactMenuListenersBound = true
}

function unbindCompactMenuListeners() {
  if (!compactMenuListenersBound)
    return
  window.removeEventListener('resize', onCompactMenuReposition)
  window.removeEventListener('scroll', onCompactMenuScroll, true)
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
      class="d-dropdown"
      :class="props.compact ? 'w-auto' : 'w-full d-dropdown-end'"
      @toggle="onDropdownToggle"
    >
      <summary
        class="shadow-none d-btn d-btn-sm border border-gray-700 text-white bg-[#1a1d24] hover:bg-gray-700 hover:text-white active:text-white focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800"
        :class="props.compact
          ? 'relative size-10 min-h-10 p-1 justify-center'
          : 'h-auto min-h-12 justify-between w-full px-3 py-2'"
        :aria-label="triggerAriaLabel"
      >
        <div class="flex items-center min-w-0 text-left" :class="props.compact ? 'justify-center' : 'flex-1'">
          <img
            v-if="currentOrganization?.logo"
            :src="currentOrganization.logo"
            :alt="`${currentOrganization.name} logo`"
            class="object-cover rounded-sm d-mask d-mask-squircle shrink-0"
            :class="props.compact ? 'size-8' : 'size-6 mr-2'"
            @error="refreshBrokenOrganizationLogo(currentOrganization)"
          >
          <div
            v-else-if="currentOrganization?.logo_is_loading"
            class="flex items-center justify-center bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0"
            :class="props.compact ? 'size-8' : 'size-6 mr-2'"
            :aria-label="t('loading')"
          >
            <span class="size-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            <span class="sr-only">{{ t('loading') }}</span>
          </div>
          <div
            v-else
            class="flex items-center justify-center text-xs font-semibold text-gray-300 bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0"
            :class="props.compact ? 'size-8' : 'size-6 mr-2'"
          >
            {{ acronym(currentLabel) }}
          </div>
          <template v-if="!props.compact">
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
          </template>
        </div>
        <span
          v-if="props.compact && invitationCount > 0"
          class="absolute top-0.5 right-0.5 size-2 rounded-full bg-amber-300"
          aria-hidden="true"
        />
        <IconDown v-if="!props.compact" class="size-6 ml-1 fill-current shrink-0 text-slate-400" />
      </summary>
      <Teleport to="body" :disabled="!props.compact">
        <div
          v-show="!props.compact || compactMenuOpen"
          ref="orgSwitcherMenu"
          data-test="org-switcher-menu"
          class="flex flex-col max-h-[60vh] shadow bg-[#1a1d24] rounded-box text-white"
          :class="props.compact
            ? 'fixed z-[100] min-w-72'
            : 'w-full min-w-0 d-dropdown-content z-50'"
          :style="props.compact ? compactMenuStyle : undefined"
          @click="closeDropdown()"
        >
          <ul class="flex-1 overflow-y-auto p-2">
            <li
              v-for="org in organizationStore.organizations"
              :key="org.gid"
              class="block px-1 my-1 rounded-lg"
              :class="isSelected(org) ? 'bg-gray-700/80' : ''"
            >
              <div class="flex items-center gap-2 px-3 py-3 text-white rounded-md hover:bg-gray-600">
                <button
                  type="button"
                  class="d-btn d-btn-ghost d-btn-sm h-auto min-h-0 flex-1 items-center justify-start min-w-0 border-none px-0 shadow-none text-white hover:bg-transparent"
                  :aria-current="isSelected(org) ? 'true' : undefined"
                  :aria-label="org.name"
                  @click="onOrganizationClick(org)"
                >
                  <img
                    v-if="org.logo"
                    :src="org.logo"
                    :alt="`${org.name} logo`"
                    class="object-cover size-6 mr-2 rounded-sm d-mask d-mask-squircle shrink-0"
                    @error="refreshBrokenOrganizationLogo(org)"
                  >
                  <div
                    v-else-if="org.logo_is_loading"
                    class="flex items-center justify-center size-6 mr-2 bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0"
                    :aria-label="t('loading')"
                  >
                    <span class="size-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                    <span class="sr-only">{{ t('loading') }}</span>
                  </div>
                  <div
                    v-else
                    class="flex items-center justify-center size-6 mr-2 text-xs font-semibold text-gray-300 bg-gray-700 rounded-sm d-mask d-mask-squircle shrink-0"
                  >
                    {{ acronym(org.name) }}
                  </div>
                  <span class="block truncate min-w-0">{{ org.name }}</span>
                  <span
                    v-if="isInvitation(org)"
                    class="inline-flex items-center gap-1 px-2 py-0.5 ml-auto text-[10px] font-medium rounded-full border border-amber-400/25 bg-amber-500/8 text-amber-200 shrink-0"
                  >
                    <span class="size-1.5 rounded-full bg-amber-300" />
                    {{ t('sso-status-pending') }}
                  </span>
                </button>
                <button
                  v-if="!isInvitation(org)"
                  type="button"
                  class="d-btn d-btn-ghost d-btn-sm d-btn-square size-8 min-h-0 border-none text-slate-300 hover:bg-slate-500/30 hover:text-white shrink-0"
                  :aria-label="`${t('settings')} ${org.name}`"
                  @click="openOrganizationSettings(org, $event)"
                >
                  <IconSettings class="size-4" />
                </button>
              </div>
              <div v-if="!isInvitation(org)" class="pb-2 pl-8 pr-1">
                <div v-if="getOrgApps(org).length > 0" class="space-y-1">
                  <button
                    v-for="app in getOrgApps(org)"
                    :key="app.app_id"
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left"
                    :class="isSelectedApp(app) ? 'bg-azure-500/15 text-azure-100' : 'text-slate-300 hover:bg-gray-600 hover:text-white'"
                    :aria-current="isSelectedApp(app) ? 'page' : undefined"
                    @click="onAppClick(org, app, $event)"
                  >
                    <img
                      v-if="app.icon_url"
                      :src="app.icon_url"
                      :alt="`${getAppLabel(app)} icon`"
                      class="object-cover size-5 rounded-sm d-mask d-mask-squircle shrink-0"
                    >
                    <span
                      v-else-if="app.icon_url_loading"
                      class="flex size-5 items-center justify-center rounded-sm bg-gray-700 d-mask d-mask-squircle shrink-0"
                      :aria-label="t('loading')"
                    >
                      <span class="size-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                      <span class="sr-only">{{ t('loading') }}</span>
                    </span>
                    <span v-else class="flex size-5 items-center justify-center rounded-sm bg-gray-700 text-[10px] font-semibold text-gray-300 d-mask d-mask-squircle shrink-0">
                      {{ acronym(getAppLabel(app)) }}
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium">{{ getAppLabel(app) }}</span>
                      <span class="block truncate font-mono text-xs text-slate-500">{{ app.app_id }}</span>
                    </span>
                  </button>
                </div>
                <p v-else-if="isSelected(org)" class="px-2 py-2 text-sm text-slate-400">
                  {{ t('no-apps') }}
                </p>
              </div>
            </li>
          </ul>
          <div v-if="canCreateOrganizationInContext" class="p-2 border-t border-gray-700">
            <div class="block p-px rounded-lg from-cyan-500 to-purple-500 bg-linear-to-r">
              <button
                type="button"
                class="d-btn d-btn-ghost flex w-full h-auto min-h-0 justify-center items-center py-3 px-3 text-center text-white rounded-lg bg-[#1a1d24] hover:bg-gray-600 cursor-pointer"
                @click="createNewOrg"
              >
                {{ t('add-organization') }}
              </button>
            </div>
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
