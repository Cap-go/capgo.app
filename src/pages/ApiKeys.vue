<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { useDark } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, h, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconArrowPath from '~icons/heroicons/arrow-path'
import IconCalendar from '~icons/heroicons/calendar'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconPencil from '~icons/heroicons/pencil'
import IconShield from '~icons/heroicons/shield-check'
import IconTrash from '~icons/heroicons/trash'
import IconXMark from '~icons/heroicons/x-mark'
import RoleCapabilitiesHint from '~/components/forms/RoleCapabilitiesHint.vue'
import ChannelPermissionOverridesPanel from '~/components/permissions/ChannelPermissionOverridesPanel.vue'
import {
  confirmApiKeyDeletion,
  confirmApiKeyRegeneration,
  isApiKeyExpired,
  showApiKeySecretModal,
  sortApiKeyRows,
} from '~/services/apikeys'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatLocalDate } from '~/services/date'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { getRbacRoleI18nKey, useOrganizationStore } from '~/stores/organization'
import '@vuepic/vue-datepicker/dist/main.css'

interface Role {
  id: string
  name: string
  scope_type: string
  description: string | null
  priority_rank: number
}

interface RoleBindingRow {
  id: string
  principal_type: 'apikey'
  principal_id: string
  scope_type: string
  org_id: string | null
  app_id: string | null
  role_name: string
}

interface ScopeBadgeItem {
  id: string
  label: string
  filterId?: string | null
  type?: 'org' | 'app'
}

interface ScopePickerState {
  title: string
  items: ScopeBadgeItem[]
  x: number
  y: number
  width: number
}

interface ApiKeyBindingInput {
  role_name: string
  scope_type: 'org' | 'app'
  org_id: string
  app_id?: string
}

interface ApiKeyAppAccessOption {
  appUuid: string
  publicAppId: string
  appName: string
  orgId: string
  orgName: string
  roleName: string
}

type ApiKeyRow = Database['public']['Tables']['apikeys']['Row'] & {
  global_permissions?: string[]
  is_hashed_key?: boolean
}

const { t } = useI18n()
const isDark = useDark()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const main = useMainStore()
const currentPage = ref(1)
const isLoading = ref(false)
const scopeFilters = ref<Record<string, boolean>>({})
const hasUserChangedScopeFilters = ref(false)
const hasInitialScopeFilterInUrl = new URLSearchParams(window.location.search).has('filter')
const defaultScopeFilterKey = ref<string | null>(null)
const scopePicker = ref<ScopePickerState | null>(null)
const scopePickerQuery = ref('')
const supabase = useSupabase()
const keys = ref<ApiKeyRow[]>([])
const organizationStore = useOrganizationStore()
const currentOrganizationId = computed(() => organizationStore.currentOrganization?.gid ?? null)
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])

// RBAC data
const roles = ref<Role[]>([])
const allBindings = ref<RoleBindingRow[]>([])

// State for API key dialog
const newApiKeyName = ref('')
const editingApiKey = ref<ApiKeyRow | null>(null)

// State for hashed key creation
const createAsHashed = ref(false)

// State for expiration date
const setExpirationCheckbox = ref(false)
const expirationDate = ref<Date | null>(null)

// RBAC creation state
const selectedOrgRole = ref('org_member')
const allowOrgCreation = ref(false)
const hideOrgCreationPermission = isNativeAppStoreContext()
const appOnlyScope = ref(false)
const selectedOrgsForCreation = ref<string[]>([])
const selectedOrgRolesById = ref<Record<string, string>>({})
const isHydratingApiKeyEdit = ref(false)
const manageableOrgIds = ref(new Set<string>())
const pendingAppBindings = ref<Record<string, string>>({})
const showOrgDropdown = ref(false)
const showAppDropdown = ref(false)
const selectedApiKeyForChannelPermissions = ref<ApiKeyRow | null>(null)
const channelPermissionAppOptions = ref<ApiKeyAppAccessOption[]>([])
const selectedChannelPermissionAppUuid = ref('')
const channelPermissionAppsLoading = ref(false)

// Available apps for selection (populated when showing app dialog)
const availableApps = ref<{ id: string, app_id: string, name: string | null, owner_org: string }[]>([])

// Computed properties for expiration date limits
const minExpirationDate = computed(() => {
  return dayjs().add(1, 'day').toDate()
})

// Cache for organization and app names
const orgCache = ref(new Map<string, string>())
const appCache = ref(new Map<string, string>())
const organizationNameById = computed(() => new Map(organizationStore.organizations.map(org => [org.gid, org.name])))

// Function to truncate strings (show first 5 and last 5 characters)
function hideString(str: string | null) {
  if (!str)
    return ''
  const first = str.slice(0, 5)
  const last = str.slice(-5)
  return `${first}...${last}`
}

// Check if a key is a hashed (secure) key
function isHashedKey(key: ApiKeyRow) {
  if (typeof key.is_hashed_key === 'boolean')
    return key.is_hashed_key
  return key.key === null && key.key_hash !== null
}

function getRoleDisplayName(roleName: string): string {
  const normalized = roleName.replace(/^invite_/, '')
  const i18nKey = getRbacRoleI18nKey(normalized)
  return i18nKey ? t(i18nKey) : normalized.replaceAll('_', ' ')
}

const systemApiKeyOrgReaderRole = 'apikey_org_reader'

// Get bindings for a specific key
function getBindingsForKey(key: Database['public']['Tables']['apikeys']['Row']): RoleBindingRow[] {
  return allBindings.value.filter(b => b.principal_id === key.rbac_id)
}

// Older app-only keys can retain apikey_org_reader for compatibility; show
// their actual app role instead.
function getHighestRole(key: Database['public']['Tables']['apikeys']['Row']): string | null {
  const bindings = getBindingsForKey(key)
  const directOrgBindings = bindings.filter(binding =>
    binding.scope_type === 'org' && binding.role_name !== systemApiKeyOrgReaderRole,
  )
  const candidateBindings = directOrgBindings.length > 0
    ? directOrgBindings
    : bindings.filter(binding => binding.scope_type === 'app')

  let highest: RoleBindingRow | null = null
  let highestRank = -1
  for (const binding of candidateBindings) {
    const role = roles.value.find(r => r.name === binding.role_name)
    const rank = role?.priority_rank ?? 0
    if (rank > highestRank) {
      highestRank = rank
      highest = binding
    }
  }
  return highest?.role_name ?? null
}

function getRbacAppBindingIds(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  return getBindingsForKey(key)
    .filter(b => b.scope_type === 'app' && !!b.app_id)
    .map(b => b.app_id!)
}

function getDisplayOrgIds(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  const orgIds = new Set<string>()
  getBindingsForKey(key).forEach((binding) => {
    if (binding.scope_type === 'org' && binding.org_id && binding.role_name !== systemApiKeyOrgReaderRole)
      orgIds.add(binding.org_id)
  })
  return Array.from(orgIds)
}

// App bindings retain their validated owning organization while remaining
// restricted to the selected app rather than receiving an organization role.
function getFilterOrgIds(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  const orgIds = new Set(getDisplayOrgIds(key))
  getBindingsForKey(key).forEach((binding) => {
    if (binding.scope_type === 'app' && binding.org_id)
      orgIds.add(binding.org_id)
  })
  return Array.from(orgIds)
}

function coversAllOrganizations(orgIds: string[]): boolean {
  const allOrgIds = organizationStore.organizations.map(org => org.gid)
  return allOrgIds.length > 0 && allOrgIds.every(orgId => orgIds.includes(orgId))
}

function getDisplayAppIds(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  return getRbacAppBindingIds(key)
}

function getDisplayOrgItems(key: Database['public']['Tables']['apikeys']['Row']): ScopeBadgeItem[] {
  const orgIds = getDisplayOrgIds(key)
  if (coversAllOrganizations(orgIds)) {
    return [{ id: 'all', label: t('key-all'), filterId: null, type: 'org' }]
  }
  return orgIds.map(orgId => ({
    id: orgId,
    label: orgCache.value.get(orgId) || t('unknown'),
    filterId: orgId,
    type: 'org',
  }))
}

function getDisplayOrgNames(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  return getDisplayOrgItems(key).map(item => item.label)
}

function getDisplayAppItems(key: Database['public']['Tables']['apikeys']['Row']): ScopeBadgeItem[] {
  return getDisplayAppIds(key).map(appId => ({
    id: appId,
    label: appCache.value.get(appId) || t('unknown'),
    filterId: appId,
    type: 'app',
  }))
}

