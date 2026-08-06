import type { AuthChangeEvent } from '@supabase/supabase-js'
import type { ComputedRef, Ref } from 'vue'
import type { Database } from '~/types/supabase.types'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { createSignedImageUrl, getImmediateImageUrl, resolveImagePath } from '~/services/storage'
import { isPlatformAdmin, stripeEnabled, useSupabase } from '~/services/supabase'
import { clearWebsitePaidUserCookie, setWebsitePaidUserCookie, syncWebsitePaidUserCookieFromOrganizations } from '~/services/websiteAuthCookie'
import { createDeferredPromise } from '../utils/promise'
import { useDashboardAppsStore } from './dashboardApps'
import { useDisplayStore } from './display'
import { useMainStore } from './main'

// Password policy configuration interface
export interface PasswordPolicyConfig {
  enabled: boolean
  min_length: number
  require_uppercase: boolean
  require_number: boolean
  require_special: boolean
}

// Extended organization type with password policy and 2FA fields (from get_orgs_v7)
// Note: Using get_orgs_v7 return type with explicit JSON parsing for password_policy_config
type RawOrganization = Database['public']['Functions']['get_orgs_v7']['Returns'][number]
export type Organization = Omit<RawOrganization, 'password_policy_config' | 'stats_refresh_requested_at' | 'stats_updated_at'> & {
  logo_storage_path?: string | null
  logo_is_loading?: boolean
  password_policy_config: PasswordPolicyConfig | null
  stats_refresh_requested_at: string | null
  stats_updated_at: string | null
}
export interface OrganizationApp {
  app_id: string
  name: string | null
  owner_org: string
  need_onboarding: boolean
  icon_url: string | null
  icon_storage_path?: string | null
  icon_url_loading?: boolean
}
export type OrganizationRole
  = 'owner'
    | 'org_member'
    | 'org_billing_admin'
    | 'org_admin'
    | 'org_super_admin'
type OrgMemberRow = Database['public']['Functions']['get_org_members']['Returns'][number]
export type ExtendedOrganizationMember = OrgMemberRow & { id: number | string }
export type ExtendedOrganizationMembers = ExtendedOrganizationMember[]
type SignedMemberImageCallback = (signedImages: Map<string, string>) => void
type OrgPermissionFloor = 'org_member' | 'org_billing_admin' | 'org_admin' | 'org_super_admin' | 'owner'

// Mapping des rôles RBAC d'organisation vers leurs clés de traduction i18n
export const RBAC_ORG_ROLE_I18N_KEYS: Record<string, string> = {
  org_super_admin: 'role-org-super-admin',
  org_admin: 'role-org-admin',
  org_billing_admin: 'role-org-billing-admin',
  org_member: 'role-org-member',
  app_admin: 'role-app-admin',
  app_preview: 'role-app-preview',
  app_developer: 'role-app-developer',
  app_notifications: 'role-app-notifications',
  app_uploader: 'role-app-uploader',
  app_reader: 'role-app-reader',
  channel_admin: 'role-channel-admin',
  channel_reader: 'role-channel-reader',
}

/**
 * Obtient la clé i18n pour un rôle RBAC d'organisation
 * @param role Le nom technique du rôle
 * @returns La clé de traduction i18n, ou undefined si non mappé
 */
export function getRbacRoleI18nKey(role: string): string | undefined {
  return RBAC_ORG_ROLE_I18N_KEYS[role]
}

const ORG_ROLE_RANK: Record<string, number> = {
  org_member: 1,
  org_billing_admin: 2,
  org_admin: 3,
  org_super_admin: 4,
  owner: 4,
}

export function roleHasOrgRank(role: string | null | undefined, minRole: 'org_member' | 'org_billing_admin' | 'org_admin' | 'org_super_admin') {
  if (!role)
    return false
  return (ORG_ROLE_RANK[role] ?? 0) >= ORG_ROLE_RANK[minRole]
}

export function isAdminRole(role: string | null | undefined) {
  return roleHasOrgRank(role, 'org_admin')
}

