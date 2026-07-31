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

const router = useRouter()
const route = useRoute()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
const dialogStore = useDialogV2Store()
const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const dropdown = useTemplateRef('dropdown')
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

onClickOutside(dropdown, () => closeDropdown())

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

function closeDropdown() {
  if (dropdown.value) {
    dropdown.value.removeAttribute('open')
  }
}

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
  // Check if the user is invited to the organization
  if (isPendingOrganizationInvite(org)) {
    handleOrganizationInvitation(org)
    return
  }

  organizationStore.setCurrentOrganization(org.gid)
  // if current path is not home, redirect to the org home page
  // route.params.app
  if (router.currentRoute.value.path !== '/dashboard')
    router.push(`/dashboard`)
  // Note: When already on dashboard, the watch on currentOrganization in
  // organization.ts will trigger data reload via main.updateDashboard()
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

function onOrgItemClick(org: Organization, e: MouseEvent) {
  if (isSelected(org)) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  onOrganizationClick(org)
}

function isRowInteractive(org: Organization) {
  return isInvitation(org) || !isSelected(org)
}

function onOrgItemKeydown(org: Organization, e: KeyboardEvent) {
  if (e.target !== e.currentTarget)
    return

  if (!isRowInteractive(org))
    return

  if (e.key !== 'Enter' && e.key !== ' ')
    return

  e.preventDefault()
  closeDropdown()
  onOrganizationClick(org)
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
    <details v-if="hasVisibleOrganizations" ref="dropdown" class="w-full d-dropdown d-dropdown-end">
      <summary class="h-auto min-h-12 justify-between shadow-none w-full d-btn d-btn-sm border border-gray-700 text-white bg-[#1a1d24] px-3 py-2 hover:bg-gray-700 hover:text-white active:text-white focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800">
        <div class="flex flex-1 items-center min-w-0 text-left">
          <img
            v-if="currentOrganization?.logo"
            :src="currentOrganization.logo"
            :alt="`${currentOrganization.name} logo`"
            class="object-cover size-6 mr-2 rounded-sm d-mask d-mask-squircle shrink-0"
            @error="refreshBrokenOrganizationLogo(currentOrganization)"
          >
          <div
            v-else-if="currentOrganization?.logo_is_loading"
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
            {{ acronym(currentLabel) }}
          </div>
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
        </div>
        <IconDown class="size-6 ml-1 fill-current shrink-0 text-slate-400" />
      </summary>
      <div class="flex flex-col w-full min-w-0 max-h-[60vh] shadow d-dropdown-content bg-[#1a1d24] rounded-box z-50 text-white" @click="closeDropdown()">
        <ul class="flex-1 overflow-y-auto p-2">
          <li
            v-for="org in organizationStore.organizations"
            :key="org.gid"
            class="block px-1 my-1 rounded-lg"
            :class="isSelected(org) ? 'bg-gray-700/80' : ''"
          >
            <div
              class="flex items-center gap-2 px-3 py-3 text-white rounded-md"
              :class="isRowInteractive(org) ? 'cursor-pointer hover:bg-gray-600' : 'cursor-default'"
              :aria-current="isSelected(org) ? 'true' : undefined"
              :role="isRowInteractive(org) ? 'button' : undefined"
              :tabindex="isRowInteractive(org) ? 0 : -1"
              @click="onOrgItemClick(org, $event)"
              @keydown="onOrgItemKeydown(org, $event)"
            >
              <div
                class="flex flex-1 items-center min-w-0 text-left"
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
                <span class="block truncate">{{ org.name }}</span>
              </div>
              <div class="flex items-center justify-end min-w-0 shrink-0">
                <span
                  v-if="isInvitation(org)"
                  class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border border-amber-400/25 bg-amber-500/8 text-amber-200"
                >
                  <span class="size-1.5 rounded-full bg-amber-300" />
                  {{ t('sso-status-pending') }}
                </span>
                <button
                  v-else
                  type="button"
                  class="flex items-center justify-center size-8 rounded-md cursor-pointer text-slate-300 transition-colors hover:bg-slate-500/30 hover:text-white"
                  :aria-label="`${t('settings')} ${org.name}`"
                  @click="openOrganizationSettings(org, $event)"
                >
                  <IconSettings class="size-4" />
                </button>
              </div>
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
            <a
              class="flex justify-center items-center py-3 px-3 text-center text-white rounded-lg bg-[#1a1d24] hover:bg-gray-600 cursor-pointer"
              @click="createNewOrg"
            >{{ t('add-organization') }}
            </a>
          </div>
        </div>
      </div>
    </details>
    <div v-else-if="canCreateOrganizationInContext" class="p-px rounded-lg from-cyan-500 to-purple-500 bg-linear-to-r">
      <button class="block w-full text-white d-btn d-btn-outline bg-slate-800 d-btn-sm" @click="createNewOrg">
        {{ t('create-new-org') }}
      </button>
    </div>
    <div v-else class="rounded-lg border border-gray-700 bg-[#1a1d24] px-3 py-2 text-sm text-slate-300">
      {{ t('select-organization') }}
    </div>
  </div>
</template>