function getDisplayAppNames(key: Database['public']['Tables']['apikeys']['Row']): string[] {
  return getDisplayAppItems(key).map(item => item.label)
}

function formatDisplayApps(key: Database['public']['Tables']['apikeys']['Row']) {
  return getDisplayAppNames(key).join(', ')
}

function formatDisplayOrganizations(key: Database['public']['Tables']['apikeys']['Row']) {
  return getDisplayOrgNames(key).join(', ')
}

function capitalizeLabel(label: string) {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function makeScopeFilterKey(type: 'org' | 'app', id: string) {
  return `${type}:${id}`
}

function parseScopeFilterKey(key: string) {
  const [type, id] = key.split(':')
  if ((type !== 'org' && type !== 'app') || !id)
    return null
  return { type, id } as const
}

function clearScopeFilters(markUserChange = true) {
  if (markUserChange)
    hasUserChangedScopeFilters.value = true

  scopeFilters.value = Object.fromEntries(
    Object.keys(scopeFilters.value).map(key => [key, false]),
  )
  currentPage.value = 1
}

function setSingleScopeFilter(type: 'org' | 'app', id: string | null, markUserChange = true) {
  if (markUserChange)
    hasUserChangedScopeFilters.value = true

  if (id === null) {
    clearScopeFilters(markUserChange)
    return
  }

  const selectedKey = makeScopeFilterKey(type, id)
  const filterKeys = Array.from(new Set([...Object.keys(scopeFilters.value), selectedKey]))
  scopeFilters.value = Object.fromEntries(
    filterKeys.map(key => [key, key === selectedKey]),
  )
  currentPage.value = 1
}

function updateScopeFilters(filters: Record<string, boolean>) {
  hasUserChangedScopeFilters.value = true
  scopeFilters.value = filters
  currentPage.value = 1
}

function isFilterableScopeItem(item: ScopeBadgeItem): item is ScopeBadgeItem & { type: 'org' | 'app', filterId: string | null } {
  return !!item.type && Object.hasOwn(item, 'filterId')
}

function isScopeItemActive(item: ScopeBadgeItem) {
  if (!isFilterableScopeItem(item))
    return false
  if (item.filterId === null)
    return !Object.values(scopeFilters.value).some(Boolean)
  return !!scopeFilters.value[makeScopeFilterKey(item.type, item.filterId)]
}

function closeScopePicker() {
  scopePicker.value = null
  scopePickerQuery.value = ''
}

function selectScopeItem(item: ScopeBadgeItem) {
  if (!isFilterableScopeItem(item))
    return

  setSingleScopeFilter(item.type, item.filterId)
  closeScopePicker()
}

function openScopePicker(event: MouseEvent, label: string, items: ScopeBadgeItem[]) {
  const trigger = event.currentTarget as HTMLElement
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(340, window.innerWidth - 32)
  const estimatedHeight = Math.min(384, 76 + items.length * 44)
  const x = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16)
  const belowY = rect.bottom + 8
  const y = belowY + estimatedHeight <= window.innerHeight
    ? belowY
    : Math.max(16, rect.top - estimatedHeight - 8)

  scopePicker.value = {
    title: `${capitalizeLabel(label)} (${items.length})`,
    items,
    x,
    y,
    width,
  }
  scopePickerQuery.value = ''
}

const filteredScopePickerItems = computed(() => {
  if (!scopePicker.value)
    return []

  const query = scopePickerQuery.value.trim().toLowerCase()
  if (!query)
    return scopePicker.value.items

  return scopePicker.value.items.filter(item => item.label.toLowerCase().includes(query))
})

function renderScopeBadges(items: ScopeBadgeItem[], visibleCount: number, overflowLabel: string) {
  const cleanItems = items.filter(item => item.label)
  if (cleanItems.length === 0) {
    return h('span', {
      class: 'text-slate-400 dark:text-slate-500',
    }, '-')
  }

  const visibleItems = cleanItems.slice(0, visibleCount)
  const hiddenItems = cleanItems.slice(visibleCount)
  const fullLabel = cleanItems.map(item => item.label).join(', ')

  return h('div', {
    'class': 'flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden',
    'title': fullLabel,
    'aria-label': fullLabel,
  }, [
    ...visibleItems.map((item) => {
      const isFilterable = isFilterableScopeItem(item)
      const isActive = isScopeItemActive(item)
      const chipClass = [
        'min-w-0 max-w-[9rem] truncate rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-1 dark:focus:ring-offset-slate-800',
        isActive
          ? 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-500/40 dark:bg-cyan-500/15 dark:text-cyan-200'
          : 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-700/60 dark:text-slate-200',
        isFilterable ? 'cursor-pointer hover:border-cyan-300 hover:text-cyan-700 dark:hover:border-cyan-500/40 dark:hover:text-cyan-200' : '',
      ].join(' ')

      if (!isFilterable) {
        return h('span', {
          class: chipClass,
          title: item.label,
        }, item.label)
      }

      return h('button', {
        type: 'button',
        class: chipClass,
        title: item.label,
        onClick: (event: MouseEvent) => {
          event.stopPropagation()
          selectScopeItem(item)
        },
      }, item.label)
    }),
    hiddenItems.length > 0
      ? h('button', {
          'type': 'button',
          'class': 'shrink-0 rounded-md border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-xs font-semibold text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200',
          'title': hiddenItems.map(item => item.label).join(', '),
          'aria-label': `${hiddenItems.length} ${overflowLabel}`,
          'aria-haspopup': 'dialog',
          'onClick': (event: MouseEvent) => {
            event.stopPropagation()
            openScopePicker(event, overflowLabel, cleanItems)
          },
        }, `+${hiddenItems.length}`)
      : null,
  ])
}

function cacheAppNames(apps: { id: string | null, app_id: string, name: string | null }[]) {
  apps.forEach((app) => {
    const displayName = app.name || app.app_id
    appCache.value.set(app.app_id, displayName)
    if (!app.id)
      return
    appCache.value.set(app.id, displayName)
  })
}

function getOrgNameById(orgId: string) {
  return orgCache.value.get(orgId) || organizationNameById.value.get(orgId) || orgId
}

const selectedOrgNamesForCreation = computed(() => {
  const orgById = new Map(organizationStore.organizations.map(org => [org.gid, org.name]))
  return selectedOrgsForCreation.value
    .map(orgId => orgById.get(orgId) || getOrgNameById(orgId))
    .join(', ')
})

// Computed property to get unique organization IDs from all API keys
const uniqueOrgIds = computed(() => {
  if (!keys.value)
    return new Set<string>()

  const orgIds = new Set<string>()
  if (currentOrganizationId.value)
    orgIds.add(currentOrganizationId.value)

  allBindings.value.forEach((binding) => {
    if (binding.scope_type === 'org' && binding.org_id && binding.role_name !== systemApiKeyOrgReaderRole)
      orgIds.add(binding.org_id)

    if (binding.scope_type === 'app' && binding.org_id)
      orgIds.add(binding.org_id)
  })

  return orgIds
})

// Computed property to get unique app IDs from all API keys
const uniqueAppIds = computed(() => {
  if (!keys.value)
    return new Set<string>()

  const appIds = new Set<string>()
  allBindings.value.forEach((binding) => {
    if (binding.scope_type === 'app' && binding.app_id)
      appIds.add(binding.app_id)
  })

  return appIds
})

const orgFilterOptions = computed(() => Array.from(uniqueOrgIds.value)
  .map(orgId => ({
    id: orgId,
    name: orgCache.value.get(orgId) || getOrgNameById(orgId),
  }))
  .sort((a, b) => a.name.localeCompare(b.name)))

const appFilterOptions = computed(() => Array.from(uniqueAppIds.value)
  .map(appId => ({
    id: appId,
    name: appCache.value.get(appId) || t('unknown'),
  }))
  .sort((a, b) => a.name.localeCompare(b.name)))

const scopeFilterLabels = computed(() => ({
  ...Object.fromEntries(orgFilterOptions.value.map(org => [
    makeScopeFilterKey('org', org.id),
    `${capitalizeLabel(t('organizations'))}: ${org.name}`,
  ])),
  ...Object.fromEntries(appFilterOptions.value.map(app => [
    makeScopeFilterKey('app', app.id),
    `${capitalizeLabel(t('apps'))}: ${app.name}`,
  ])),
}))