export function isSuperAdminRole(role: string | null | undefined) {
  return roleHasOrgRank(role, 'org_super_admin')
}

function normalizeRbacRole(role: string, scope: 'org' | 'app') {
  if (role === 'owner')
    return scope === 'org' ? 'org_super_admin' : 'app_admin'
  if (scope === 'app' && (role === 'org_admin' || role === 'org_super_admin'))
    return 'app_admin'
  return role
}

function matchesRbacRole(role: string, requiredRole: string) {
  if (role === requiredRole)
    return true
  if (requiredRole.startsWith('org_'))
    return normalizeRbacRole(role, 'org') === requiredRole
  if (requiredRole.startsWith('app_'))
    return normalizeRbacRole(role, 'app') === requiredRole
  return role === requiredRole
}

export function isPendingOrganizationInvite(org: Pick<Organization, 'is_invite' | 'role'>) {
  if (org.is_invite !== null && org.is_invite !== undefined)
    return org.is_invite === true
  return org.role.startsWith('invite')
}

function isSelectableOrganization(org: Pick<Organization, 'is_invite' | 'role'>) {
  return !isPendingOrganizationInvite(org)
}

const supabase = useSupabase()

export const useOrganizationStore = defineStore('organization', () => {
  const main = useMainStore()
  const _organizations: Ref<Map<string, Organization>> = ref(new Map())
  const _organizationsByAppId: Ref<Map<string, Organization>> = ref(new Map())
  const _appsByOrgId: Ref<Map<string, OrganizationApp[]>> = ref(new Map())
  const _appsByAppId: Ref<Map<string, OrganizationApp>> = ref(new Map())
  const _initialLoadPromise = ref(createDeferredPromise<boolean>())
  const _initialized = ref(false)

  const organizations: ComputedRef<Organization[]> = computed(
    () => {
      return Array.from(
        _organizations.value,
        ([_key, value]) => value,
      )
    },
  )
  const hasOrganizations = computed(() => organizations.value.some(org => isSelectableOrganization(org)))

  const getCurrentRole = async (appOwner: string, appId?: string, channelId?: number): Promise<OrganizationRole> => {
    if (_organizations.value.size === 0) {
      // eslint-disable-next-line ts/no-use-before-define
      await fetchOrganizations()
    }
    for (const org of _organizations.value.values()) {
      if (org.created_by === appOwner)
        return org.role as OrganizationRole
    }

    throw new Error(`Cannot find role for (${appOwner}, ${appId}, ${channelId}))`)
  }

  // WARNING: currentOrganization does not guarantee correctness when used in an app-based URL
  // For example if you try to use this value when fetching app channels it COULD BE incorrect
  // When trying to fetch an organization in an app based component the following should be used
  //
  // const organization = ref(null as null | Organization)
  // watchEffect(async () => {
  //  await organizationStore.awaitInitialLoad()
  //  organization.value = organizationStore.getOrgByAppId(appId.value) ?? null
  // }
  //
  const currentOrganization = ref<Organization | undefined>(undefined)
  const currentOrganizationFailed = ref(false)
  const currentRole = ref<OrganizationRole | null>(null)

  const STORAGE_KEY = 'capgo_current_org_id'
  let organizationLogoLoadRun = 0
  let organizationAppIconLoadRun = 0

  const getMemberImageKey = (member: { uid?: string | null, id?: number | string | null, email?: string | null }) => {
    return String(member.uid ?? member.id ?? member.email ?? '')
  }

  const loadSignedMemberImages = async (
    sources: Array<{ key: string, imageUrl?: string | null }>,
    onSignedImages: SignedMemberImageCallback,
  ) => {
    const signedImageEntries = await Promise.all(sources.map(async (source) => {
      if (!source.key || !source.imageUrl || getImmediateImageUrl(source.imageUrl))
        return null

      try {
        const signedImageUrl = await createSignedImageUrl(source.imageUrl)
        return signedImageUrl ? [source.key, signedImageUrl] as const : null
      }
      catch (error) {
        console.warn('Cannot load signed member image', { memberKey: source.key, error })
        return null
      }
    }))

    const signedImages = new Map<string, string>()
    for (const entry of signedImageEntries) {
      if (entry)
        signedImages.set(entry[0], entry[1])
    }

    if (signedImages.size > 0)
      onSignedImages(signedImages)
  }

  const updateOrganizationLogoState = (orgId: string, patch: Partial<Organization>, run: number) => {
    if (run !== organizationLogoLoadRun)
      return

    const organization = _organizations.value.get(orgId)
    if (!organization)
      return

    const hasChanges = Object.entries(patch).some(([key, value]) => organization[key as keyof Organization] !== value)
    if (!hasChanges)
      return

    const nextOrganization = {
      ...organization,
      ...patch,
    }
    const nextOrganizations = new Map(_organizations.value)
    nextOrganizations.set(orgId, nextOrganization)
    _organizations.value = nextOrganizations

    if (currentOrganization.value?.gid === orgId)
      currentOrganization.value = nextOrganization
  }

  const loadOrganizationLogo = async (org: Organization & { id: number }, run: number) => {
    const logoSource = org.logo_storage_path ?? org.logo
    const { normalized, shouldSign } = resolveImagePath(logoSource)
    if (!normalized || !shouldSign) {
      updateOrganizationLogoState(org.gid, { logo_is_loading: false }, run)
      return
    }

    try {
      const signedLogo = await createSignedImageUrl(normalized)
      updateOrganizationLogoState(org.gid, {
        logo: signedLogo || org.logo,
        logo_storage_path: normalized,
        logo_is_loading: false,
      }, run)
    }
    catch (error) {
      console.warn('Cannot load signed organization logo', { orgId: org.gid, error })
      updateOrganizationLogoState(org.gid, { logo_is_loading: false }, run)
    }
  }

  const loadOrganizationLogos = (sourceOrganizations: Array<Organization & { id: number }>, run: number) => {
    for (const org of sourceOrganizations) {
      loadOrganizationLogo(org, run).catch((error) => {
        console.warn('Cannot load signed organization logo', { orgId: org.gid, error })
        updateOrganizationLogoState(org.gid, { logo_is_loading: false }, run)
      })
    }
  }

  const appWithImmediateIcon = (app: { app_id: string, name: string | null, owner_org: string, need_onboarding: boolean, icon_url: string | null }): OrganizationApp => {
    const { normalized, shouldSign } = resolveImagePath(app.icon_url)
    return {
      app_id: app.app_id,
      name: app.name,
      owner_org: app.owner_org,
      need_onboarding: app.need_onboarding,
      icon_url: shouldSign ? '' : normalized || null,
      icon_storage_path: normalized || null,
      icon_url_loading: shouldSign,
    }
  }

  const updateOrganizationAppIconState = (appId: string, patch: Partial<OrganizationApp>, run: number) => {
    if (run !== organizationAppIconLoadRun)
      return

    const app = _appsByAppId.value.get(appId)
    if (!app)
      return

    const nextApp = { ...app, ...patch }
    const nextAppsByAppId = new Map(_appsByAppId.value)
    nextAppsByAppId.set(appId, nextApp)

    const nextAppsByOrgId = new Map(_appsByOrgId.value)
    const orgApps = nextAppsByOrgId.get(nextApp.owner_org)
    if (orgApps)
      nextAppsByOrgId.set(nextApp.owner_org, orgApps.map(orgApp => orgApp.app_id === appId ? nextApp : orgApp))

    _appsByAppId.value = nextAppsByAppId
    _appsByOrgId.value = nextAppsByOrgId
  }

  const loadOrganizationAppIcon = async (app: OrganizationApp, run: number) => {
    if (!app.icon_url_loading || !app.icon_storage_path)
      return

    try {
      const signedIcon = await createSignedImageUrl(app.icon_storage_path)
      updateOrganizationAppIconState(app.app_id, {
        icon_url: signedIcon || '',
        icon_url_loading: false,
      }, run)
    }
    catch (error) {
      console.warn('Cannot load signed app icon', { appId: app.app_id, error })
      updateOrganizationAppIconState(app.app_id, { icon_url_loading: false }, run)
    }
  }

  const loadOrganizationAppIcons = (sourceApps: OrganizationApp[], run: number) => {
    for (const app of sourceApps) {
      loadOrganizationAppIcon(app, run).catch((error) => {
        console.warn('Cannot load signed app icon', { appId: app.app_id, error })
        updateOrganizationAppIconState(app.app_id, { icon_url_loading: false }, run)
      })
    }
  }

  watch([currentOrganization, stripeEnabled], async ([currentOrganizationRaw, stripeEnabledValue], [previousOrganization]) => {
    if (!currentOrganizationRaw) {
      currentRole.value = null
      localStorage.removeItem(STORAGE_KEY)
      return
    }

    localStorage.setItem(STORAGE_KEY, currentOrganizationRaw.gid)
    currentRole.value = await getCurrentRole(currentOrganizationRaw.created_by)
    // Don't mark as failed if user lacks 2FA or password access - the data is redacted and unreliable
    const lacks2FAAccess = currentOrganizationRaw.enforcing_2fa === true && currentOrganizationRaw['2fa_has_access'] === false
    const lacksPasswordAccess = currentOrganizationRaw.password_policy_config?.enabled && currentOrganizationRaw.password_has_access === false
    if (lacks2FAAccess || lacksPasswordAccess || !stripeEnabledValue) {
      currentOrganizationFailed.value = false
    }
    else {
      currentOrganizationFailed.value = !(!!currentOrganizationRaw.paying || (currentOrganizationRaw.trial_left ?? 0) > 0 || !!currentOrganizationRaw.can_use_more)
    }

    // Clear caches when org changes to prevent showing stale data from other orgs
    if (previousOrganization?.gid !== currentOrganizationRaw.gid) {
      const displayStore = useDisplayStore()
      displayStore.clearCachesForOrg(currentOrganizationRaw.gid)

      // Reset and refetch dashboard apps for the new org
      const dashboardAppsStore = useDashboardAppsStore()
      dashboardAppsStore.reset()
      // Fetch apps for the new org - don't await to avoid blocking other operations
      dashboardAppsStore.fetchApps(true)
    }

    // Always fetch last 30 days of data and filter client-side for billing period
    // End date should be tomorrow at midnight to include all of today's data
    const last30DaysEnd = new Date()
    last30DaysEnd.setHours(0, 0, 0, 0)
    last30DaysEnd.setDate(last30DaysEnd.getDate() + 1) // Tomorrow midnight
    const last30DaysStart = new Date()
    last30DaysStart.setHours(0, 0, 0, 0)
    last30DaysStart.setDate(last30DaysStart.getDate() - 29) // 30 days including today
    try {
      await main.updateDashboard(currentOrganizationRaw.gid, last30DaysStart.toISOString(), last30DaysEnd.toISOString())
    }
    catch (error) {
      // Silently catch dashboard errors - they're logged elsewhere and shouldn't block UI
      console.error('Failed to update dashboard:', error)
    }
  })

  watch(_organizations, async (organizationsMap) => {
    // Only run once - if we already have the app-to-org mapping, skip
    if (_organizationsByAppId.value.size > 0)
      return

    const organizations = Array.from(organizationsMap.values())
    const selectableOrganizations = organizations.filter(org => isSelectableOrganization(org))
    const orgIds = selectableOrganizations.map(org => org.gid)

    if (orgIds.length === 0) {
      _appsByOrgId.value = new Map()
      _appsByAppId.value = new Map()
      _initialLoadPromise.value.resolve(true)
      return
    }

    const appIconLoadRun = ++organizationAppIconLoadRun
    const { error, data: allAppsByOwner } = await supabase
      .from('apps')
      .select('app_id, name, owner_org, need_onboarding, icon_url')
      .in('owner_org', orgIds)

    if (error) {
      console.error('Cannot get app apps for org store', error)
      return
    }

    if (appIconLoadRun !== organizationAppIconLoadRun)
      return

    const organizationsByAppId = new Map<string, Organization>()
    const appsByOrgId = new Map<string, OrganizationApp[]>()
    const appsByAppId = new Map<string, OrganizationApp>()

    for (const app of allAppsByOwner) {
      // For each app find the org_id that owns said app
      // This is needed for the "banner"
      const org = selectableOrganizations.find(org => org.gid === app.owner_org)
      if (!org) {
        console.error(`Cannot find organization for app`, app)
        _initialLoadPromise.value.reject(`Cannot find organization for app ${app}`)
        return
      }

      organizationsByAppId.set(app.app_id, org)

      const indexedApp = appWithImmediateIcon(app)
      appsByAppId.set(indexedApp.app_id, indexedApp)
      const orgApps = appsByOrgId.get(indexedApp.owner_org) ?? []
      orgApps.push(indexedApp)
      appsByOrgId.set(indexedApp.owner_org, orgApps)
    }

    for (const apps of appsByOrgId.values()) {
      apps.sort((a, b) => (a.name || a.app_id).localeCompare(b.name || b.app_id))
    }

    _organizationsByAppId.value = organizationsByAppId
    _appsByOrgId.value = appsByOrgId
    _appsByAppId.value = appsByAppId
    loadOrganizationAppIcons(Array.from(appsByAppId.values()), appIconLoadRun)
    _initialLoadPromise.value.resolve(true)
  })

  const getOrgByAppId = (appId: string) => {
    return _organizationsByAppId.value.get(appId)
  }

  const getAppByAppId = (appId: string) => {
    return _appsByAppId.value.get(appId)
  }

  const getAppsByOrgId = (orgId: string) => {
    return _appsByOrgId.value.get(orgId) ?? []
  }

  const awaitInitialLoad = () => {
    return _initialLoadPromise.value.promise
  }

  const getCurrentRoleForApp = (appId: string) => {
    if (_organizationsByAppId.value.size < 1)
      throw new Error('Organizations by app_id map is empty')

    const org = getOrgByAppId(appId)
    if (!org)
      throw new Error(`Cannot find app ${appId} in the app_id -> org map`)

    return org.role as OrganizationRole
  }

  const setCurrentOrganization = (id: string) => {
    currentOrganization.value = organizations.value.find(org => org.gid === id)
  }

  const setCurrentOrganizationToMain = () => {
    const organization = organizations.value.find(org => org.role === 'owner')
    if (!organization)
      throw new Error('User has no main organization')

    setCurrentOrganization(organization.gid)
  }
  const setCurrentOrganizationToFirst = () => {
    if (organizations.value.length === 0)
      return
    const organization = organizations.value[0]
    setCurrentOrganization(organization.gid)
  }

  const getMembers = async (onSignedImages?: SignedMemberImageCallback): Promise<ExtendedOrganizationMembers> => {
    const currentOrgId = currentOrganization.value?.gid
    if (!currentOrgId)
      return []

    const { data, error } = await supabase
      .rpc('get_org_members', {
        guild_id: currentOrgId,
      })

    if (error || data === null) {
      return []
    }

    const memberImageSources = data.map(item => ({
      key: getMemberImageKey(item),
      imageUrl: item.image_url,
    }))
    const mappedMembers = data.map((item, id) => ({
      id,
      ...item,
      image_url: getImmediateImageUrl(item.image_url) || '',
    }))

    if (onSignedImages) {
      loadSignedMemberImages(memberImageSources, onSignedImages).catch((error) => {
        console.warn('Cannot load signed member images', error)
      })
    }

    return mappedMembers
  }

  const fetchOrganizations = async () => {
    const main = useMainStore()

    const userId = main.user?.id ?? main.auth?.id
    if (!userId)
      return

    if (!_initialized.value) {
      const listener = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
        if (event === 'SIGNED_OUT') {
          listener.data.subscription.unsubscribe()
          clearWebsitePaidUserCookie()
          // Remove all from orgs
          _organizations.value = new Map()
          _organizationsByAppId.value = new Map()
          _appsByOrgId.value = new Map()
          _appsByAppId.value = new Map()
          _initialLoadPromise.value = createDeferredPromise<boolean>()
          currentOrganization.value = undefined
          currentRole.value = null
        }
      })
      _initialized.value = true
    }

    // We have RLS that ensure that we only select rows where we are member or owner
    // Using get_orgs_v7 which includes 2FA and password policy fields
    const { data, error } = await supabase
      .rpc('get_orgs_v7')

    if (error) {
      console.error('Cannot get orgs!', error)
      clearWebsitePaidUserCookie()
      throw error
    }

    const logoLoadRun = ++organizationLogoLoadRun
    const mappedData = data.map((item, id) => {
      const { normalized: logoStoragePath, shouldSign: shouldSignLogo } = resolveImagePath(item.logo)
      return {
        id,
        ...item,
        logo: getImmediateImageUrl(item.logo) || null,
        logo_storage_path: logoStoragePath || null,
        logo_is_loading: shouldSignLogo,
        password_policy_config: item.password_policy_config as PasswordPolicyConfig | null,
      } as Organization & { id: number }
    })

    syncWebsitePaidUserCookieFromOrganizations(mappedData)
    isPlatformAdmin()
      .then((isAdmin) => {
        main.isAdmin = isAdmin
        if (isAdmin)
          setWebsitePaidUserCookie(true)
      })
      .catch((error) => {
        console.error('Failed to resolve platform admin status:', error)
      })
    _organizations.value = new Map(mappedData.map(item => [item.gid, item as Organization]))
    loadOrganizationLogos(mappedData, logoLoadRun)

    const selectableOrganizations = mappedData
      .filter(org => isSelectableOrganization(org))
      .sort((a, b) => b.app_count - a.app_count)

    const organization = selectableOrganizations[0]
    if (!organization) {
      // Keep invitation-only organizations available so invite deep links
      // can still open the accept-invite dialog before the user joins.
      currentOrganization.value = undefined
      currentRole.value = null
      currentOrganizationFailed.value = false
      _organizationsByAppId.value = new Map()
      _appsByOrgId.value = new Map()
      _appsByAppId.value = new Map()
      _initialLoadPromise.value.resolve(true)
      return
    }

    let selectedOrganization = currentOrganization.value
      ? selectableOrganizations.find(org => org.gid === currentOrganization.value?.gid)
      : undefined
    if (!selectedOrganization) {
      const storedOrgId = localStorage.getItem(STORAGE_KEY)
      if (storedOrgId)
        selectedOrganization = selectableOrganizations.find(org => org.gid === storedOrgId)
    }
    currentOrganization.value = selectedOrganization ?? organization
    // Don't mark as failed if user lacks 2FA or password access - the data is redacted and unreliable
    const lacks2FAAccess = currentOrganization.value?.enforcing_2fa === true && currentOrganization.value?.['2fa_has_access'] === false
    const lacksPasswordAccess = currentOrganization.value?.password_policy_config?.enabled && currentOrganization.value?.password_has_access === false
    if (lacks2FAAccess || lacksPasswordAccess) {
      currentOrganizationFailed.value = false
    }
    else {
      currentOrganizationFailed.value = !(!!currentOrganization.value?.paying || (currentOrganization.value?.trial_left ?? 0) > 0 || !!currentOrganization.value?.can_use_more)
    }
  }

  const refreshOrganizationLogos = async () => {
    if (_organizations.value.size === 0)
      return

    const nextOrganizations = new Map(_organizations.value)
    let updated = false

    for (const [orgId, org] of nextOrganizations.entries()) {
      const logoSource = org.logo_storage_path ?? org.logo
      if (!logoSource)
        continue

      const logoStoragePath = resolveImagePath(logoSource).normalized
      const refreshedLogo = await createSignedImageUrl(logoStoragePath || org.logo, { forceRefresh: true })
      if (!refreshedLogo || refreshedLogo === org.logo)
        continue

      nextOrganizations.set(orgId, {
        ...org,
        logo: refreshedLogo,
        logo_storage_path: logoStoragePath || null,
        logo_is_loading: false,
      })
      updated = true
    }

    if (!updated)
      return

    _organizations.value = nextOrganizations
    if (currentOrganization.value) {
      const refreshedCurrentOrganization = nextOrganizations.get(currentOrganization.value.gid)
      if (refreshedCurrentOrganization) {
        currentOrganization.value.logo = refreshedCurrentOrganization.logo
        currentOrganization.value.logo_storage_path = refreshedCurrentOrganization.logo_storage_path
      }
    }
  }

  const dedupFetchOrganizations = async () => {
    if (_organizations.value.size === 0)
      await fetchOrganizations()
  }

  const getAllOrgs = () => {
    return _organizations.value
  }

  const hasPermissionsInRole = (
    minRight: OrgPermissionFloor,
    requiredRoles: string[] = [],
    orgId?: string,
    appId?: string,
  ) => {
    const orgFromApp = appId ? getOrgByAppId(appId) : undefined
    const org = orgId ? _organizations.value.get(orgId) : (orgFromApp ?? currentOrganization.value)
    const role = org?.role ?? currentRole.value
    if (!role)
      return false

    if (requiredRoles.length > 0) {
      if (requiredRoles.some(required => matchesRbacRole(role, required)))
        return true
    }

    return roleHasOrgRank(role, minRight === 'owner' ? 'org_super_admin' : minRight)
  }

  // Check password policy compliance for all org members in org admin previews.
  const checkPasswordPolicyImpact = async (orgId: string) => {
    const { data, error } = await supabase.rpc('check_org_members_password_policy', {
      org_id: orgId,
    })

    if (error) {
      console.error('Failed to check password policy impact:', error)
      return null
    }

    return {
      totalUsers: data.length,
      compliantUsers: data.filter(u => u.password_policy_compliant),
      nonCompliantUsers: data.filter(u => !u.password_policy_compliant),
    }
  }

  const canDeleteOrganization = (orgId?: string) => {
    return hasPermissionsInRole('org_super_admin', ['org_super_admin'], orgId)
  }

  const deleteOrganization = async (orgId: string) => {
    // Validate input
    if (!orgId || typeof orgId !== 'string' || orgId.trim() === '') {
      return { data: null, error: new Error('Invalid organization ID') }
    }

    // Check if current user has permission to delete this organization
    const currentUserId = main.user?.id
    if (!currentUserId) {
      return { data: null, error: new Error('User not authenticated') }
    }

    // Verify user has org_super_admin or owner role for this organization
    const currentOrg = _organizations.value.get(orgId)
    if (!currentOrg || !canDeleteOrganization(orgId)) {
      console.error('Permission denied:', { role: currentOrg?.role, required: ['owner', 'org_super_admin'] })
      return { data: null, error: new Error('Insufficient permissions') }
    }

    const { data, error } = await supabase.from('orgs')
      .delete()
      .eq('id', orgId)

    if (error) {
      console.error('Organization deletion failed:', error.message)
      return { data, error }
    }

    return { data, error: null }
  }

  return {
    organizations,
    currentOrganization,
    currentOrganizationFailed,
    currentRole,
    setCurrentOrganization,
    setCurrentOrganizationToMain,
    setCurrentOrganizationToFirst,
    getMembers,
    getCurrentRoleForApp,
    getAllOrgs,
    hasPermissionsInRole,
    fetchOrganizations,
    refreshOrganizationLogos,
    dedupFetchOrganizations,
    getOrgByAppId,
    getAppByAppId,
    getAppsByOrgId,
    awaitInitialLoad,
    deleteOrganization,
    canDeleteOrganization,
    checkPasswordPolicyImpact,
    hasOrganizations,
  }
})