function syncScopeFilters() {
  const labels = scopeFilterLabels.value
  const nextFilters = Object.fromEntries(
    Object.keys(labels).map(key => [key, scopeFilters.value[key] ?? false]),
  )

  if (JSON.stringify(nextFilters) !== JSON.stringify(scopeFilters.value))
    scopeFilters.value = nextFilters
}

function applyCurrentOrganizationDefaultFilter() {
  if (hasInitialScopeFilterInUrl || hasUserChangedScopeFilters.value)
    return

  const orgId = currentOrganizationId.value
  if (!orgId)
    return

  const filterKey = makeScopeFilterKey('org', orgId)
  if (!(filterKey in scopeFilterLabels.value))
    return

  const activeFilterKeys = Object.entries(scopeFilters.value)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
  if (
    activeFilterKeys.length > 0
    && (activeFilterKeys.length > 1 || activeFilterKeys[0] !== defaultScopeFilterKey.value)
  ) {
    return
  }

  setSingleScopeFilter('org', orgId, false)
  defaultScopeFilterKey.value = filterKey
}

function selectedScopeFilterIds(type: 'org' | 'app') {
  return Object.entries(scopeFilters.value)
    .filter(([, enabled]) => enabled)
    .map(([key]) => parseScopeFilterKey(key))
    .filter((parsed): parsed is { type: 'org' | 'app', id: string } => parsed?.type === type)
    .map(parsed => parsed.id)
}

// Function to fetch organization and app names in parallel
async function fetchOrgAndAppNames() {
  if (!keys.value)
    return

  // Collect unique organization and app IDs that aren't already cached
  const uncachedOrgIds = Array.from(uniqueOrgIds.value).filter(id => !orgCache.value.has(id))
  const uncachedAppIds = Array.from(uniqueAppIds.value).filter(id => !appCache.value.has(id))

  // Fetch organization names in parallel
  if (uncachedOrgIds.length > 0) {
    const orgPromises = uncachedOrgIds.map(async (orgId) => {
      try {
        const { data, error } = await supabase
          .from('orgs')
          .select('id, name')
          .eq('id', orgId)
          .single()

        if (error)
          throw error
        if (data)
          orgCache.value.set(orgId, data.name)
        return { id: orgId, name: data?.name }
      }
      catch (err) {
        console.error(`Error fetching org name for ${orgId}:`, err)
        return { id: orgId, name: 'Unknown' }
      }
    })

    await Promise.all(orgPromises)
  }

  if (uncachedAppIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from('apps')
        .select('id, app_id, name')
        .in('id', uncachedAppIds)

      if (error)
        throw error
      cacheAppNames(data || [])
    }
    catch (err) {
      console.error('Error fetching app names by RBAC app ids:', err)
    }
  }
}

const searchQuery = ref('')

const filteredAndSortedKeys = computed(() => {
  let result = keys.value ?? []

  const orgFilterIds = selectedScopeFilterIds('org')
  if (orgFilterIds.length > 0) {
    result = result.filter((key) => {
      const orgIds = getFilterOrgIds(key)
      return orgFilterIds.some(orgId => orgIds.includes(orgId))
    })
  }

  const appFilterIds = selectedScopeFilterIds('app')
  if (appFilterIds.length > 0) {
    result = result.filter((key) => {
      const appIds = getDisplayAppIds(key)
      return appFilterIds.some(appId => appIds.includes(appId))
    })
  }

  // Filter first
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(key =>
      key.name?.toLowerCase().includes(query)
      || key.key?.toLowerCase().includes(query)
      || getRoleDisplayName(getHighestRole(key) || '').toLowerCase().includes(query)
      || formatDisplayOrganizations(key).toLowerCase().includes(query)
      || formatDisplayApps(key).toLowerCase().includes(query),
    )
  }

  // Then sort based on column state
  return columns.value.length ? sortApiKeyRows(result, columns.value) : result
})

// Org role options for creation modal
const unsupportedApiKeyOrgRoles = new Set(['org_billing_admin'])
const orgRoles = computed(() => roles.value.filter(r => r.scope_type === 'org' && !unsupportedApiKeyOrgRoles.has(r.name)))
const appRoles = computed(() => roles.value.filter(r => r.scope_type === 'app'))

const legacyOrgRoleAliases: Record<string, string> = {
  owner: 'org_super_admin',
  super_admin: 'org_super_admin',
  admin: 'org_admin',
  write: 'org_member',
  upload: 'org_member',
  read: 'org_member',
}

function normalizeOrgRoleName(roleName: string) {
  const normalized = roleName.replace(/^invite_/, '')
  return legacyOrgRoleAliases[normalized] ?? normalized
}

function getRolePriority(roleName?: string | null) {
  if (!roleName)
    return 0
  return roles.value.find(r => r.name === normalizeOrgRoleName(roleName))?.priority_rank ?? 0
}

const callerOrgPriorityByOrgId = computed(() => new Map(
  organizationStore.organizations.map(org => [org.gid, getRolePriority(org.role)]),
))

const selectedOrgMinimumPriority = computed(() => {
  const selectedManageableOrgIds = selectedOrgsForCreation.value.filter(orgId => manageableOrgIds.value.has(orgId))
  if (selectedManageableOrgIds.length === 0)
    return 0
  return Math.min(...selectedManageableOrgIds.map(orgId => callerOrgPriorityByOrgId.value.get(orgId) ?? 0))
})

const orgRoleOptions = computed(() =>
  orgRoles.value
    .filter(r => r.name !== 'org_super_admin' && r.priority_rank <= selectedOrgMinimumPriority.value)
    .map(r => ({ id: r.id, name: r.name, description: getRoleDisplayName(r.name) })),
)

const appRoleOptions = computed(() =>
  appRoles.value.map(r => ({ id: r.id, name: r.name, description: getRoleDisplayName(r.name) })),
)

const rolesWithInheritedAppAccess = new Set(['org_admin', 'org_super_admin'])
const rolesWithOrgCreateAccess = new Set(['org_admin', 'org_super_admin'])
const apiKeyOrgCreatePermission = 'org.create'
const isEditingApiKey = computed(() => editingApiKey.value !== null)
const showAppAccessInModal = computed(() =>
  appOnlyScope.value || (!!selectedOrgRole.value && !rolesWithInheritedAppAccess.has(selectedOrgRole.value)),
)

// Filtered apps based on selected orgs for creation
const filteredAppsForSelectedOrgs = computed(() => {
  if (!availableApps.value || selectedOrgsForCreation.value.length === 0)
    return []
  return availableApps.value.filter(app =>
    selectedOrgsForCreation.value.includes(app.owner_org),
  )
})

// Prune app bindings when orgs change
function pruneAppBindings() {
  const allowedAppIds = new Set(
    filteredAppsForSelectedOrgs.value.map(app => app.id),
  )
  const updated = { ...pendingAppBindings.value }
  for (const appId of Object.keys(updated)) {
    if (!allowedAppIds.has(appId))
      delete updated[appId]
  }
  pendingAppBindings.value = updated
}

function ensureSelectedOrgRoleAllowed() {
  if (orgRoleOptions.value.some(role => role.name === selectedOrgRole.value))
    return

  selectedOrgRole.value = orgRoleOptions.value.find(role => role.name === 'org_member')?.name ?? orgRoleOptions.value[0]?.name ?? ''
}

function syncSelectedOrgRolesById(defaultRole = selectedOrgRole.value, forceRole = false) {
  const selectedOrgIds = new Set(selectedOrgsForCreation.value)
  const nextRoles: Record<string, string> = {}

  for (const orgId of selectedOrgIds) {
    nextRoles[orgId] = forceRole
      ? defaultRole
      : selectedOrgRolesById.value[orgId] || defaultRole
  }

  selectedOrgRolesById.value = nextRoles
}

function getOrgRoleForBinding(orgId: string) {
  if (!isEditingApiKey.value)
    return selectedOrgRole.value

  return selectedOrgRolesById.value[orgId] || selectedOrgRole.value
}

const canEnableOrgCreation = computed(() =>
  !appOnlyScope.value
  && !hideOrgCreationPermission
  && selectedOrgsForCreation.value.some(orgId => rolesWithOrgCreateAccess.has(getOrgRoleForBinding(orgId))),
)
const selectedAppIds = computed(() => Object.keys(pendingAppBindings.value))
const selectedChannelPermissionApp = computed(() =>
  channelPermissionAppOptions.value.find(app => app.appUuid === selectedChannelPermissionAppUuid.value),
)

columns.value = [
  {
    key: 'name',
    label: t('name'),
    head: true,
    mobile: true,
    sortable: true,
  },
  {
    key: 'key',
    label: t('api-key'),
    head: true,
    displayFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      if (isHashedKey(row)) {
        return t('secure-key-hidden')
      }
      return hideString(row.key)
    },
  },
  {
    key: 'role',
    label: t('role'),
    displayFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      const highest = getHighestRole(row)
      if (!highest)
        return '-'
      return getRoleDisplayName(highest)
    },
  },
  {
    key: 'org_scope',
    label: t('organizations'),
    class: 'w-[16rem] max-w-[16rem]',
    renderFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      return renderScopeBadges(getDisplayOrgItems(row), 2, t('organizations'))
    },
  },
  {
    key: 'app_scope',
    label: t('apps'),
    class: 'w-[22rem] max-w-[22rem]',
    renderFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      return renderScopeBadges(getDisplayAppItems(row), 3, t('apps'))
    },
  },
  {
    key: 'created_at',
    label: t('created'),
    sortable: true,
    displayFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      return formatLocalDate(row.created_at)
    },
  },
  {
    key: 'expires_at',
    label: t('expires'),
    sortable: true,
    displayFunction: (row: Database['public']['Tables']['apikeys']['Row']) => {
      if (!row.expires_at)
        return t('never')

      const expired = isApiKeyExpired(row.expires_at)
      const dateStr = formatLocalDate(row.expires_at)
      return expired ? `${dateStr} (${t('expired')})` : dateStr
    },
  },
  {
    key: 'actions',
    label: t('actions'),
    mobile: true,
    actions: [
      {
        icon: IconClipboard,
        title: t('copy'),
        onClick: (key: Database['public']['Tables']['apikeys']['Row']) => copyKey(key),
      },
      {
        icon: IconShield,
        title: t('channel-permissions-title'),
        visible: (key: Database['public']['Tables']['apikeys']['Row']) => hasChannelPermissionApps(key),
        onClick: (key: Database['public']['Tables']['apikeys']['Row']) => openApiKeyChannelPermissions(key),
        testId: (key: Database['public']['Tables']['apikeys']['Row']) => `manage-key-channel-permissions-${key.id}`,
      },
      {
        icon: IconPencil,
        title: t('edit'),
        onClick: (key: Database['public']['Tables']['apikeys']['Row']) => editApiKey(key),
        testId: (key: Database['public']['Tables']['apikeys']['Row']) => `edit-key-${key.id}`,
      },
      {
        icon: IconArrowPath,
        title: t('button-regenerate'),
        onClick: (key: Database['public']['Tables']['apikeys']['Row']) => regenrateKey(key),
      },
      {
        icon: IconTrash,
        title: t('delete'),
        onClick: (key: Database['public']['Tables']['apikeys']['Row']) => deleteKey(key),
        testId: (key: Database['public']['Tables']['apikeys']['Row']) => `delete-key-${key.id}`,
      },
    ],
  },
]

async function refreshData() {
  try {
    currentPage.value = 1
    keys.value.length = 0
    await getKeys()
  }
  catch (error) {
    console.error(error)
  }
}

async function getKeys(retry = true): Promise<void> {
  isLoading.value = true
  const { data, error } = await invokeCapgoApi<ApiKeyRow[]>('apikey', {
    method: 'GET',
  })
  if (error) {
    console.error('Error fetching API keys:', error)
  }
  if (data) {
    keys.value = [...data].sort((a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    )
    if (data.length > 0) {
      await Promise.all([fetchAllBindings(), fetchRoles()])
      await fetchOrgAndAppNames()
    }
    else {
      allBindings.value = []
    }
  }
  else if (retry && main.user?.id) {
    return getKeys(false)
  }

  isLoading.value = false
}

async function fetchRoles() {
  const { data, error } = await supabase
    .from('roles')
    .select('id, name, scope_type, description, priority_rank')
    .eq('is_assignable', true)
    .in('scope_type', ['org', 'app'])
    .order('priority_rank', { ascending: false })
  if (error) {
    console.error('Error fetching roles:', error)
    return
  }
  roles.value = (data || []) as Role[]
}

async function fetchAllBindings() {
  if (!keys.value || keys.value.length === 0) {
    allBindings.value = []
    return
  }

  const rbacIds = keys.value.map(k => k.rbac_id).filter(Boolean)
  if (rbacIds.length === 0) {
    allBindings.value = []
    return
  }

  const { data, error } = await supabase
    .from('role_bindings')
    .select('id, principal_type, principal_id, scope_type, org_id, app_id, role_id, roles(name)')
    .eq('principal_type', 'apikey')
    .in('principal_id', rbacIds)

  if (error) {
    console.error('Error fetching role bindings:', error)
    allBindings.value = []
    return
  }

  allBindings.value = ((data || []) as any[]).map(row => ({
    id: row.id,
    principal_type: 'apikey',
    principal_id: row.principal_id,
    scope_type: row.scope_type,
    org_id: row.org_id,
    app_id: row.app_id,
    role_name: row.roles?.name || '',
  }))
}

async function loadAllApps() {
  try {
    const orgIds = organizationStore.organizations.map(org => org.gid)
    if (orgIds.length === 0) {
      availableApps.value = []
      return
    }
    const { data: apps, error } = await supabase
      .from('apps')
      .select('id, app_id, name, owner_org')
      .in('owner_org', orgIds)
      .order('name', { ascending: true })
    if (error) {
      console.error('Cannot load apps:', error)
      return
    }
    availableApps.value = (apps || []).filter((app): app is { id: string, app_id: string, name: string | null, owner_org: string } =>
      !!app.id && !!app.app_id,
    )
    cacheAppNames(availableApps.value)
  }
  catch (err) {
    console.error('Error loading apps:', err)
  }
}

async function loadManageableOrganizations() {
  const checks = await Promise.all(organizationStore.organizations.map(async (org) => {
    const canManage = await checkPermissions('org.update_user_roles', { orgId: org.gid })
    return canManage ? org.gid : null
  }))
  manageableOrgIds.value = new Set(checks.filter((orgId): orgId is string => !!orgId))
}

function validateApiKeyScope() {
  if (appOnlyScope.value) {
    if (selectedAppIds.value.length === 0) {
      toast.error(t('select-at-least-one-app'))
      return false
    }
  }
  else {
    if (selectedOrgsForCreation.value.length === 0) {
      toast.error(t('alert-no-org-selected'))
      return false
    }

    if (!selectedOrgRole.value) {
      toast.error(t('select-at-least-one-role'))
      return false
    }
  }

  if (hasIncompleteAppBindings()) {
    toast.error(t('select-role-for-each-app'))
    return false
  }

  return true
}

async function createApiKey() {
  const isHashed = createAsHashed.value

  if (!validateApiKeyScope())
    return false

  // Get expiration date if set
  let expiresAt: string | null = null
  if (setExpirationCheckbox.value && expirationDate.value) {
    expiresAt = dayjs(expirationDate.value).toISOString()
  }

  try {
    const { data: claimsData } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub

    if (!userId) {
      console.log('Not logged in, cannot create API key')
      toast.error('Not logged in')
      return false
    }

    const bindings = buildApiKeyBindingsFromForm()

    let plainKeyForDisplay: string | null = null

    const { data, error } = await invokeCapgoApi('apikey', {
      method: 'POST',
      body: {
        name: newApiKeyName.value.trim(),
        expires_at: expiresAt,
        hashed: isHashed,
        bindings,
        global_permissions: buildApiKeyGlobalPermissionsFromForm(),
      },
    })

    if (error || !data) {
      console.error('Error creating API key:', error)
      toast.error(await getUserFacingErrorMessage(error, t('failed-to-create-api-key')))
      return false
    }

    const createdKey = data
    if (isHashed)
      plainKeyForDisplay = typeof data.key === 'string' ? data.key : null

    // For hashed keys, clear the key field before adding to the list
    if (isHashed) {
      createdKey.key = null as any
    }
    keys.value?.unshift(createdKey)
    await fetchAllBindings()
    await fetchOrgAndAppNames()

    // For hashed keys, show the key one time in a modal
    if (isHashed && plainKeyForDisplay) {
      await showOneTimeKeyModal(plainKeyForDisplay)
    }

    toast.success(t('add-api-key'))
    return true
  }
  catch (error) {
    console.error('Error creating API key:', error)
    toast.error(await getUserFacingErrorMessage(error, t('failed-to-create-api-key')))
    return false
  }
}

async function showOneTimeKeyModal(plainKey: string) {
  return showApiKeySecretModal(dialogStore, t, plainKey, () => {
    toast.success(t('key-copied'))
  })
}

function buildApiKeyBindingsFromForm(): ApiKeyBindingInput[] {
  const bindings: ApiKeyBindingInput[] = []

  if (!appOnlyScope.value) {
    for (const orgId of selectedOrgsForCreation.value) {
      bindings.push({
        role_name: getOrgRoleForBinding(orgId),
        scope_type: 'org',
        org_id: orgId,
      })
    }
  }

  for (const [appId, roleName] of Object.entries(pendingAppBindings.value)) {
    if (!roleName)
      continue
    const app = availableApps.value.find(a => a.id === appId)
    if (!app)
      continue
    bindings.push({
      role_name: roleName,
      scope_type: 'app',
      org_id: app.owner_org,
      app_id: appId,
    })
  }

  return bindings
}

function buildApiKeyGlobalPermissionsFromForm(currentKey?: ApiKeyRow | null) {
  if (!appOnlyScope.value && allowOrgCreation.value && canEnableOrgCreation.value)
    return [apiKeyOrgCreatePermission]

  if (!appOnlyScope.value && hideOrgCreationPermission && currentKey && hasOrgCreatePermission(currentKey))
    return [apiKeyOrgCreatePermission]

  return []
}

function hasOrgCreatePermission(key: ApiKeyRow) {
  return key.global_permissions?.includes(apiKeyOrgCreatePermission) === true
}

async function addNewApiKey() {
  // Clear state
  editingApiKey.value = null
  newApiKeyName.value = ''
  createAsHashed.value = false
  allowOrgCreation.value = false
  appOnlyScope.value = false
  setExpirationCheckbox.value = false
  expirationDate.value = null
  selectedOrgRole.value = 'org_member'
  selectedOrgRolesById.value = {}
  pendingAppBindings.value = {}
  showOrgDropdown.value = false
  showAppDropdown.value = false

  await Promise.all([loadAllApps(), fetchRoles(), loadManageableOrganizations()])

  // Select all organizations that can receive RBAC bindings from this caller.
  selectedOrgsForCreation.value = organizationStore.organizations
    .map(org => org.gid)
    .filter(orgId => manageableOrgIds.value.has(orgId))
  ensureSelectedOrgRoleAllowed()

  // Show creation modal
  await showAddNewKeyModal()
}

async function editApiKey(key: Database['public']['Tables']['apikeys']['Row']) {
  isHydratingApiKeyEdit.value = true

  try {
    editingApiKey.value = key
    newApiKeyName.value = key.name || ''
    createAsHashed.value = isHashedKey(key)
    allowOrgCreation.value = hasOrgCreatePermission(key as ApiKeyRow)
    appOnlyScope.value = false
    setExpirationCheckbox.value = !!key.expires_at
    expirationDate.value = key.expires_at ? new Date(key.expires_at) : null
    selectedOrgRolesById.value = {}
    pendingAppBindings.value = {}
    showOrgDropdown.value = false
    showAppDropdown.value = false

    await Promise.all([loadAllApps(), fetchRoles(), loadManageableOrganizations(), fetchAllBindings()])

    const keyBindings = getBindingsForKey(key)
    const editableOrgBindings = keyBindings
      .filter(binding => binding.scope_type === 'org' && !!binding.org_id && binding.role_name !== systemApiKeyOrgReaderRole)
    const appBindings = keyBindings
      .filter(binding => binding.scope_type === 'app' && !!binding.app_id && !!binding.role_name)
    appOnlyScope.value = editableOrgBindings.length === 0 && appBindings.length > 0
    if (appOnlyScope.value)
      allowOrgCreation.value = false

    const appBindingOrgIds = appBindings
      .map(binding => availableApps.value.find(app => app.id === binding.app_id)?.owner_org)
      .filter((orgId): orgId is string => !!orgId)

    selectedOrgsForCreation.value = Array.from(new Set([
      ...editableOrgBindings.map(binding => binding.org_id!),
      ...appBindingOrgIds,
    ]))

    selectedOrgRolesById.value = Object.fromEntries(
      editableOrgBindings
        .filter(binding => !!binding.org_id && !!binding.role_name)
        .map(binding => [binding.org_id!, binding.role_name]),
    )

    const firstOrgRole = Object.values(selectedOrgRolesById.value)[0]
    selectedOrgRole.value = firstOrgRole && orgRoleOptions.value.some(role => role.name === firstOrgRole)
      ? firstOrgRole
      : orgRoleOptions.value.find(role => role.name === 'org_member')?.name ?? orgRoleOptions.value[0]?.name ?? ''
    syncSelectedOrgRolesById(selectedOrgRole.value)

    pendingAppBindings.value = Object.fromEntries(
      appBindings.map(binding => [binding.app_id!, binding.role_name]),
    )

    await nextTick()
  }
  finally {
    isHydratingApiKeyEdit.value = false
  }

  await showEditKeyModal()
}

async function updateApiKey() {
  const key = editingApiKey.value
  if (!key)
    return false

  if (!validateApiKeyScope())
    return false

  const currentName = key.name || ''
  const trimmedName = newApiKeyName.value.trim()
  const nameChanged = trimmedName !== currentName

  if (nameChanged) {
    if (!trimmedName) {
      toast.error(t('name-required'))
      return false
    }

    if (trimmedName.length > 32) {
      toast.error(t('new-name-to-long'))
      return false
    }
  }

  let expiresAt: string | null = null
  if (setExpirationCheckbox.value && expirationDate.value)
    expiresAt = dayjs(expirationDate.value).toISOString()

  const { data, error } = await invokeCapgoApi('apikey', {
    method: 'PUT',
    body: {
      id: key.id,
      ...(nameChanged ? { name: trimmedName } : {}),
      expires_at: expiresAt,
      bindings: buildApiKeyBindingsFromForm(),
      global_permissions: buildApiKeyGlobalPermissionsFromForm(key),
    },
  })

  if (error || !data) {
    console.error('Error updating API key:', error)
    toast.error(await getUserFacingErrorMessage(error, t('error-updating-api-key')))
    return false
  }

  if (isHashedKey(key))
    data.key = null as any

  keys.value = keys.value.map((existingKey) => {
    if (existingKey.id === key.id)
      return data
    return existingKey
  })

  await fetchAllBindings()
  await fetchOrgAndAppNames()
  toast.success(t('api-key-updated'))
  return true
}

async function regenrateKey(apikey: Database['public']['Tables']['apikeys']['Row']) {
  if (!await confirmApiKeyRegeneration(dialogStore, t))
    return

  const { data: claimsData } = await supabase.auth.getClaims()
  const userId = claimsData?.claims?.sub

  if (!userId) {
    console.log('Not logged in, cannot regenerate API key')
    return
  }

  const wasHashed = isHashedKey(apikey)

  const { data, error } = await invokeCapgoApi('apikey', {
    method: 'PUT',
    body: {
      id: apikey.id,
      regenerate: true,
    },
  })

  if (error || !data) {
    console.error('Error regenerating API key:', error)
    toast.error(t('failed-to-regenerate-api-key'))
    return
  }

  const plainKeyForDisplay = typeof data.key === 'string' ? data.key : undefined

  if (wasHashed)
    data.key = null as any

  const idx = keys.value.findIndex(k => k.id === apikey.id)
  if (idx !== -1)
    keys.value[idx] = data

  if (plainKeyForDisplay)
    await showOneTimeKeyModal(plainKeyForDisplay)

  toast.success(t('generated-new-apikey'))
}

async function deleteKey(key: Database['public']['Tables']['apikeys']['Row']) {
  if (!await confirmApiKeyDeletion(dialogStore, t))
    return

  const { error } = await supabase
    .from('apikeys')
    .delete()
    .eq('id', key.id)

  if (error)
    throw error

  toast.success(t('removed-apikey'))
  keys.value = keys.value?.filter(filterKey => filterKey.id !== key.id)
}

async function showAddNewKeyModal() {
  dialogStore.openDialog({
    title: t('alert-add-new-key'),
    description: t('alert-generate-new-key'),
    size: '3xl',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('create'),
        role: 'primary',
        handler: () => {
          return createApiKey()
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function showEditKeyModal() {
  dialogStore.openDialog({
    title: t('edit-api-key'),
    description: t('type-new-name'),
    size: '3xl',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: () => {
          return updateApiKey()
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

function toggleOrgSelection(orgId: string) {
  if (!manageableOrgIds.value.has(orgId))
    return

  if (selectedOrgsForCreation.value.includes(orgId)) {
    selectedOrgsForCreation.value = selectedOrgsForCreation.value.filter(id => id !== orgId)
    return
  }

  selectedOrgsForCreation.value = [...selectedOrgsForCreation.value, orgId]
}

function toggleApp(appId: string) {
  if (appId in pendingAppBindings.value) {
    const updated = { ...pendingAppBindings.value }
    delete updated[appId]
    pendingAppBindings.value = updated
  }
  else {
    pendingAppBindings.value = { ...pendingAppBindings.value, [appId]: '' }
  }
}

function onAppRoleChange(appId: string, event: Event) {
  pendingAppBindings.value = { ...pendingAppBindings.value, [appId]: (event.target as HTMLSelectElement).value }
}

function hasIncompleteAppBindings() {
  return Object.values(pendingAppBindings.value).some(roleName => !roleName)
}

function getAppNameById(appId: string) {
  const app = availableApps.value.find(a => a.id === appId)
  return app ? (app.name || app.app_id) : appId
}

function getAppOrgNameById(appId: string) {
  const app = availableApps.value.find(a => a.id === appId)
  return app?.owner_org ? getOrgNameById(app.owner_org) : ''
}

function getApiKeyAdminOrgIds(key: Database['public']['Tables']['apikeys']['Row']) {
  return getBindingsForKey(key)
    .filter(binding => binding.scope_type === 'org' && !!binding.org_id && rolesWithInheritedAppAccess.has(binding.role_name))
    .map(binding => binding.org_id!)
}

function hasChannelPermissionApps(key: Database['public']['Tables']['apikeys']['Row']) {
  if (!key.rbac_id)
    return false

  const bindings = getBindingsForKey(key)
  return bindings.some(binding => binding.scope_type === 'app' && !!binding.app_id)
    || bindings.some(binding => binding.scope_type === 'org' && !!binding.org_id && rolesWithInheritedAppAccess.has(binding.role_name))
}

async function loadApiKeyChannelPermissionApps(key: Database['public']['Tables']['apikeys']['Row']) {
  channelPermissionAppsLoading.value = true
  channelPermissionAppOptions.value = []
  selectedChannelPermissionAppUuid.value = ''

  try {
    const bindings = getBindingsForKey(key)
    const directAppRoleById = new Map<string, string>()
    for (const binding of bindings) {
      if (binding.scope_type === 'app' && binding.app_id && binding.role_name)
        directAppRoleById.set(binding.app_id, binding.role_name)
    }

    const adminOrgIds = Array.from(new Set(getApiKeyAdminOrgIds(key)))
    const appRows: { id: string, app_id: string, name: string | null, owner_org: string }[] = []

    const directAppIds = Array.from(directAppRoleById.keys())
    if (directAppIds.length > 0) {
      const { data, error } = await supabase
        .from('apps')
        .select('id, app_id, name, owner_org')
        .in('id', directAppIds)

      if (error)
        throw error
      appRows.push(...((data || []) as { id: string, app_id: string, name: string | null, owner_org: string }[]))
    }

    if (adminOrgIds.length > 0) {
      const { data, error } = await supabase
        .from('apps')
        .select('id, app_id, name, owner_org')
        .in('owner_org', adminOrgIds)

      if (error)
        throw error
      appRows.push(...((data || []) as { id: string, app_id: string, name: string | null, owner_org: string }[]))
    }

    const uniqueAppsById = new Map<string, { id: string, app_id: string, name: string | null, owner_org: string }>()
    for (const app of appRows) {
      if (app.id)
        uniqueAppsById.set(app.id, app)
    }

    const options = Array.from(uniqueAppsById.values()).map((app): ApiKeyAppAccessOption => {
      const displayName = app.name || app.app_id
      return {
        appUuid: app.id,
        publicAppId: app.app_id,
        appName: displayName,
        orgId: app.owner_org,
        orgName: getOrgNameById(app.owner_org),
        roleName: directAppRoleById.get(app.id) ?? 'app_admin',
      }
    }).sort((a, b) => a.appName.localeCompare(b.appName))

    cacheAppNames(Array.from(uniqueAppsById.values()))
    channelPermissionAppOptions.value = options
    selectedChannelPermissionAppUuid.value = options[0]?.appUuid ?? ''
  }
  catch (error) {
    console.error('Error loading API key channel permission apps:', error)
    toast.error(t('error-loading-channel-permissions'))
  }
  finally {
    channelPermissionAppsLoading.value = false
  }
}

async function openApiKeyChannelPermissions(key: Database['public']['Tables']['apikeys']['Row']) {
  if (!key.rbac_id)
    return

  selectedApiKeyForChannelPermissions.value = key
  channelPermissionAppOptions.value = []
  selectedChannelPermissionAppUuid.value = ''

  dialogStore.openDialog({
    id: 'apikey-channel-permissions',
    title: t('channel-permissions-title'),
    description: t('channel-permissions-description'),
    size: 'xl',
    buttons: [
      {
        text: t('close'),
        role: 'cancel',
      },
    ],
  })

  await loadApiKeyChannelPermissionApps(key)
}

async function getUserFacingErrorMessage(error: unknown, fallbackMessage: string) {
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    try {
      const payload = await error.context.clone().json() as { message?: string, error?: string, error_description?: string }
      if (typeof payload.message === 'string' && payload.message)
        return payload.message
      if (typeof payload.error_description === 'string' && payload.error_description)
        return payload.error_description
      if (typeof payload.error === 'string' && payload.error)
        return payload.error
    }
    catch {
    }
  }

  if (error instanceof Error && error.message)
    return error.message

  return fallbackMessage
}

async function copyKey(apikey: ApiKeyRow) {
  // Cannot copy hashed keys - they are never stored in plain text
  if (isHashedKey(apikey)) {
    toast.error(t('cannot-copy-secure-key'))
    return
  }

  // List endpoint omits the raw key; load it on demand for plain keys only.
  let key = apikey.key
  if (!key) {
    const { data, error } = await supabase
      .from('apikeys')
      .select('key')
      .eq('id', apikey.id)
      .single()

    if (error || !data?.key) {
      toast.error(t('cannot-copy-key'))
      return
    }
    key = data.key
  }

  try {
    await navigator.clipboard.writeText(key)
    toast.success(t('key-copied'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    dialogStore.openDialog({
      title: t('cannot-copy-key'),
      description: key,
      buttons: [
        {
          text: t('ok'),
          role: 'primary',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}

// Watch for org selection changes to prune app bindings
watch([scopeFilterLabels, currentOrganizationId], () => {
  syncScopeFilters()
  applyCurrentOrganizationDefaultFilter()
}, { immediate: true })

watch(selectedOrgsForCreation, () => {
  syncSelectedOrgRolesById()
  pruneAppBindings()
  ensureSelectedOrgRoleAllowed()
}, { deep: true })

watch(orgRoleOptions, () => {
  ensureSelectedOrgRoleAllowed()
})

watch(appOnlyScope, (isAppOnly) => {
  if (isAppOnly)
    allowOrgCreation.value = false
})

watch(canEnableOrgCreation, (canEnable) => {
  if (!canEnable)
    allowOrgCreation.value = false
})

// Watch for org role changes - clear app bindings if role grants inherited access
watch(selectedOrgRole, (newRole) => {
  if (isHydratingApiKeyEdit.value)
    return

  if (isEditingApiKey.value)
    syncSelectedOrgRolesById(newRole, true)

  if (!appOnlyScope.value && rolesWithInheritedAppAccess.has(newRole))
    pendingAppBindings.value = {}
})

displayStore.NavTitle = t('api-keys')
displayStore.defaultBack = '/apps'
getKeys()
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col">
          <div class="flex flex-col overflow-hidden overflow-y-auto bg-white md:mt-5 md:rounded-lg md:border md:shadow-lg border-slate-300 dark:border-slate-900 dark:bg-slate-800">
            <DataTable
              v-model:current-page="currentPage"
              add-button-test-id="create-key"
              show-add
              :auto-reload="false"
              :columns="columns"
              :element-list="filteredAndSortedKeys"
              :filter-labels="scopeFilterLabels"
              :filters="scopeFilters"
              filter-text="scope"
              :is-loading="isLoading"
              :total="filteredAndSortedKeys.length"
              :search-placeholder="t('search-api-keys')"
              :search="searchQuery"
              @add="addNewApiKey"
              @update:filters="updateScopeFilters"
              @update:search="searchQuery = $event"
              @reload="getKeys()"
              @reset="refreshData()"
            />
          </div>
          <p class="mt-6 ml-4">
            {{ t('api-keys-are-used-for-cli-and-public-api') }}
          </p>
          <div class="mb-2 ml-4">
            <a
              class="inline-flex items-center text-blue-500 underline rounded-sm focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:outline-none"
              href="https://capgo.app/docs/cli/reference/key/"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`${t('cli-doc')} (opens in new tab)`"
            >
              {{ t('cli-doc') }}
              <svg class="w-3 h-3 ml-1" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
                <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
              </svg>
            </a>
            <a
              class="inline-flex items-center ml-1 text-blue-500 underline rounded-sm focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:outline-none"
              href="https://capgo.app/docs/public-api/api-keys/"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`${t('api-doc')} (opens in new tab)`"
            >
              {{ t('api-doc') }}
              <svg class="w-3 h-3 ml-1" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
                <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
              </svg>
            </a>
          </div>
        </div>
      </div>

      <Teleport to="body">
        <div
          v-if="scopePicker"
          class="fixed inset-0 z-40"
          @click="closeScopePicker"
        />
        <div
          v-if="scopePicker"
          class="fixed z-50 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800"
          :style="{ left: `${scopePicker.x}px`, top: `${scopePicker.y}px`, width: `${scopePicker.width}px` }"
          role="dialog"
          :aria-label="scopePicker.title"
        >
          <div class="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
            <h2 class="min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {{ scopePicker.title }}
            </h2>
            <button
              type="button"
              class="flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:ring-2 focus:ring-cyan-500 focus:outline-none dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
              :aria-label="t('close')"
              @click="closeScopePicker"
            >
              <IconXMark class="size-4" />
            </button>
          </div>
          <div v-if="scopePicker.items.length > 8" class="border-b border-slate-200 p-2 dark:border-slate-700">
            <label for="scope-picker-search" class="sr-only">{{ t('search-scope-items') }}</label>
            <input
              id="scope-picker-search"
              v-model="scopePickerQuery"
              type="search"
              class="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              :placeholder="t('search-scope-items')"
              :aria-label="t('search-scope-items')"
            >
          </div>
          <ul class="max-h-80 overflow-y-auto p-2">
            <li v-for="item in filteredScopePickerItems" :key="`${item.type ?? 'item'}-${item.id}`">
              <button
                type="button"
                class="flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-cyan-50 hover:text-cyan-700 focus:ring-2 focus:ring-cyan-500 focus:outline-none dark:text-slate-200 dark:hover:bg-cyan-500/10 dark:hover:text-cyan-200"
                :class="isScopeItemActive(item) ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-200' : ''"
                @click="selectScopeItem(item)"
              >
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
              </button>
            </li>
          </ul>
          <div
            v-if="filteredScopePickerItems.length === 0"
            class="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400"
          >
            {{ t('no_elements_found') }}
          </div>
        </div>
      </Teleport>

      <!-- Teleport Content for Add/Edit Key Modal -->
      <Teleport v-if="dialogStore.showDialog && (dialogStore.dialogOptions?.title === t('alert-add-new-key') || dialogStore.dialogOptions?.title === t('edit-api-key'))" defer to="#dialog-v2-content">
        <div class="space-y-6">
          <!-- API Key Name -->
          <div>
            <FormKit
              v-model="newApiKeyName"
              type="text"
              data-test="create-key-name"
              :label="t('name')"
              :placeholder="t('type-new-name')"
              validation="required|length:1,32"
              :validation-messages="{
                length: t('name-length-error'),
              }"
            />
          </div>

          <!-- Create as Secure (Hashed) Key -->
          <div v-if="!isEditingApiKey" class="p-4 border border-blue-200 rounded-lg bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700">
            <div class="flex items-start gap-3">
              <input
                id="create-as-hashed"
                v-model="createAsHashed"
                type="checkbox"
                class="mt-1 border-blue-500 dark:border-blue-400 checkbox checkbox-primary"
              >
              <div>
                <label for="create-as-hashed" class="font-medium text-blue-800 cursor-pointer dark:text-blue-200">
                  {{ t('create-secure-key') }}
                </label>
                <p class="mt-1 text-sm text-blue-600 dark:text-blue-300">
                  {{ t('create-secure-key-description') }}
                </p>
              </div>
            </div>
          </div>
          <div class="rounded-lg border border-azure-200 bg-azure-50 p-4 dark:border-azure-500/30 dark:bg-azure-500/10">
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                v-model="appOnlyScope"
                type="checkbox"
                data-test="create-key-app-only-scope"
                class="mt-1 d-checkbox d-checkbox-primary d-checkbox-sm"
              >
              <span>
                <span class="block text-sm font-medium text-slate-800 dark:text-white">
                  {{ t('api-key-selected-apps-only') }}
                </span>
                <span class="mt-1 block text-sm text-slate-600 dark:text-slate-300">
                  {{ t('api-key-selected-apps-only-description') }}
                </span>
              </span>
            </label>
          </div>
          <!-- Organizations Selection (all checked by default) -->
          <div>
            <h3 class="mb-2 text-sm font-semibold uppercase text-slate-500">
              {{ t(appOnlyScope ? 'api-key-selected-apps-only-org-filter' : 'organizations') }}
            </h3>
            <p v-if="appOnlyScope" class="mb-2 text-sm text-slate-500">
              {{ t('api-key-selected-apps-only-org-filter-description') }}
            </p>
            <div class="relative">
              <button
                type="button"
                data-test="create-key-org-dropdown"
                class="flex items-center justify-between w-full gap-3 px-3 py-2 text-sm text-left bg-white border rounded-lg border-slate-300 dark:bg-gray-800 dark:border-slate-600 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                :aria-expanded="showOrgDropdown"
                @click="showOrgDropdown = !showOrgDropdown"
              >
                <span class="flex-1 truncate" :class="selectedOrgsForCreation.length ? 'text-slate-800 dark:text-white' : 'text-slate-500'">
                  {{ selectedOrgNamesForCreation || t('select-organization') }}
                </span>
                <svg class="w-4 h-4 text-slate-500 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
                </svg>
              </button>
              <div v-if="showOrgDropdown" class="fixed inset-0 z-10" @click="showOrgDropdown = false" />
              <div
                v-if="showOrgDropdown"
                class="absolute z-20 w-full mt-1 overflow-y-auto bg-white border rounded-lg shadow-lg top-full dark:bg-gray-800 border-slate-200 dark:border-slate-700 max-h-64"
              >
                <label
                  v-for="org in organizationStore.organizations"
                  :key="org.gid"
                  class="flex items-center gap-3 px-4 py-2.5 transition-colors"
                  :class="manageableOrgIds.has(org.gid) ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700' : 'cursor-not-allowed text-slate-400'"
                >
                  <input
                    type="checkbox"
                    data-test="create-key-org-checkbox"
                    :data-org-id="org.gid"
                    class="d-checkbox d-checkbox-sm d-checkbox-primary"
                    :checked="selectedOrgsForCreation.includes(org.gid)"
                    :disabled="!manageableOrgIds.has(org.gid)"
                    @change="toggleOrgSelection(org.gid)"
                  >
                  <span class="flex-1 text-sm truncate">
                    {{ org.name }}
                    <span v-if="!manageableOrgIds.has(org.gid)" class="text-xs text-slate-400">
                      ({{ t('cannot-manage-org-api-keys') }})
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <!-- Organization Role -->
          <div v-if="!appOnlyScope">
            <h3 class="mb-2 text-sm font-semibold uppercase text-slate-500">
              {{ t('role') }}
            </h3>
            <p class="mb-3 text-sm text-slate-500">
              {{ t('select-user-role') }}
            </p>
            <div class="space-y-2">
              <div
                v-for="role in orgRoleOptions"
                :key="role.id"
                class="flex items-center gap-2 rounded-md border p-3 transition-colors"
                :class="selectedOrgRole === role.name
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30 dark:bg-primary/10'
                  : 'border-slate-200 bg-white hover:border-primary/60 dark:border-slate-700 dark:bg-slate-950'"
              >
                <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    v-model="selectedOrgRole"
                    type="radio"
                    :data-test="`create-key-org-role-${role.name}`"
                    class="d-radio d-radio-primary d-radio-sm"
                    name="create-org-role"
                    :value="role.name"
                  >
                  <span class="text-sm font-medium dark:text-white text-slate-800">{{ role.description }}</span>
                </label>
                <RoleCapabilitiesHint :role-name="role.name" />
              </div>
            </div>
          </div>

          <!-- Global organization permissions -->
          <div v-if="!appOnlyScope && !hideOrgCreationPermission" class="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
            <label class="flex items-start gap-3" :class="canEnableOrgCreation ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'">
              <input
                v-model="allowOrgCreation"
                type="checkbox"
                data-test="create-key-org-create-permission"
                class="mt-1 d-checkbox d-checkbox-primary d-checkbox-sm"
                :disabled="!canEnableOrgCreation"
              >
              <span>
                <span class="block text-sm font-medium text-slate-800 dark:text-white">
                  {{ t('allow-api-key-create-organizations') }}
                </span>
                <span class="mt-1 block text-sm text-slate-500 dark:text-slate-400">
                  {{ t(canEnableOrgCreation ? 'allow-api-key-create-organizations-description' : 'allow-api-key-create-organizations-requires-admin') }}
                </span>
              </span>
            </label>
          </div>

          <!-- App Access Control -->
          <div v-if="showAppAccessInModal">
            <h3 class="mb-2 text-sm font-semibold uppercase text-slate-500">
              {{ t('app-access-control') }}
            </h3>
            <p class="mb-3 text-sm text-slate-500">
              {{ t(appOnlyScope ? 'api-key-selected-apps-only-app-access' : 'app-access-member-only') }}
            </p>

            <!-- Add app dropdown -->
            <div class="flex justify-end mb-4">
              <div class="relative">
                <button
                  data-test="create-key-add-app"
                  class="gap-2 d-btn d-btn-sm d-btn-outline"
                  type="button"
                  @click="showAppDropdown = !showAppDropdown"
                >
                  <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                  </svg>
                  {{ t('add-app') }}
                </button>
                <div v-if="showAppDropdown" class="fixed inset-0 z-10" @click="showAppDropdown = false" />
                <div
                  v-if="showAppDropdown"
                  class="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-gray-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg min-w-[240px] max-h-60 overflow-y-auto"
                >
                  <div v-if="filteredAppsForSelectedOrgs.length === 0" class="px-4 py-3 text-sm text-slate-500">
                    {{ t('no-apps') }}
                  </div>
                  <label
                    v-for="app in filteredAppsForSelectedOrgs"
                    :key="app.id"
                    class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    <input
                      type="checkbox"
                      data-test="create-key-app-checkbox"
                      :data-app-id="app.id"
                      class="d-checkbox d-checkbox-sm d-checkbox-primary"
                      :checked="app.id in pendingAppBindings"
                      @change="toggleApp(app.id)"
                    >
                    <div>
                      <div class="text-sm font-medium dark:text-white text-slate-800">
                        {{ app.name || app.app_id }}
                      </div>
                      <div v-if="app.name" class="text-xs text-slate-500">
                        {{ app.app_id }}
                      </div>
                      <div class="text-xs text-slate-500">
                        {{ getOrgNameById(app.owner_org) }}
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <!-- Selected apps with role selection -->
            <div v-if="selectedAppIds.length === 0" class="py-4 text-sm text-slate-500">
              {{ t('app-access-none') }}
            </div>
            <div v-else class="overflow-hidden border rounded-lg border-slate-200 dark:border-slate-700">
              <div
                v-for="appId in selectedAppIds"
                :key="appId"
                data-test="create-key-selected-app"
                class="flex items-center gap-3 px-4 py-2.5 border-b last:border-0 border-slate-100 dark:border-slate-700 hover:bg-slate-50/50 dark:hover:bg-slate-700/20"
              >
                <span class="flex-1 text-sm font-medium truncate dark:text-white text-slate-800">
                  {{ getAppNameById(appId) }}
                  <span v-if="getAppOrgNameById(appId)" class="block text-xs font-normal text-slate-500">
                    {{ getAppOrgNameById(appId) }}
                  </span>
                </span>
                <select
                  :id="`create-key-app-role-${appId}`"
                  data-test="create-key-app-role-select"
                  :aria-label="t('select-role')"
                  class="d-select d-select-sm d-select-bordered"
                  :value="pendingAppBindings[appId] || ''"
                  @change="onAppRoleChange(appId, $event)"
                >
                  <option value="">
                    {{ t('select-role') }}
                  </option>
                  <option
                    v-for="role in appRoleOptions"
                    :key="role.id"
                    :value="role.name"
                  >
                    {{ role.description }}
                  </option>
                </select>
                <RoleCapabilitiesHint
                  v-if="pendingAppBindings[appId]"
                  :role-name="pendingAppBindings[appId]"
                />
                <button
                  class="text-red-500 d-btn d-btn-xs d-btn-ghost shrink-0"
                  type="button"
                  @click="toggleApp(appId)"
                >
                  <IconTrash class="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <!-- Set Expiration Date -->
          <div class="flex items-center gap-2">
            <input
              id="set-expiration"
              v-model="setExpirationCheckbox"
              type="checkbox"
              class="border-gray-500 dark:border-gray-700 checkbox"
            >
            <label for="set-expiration" class="text-sm">
              {{ t('set-expiration-date') }}
            </label>
          </div>
          <div v-if="setExpirationCheckbox" class="pl-6">
            <label class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              {{ t('expiration-date') }}
            </label>
            <VueDatePicker
              v-model="expirationDate"
              :min-date="minExpirationDate"
              :enable-time-picker="false"
              :time-picker-inline="false"
              :time-picker="false"
              :time-config="{ enableTimePicker: false }"
              :dark="isDark"
              teleport="body"
              :auto-apply="true"
              hide-input-icon
              :action-row="{ showCancel: false, showSelect: false, showNow: false, showPreview: false }"
              :placeholder="t('select-expiration-date')"
              :ui="{ menu: 'apikey-datepicker-menu' }"
            >
              <template #trigger>
                <button
                  type="button"
                  class="flex items-center w-full gap-2 px-3 py-2 text-sm text-left transition-colors bg-white border border-gray-300 rounded-md dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                >
                  <IconCalendar class="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  <span :class="expirationDate ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'">
                    {{ expirationDate ? formatLocalDate(expirationDate) : t('select-expiration-date') }}
                  </span>
                </button>
              </template>
            </VueDatePicker>
          </div>
        </div>
      </Teleport>

      <!-- Teleport Content for API Key Channel Permissions -->
      <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'apikey-channel-permissions'" defer to="#dialog-v2-content">
        <div class="space-y-4">
          <div v-if="channelPermissionAppsLoading" class="py-6 text-sm text-gray-500">
            {{ t('loading') }}...
          </div>
          <div v-else-if="channelPermissionAppOptions.length === 0" class="py-6 text-sm text-gray-500">
            {{ t('app-access-none') }}
          </div>
          <template v-else-if="selectedApiKeyForChannelPermissions?.rbac_id && selectedChannelPermissionApp">
            <div>
              <label for="apikey-channel-permissions-app-select" class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                {{ t('app') }}
              </label>
              <select
                id="apikey-channel-permissions-app-select"
                v-model="selectedChannelPermissionAppUuid"
                :aria-label="t('app')"
                class="w-full d-select d-select-bordered"
                data-test="apikey-channel-permissions-app-select"
              >
                <option
                  v-for="app in channelPermissionAppOptions"
                  :key="app.appUuid"
                  :value="app.appUuid"
                >
                  {{ app.appName }} · {{ getRoleDisplayName(app.roleName) }} · {{ app.orgName }}
                </option>
              </select>
            </div>

            <ChannelPermissionOverridesPanel
              :app-id="selectedChannelPermissionApp.publicAppId"
              principal-type="apikey"
              :principal-id="selectedApiKeyForChannelPermissions.rbac_id"
              :principal-name="selectedApiKeyForChannelPermissions.name || hideString(selectedApiKeyForChannelPermissions.key)"
              :role-name="selectedChannelPermissionApp.roleName"
            />
          </template>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<route lang="yaml">
path: /apikeys
</route>
