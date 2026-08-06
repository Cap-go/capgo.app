import type { Database } from '~/types/supabase.types'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSupabase } from '~/services/supabase'

export interface BreadcrumbItem {
  path: string
  name: string
  translate?: boolean
}

export const useDisplayStore = defineStore('display', () => {
  const NavTitle = ref<string>('')
  const pathTitle = ref<BreadcrumbItem[]>([])
  const lastPath = ref<string>('')
  const defaultBack = ref<string>('')
  const messageToast = ref<string[]>([])
  const durationToast = ref<number>(2000)
  const lastButtonRole = ref<string>('')
  const selectedOrganizations = ref<string[]>([])
  const selectedApps = ref<Database['public']['Tables']['apps']['Row'][]>([])
  const appNameResolver = ref<(appId: string) => string | undefined>(() => undefined)
  const channelNameCache = ref(new Map<string, string>())
  const bundleNameCache = ref(new Map<string, string>())
  const deviceNameCache = ref(new Map<string, string>())
  const resolverReady = ref(false)
  const appNameCache = ref(new Map<string, string | null>())
  const pendingFetches = new Map<string, Promise<void>>()
  // Track which org the caches belong to
  const currentCacheOrgId = ref<string | null>(null)

  function setAppNameResolver(resolver: (appId: string) => string | undefined) {
    appNameResolver.value = resolver
    resolverReady.value = true
  }

  // Clear all entity name caches when org changes
  function clearCachesForOrg(newOrgId: string | null) {
    if (currentCacheOrgId.value !== newOrgId) {
      channelNameCache.value.clear()
      bundleNameCache.value.clear()
      deviceNameCache.value.clear()
      appNameCache.value.clear()
      pendingFetches.clear()
      currentCacheOrgId.value = newOrgId
    }
  }

  function setChannelName(id: string, name: string) {
    channelNameCache.value.set(id, name)
    if (lastPath.value)
      updatePathTitle(lastPath.value)
  }

  function setBundleName(id: string, name: string) {
    bundleNameCache.value.set(id, name)
    if (lastPath.value)
      updatePathTitle(lastPath.value)
  }

  function setDeviceName(id: string, name: string) {
    deviceNameCache.value.set(id, name)
    if (lastPath.value)
      updatePathTitle(lastPath.value)
  }

  function getPrettyName(segment: string, index: number, allSegments: string[]): string {
    const previousSegment = allSegments[index - 1]

    // If this segment comes after 'p', it's an appId - return as is
    if (previousSegment === 'p')
      return segment

    switch (segment) {
      case 'dashboard':
        return 'Dashboard'
      case 'app':
        return 'apps'
      case 'settings':
        return 'settings'
      case 'organization':
        return 'organization'
      case 'onboarding':
        return 'onboarding'
      case 'channel':
        return 'channels'
      case 'bundle':
        return 'bundles'
      case 'device':
        return 'devices'
      case 'd':
        return 'devices'
      case 'changepassword':
        return 'password'
      case 'account':
        return 'account'
      case 'notifications':
        return 'notifications'
      default:
        return segment.charAt(0).toUpperCase() + segment.slice(1)
    }
  }

  function isValidClickableSegment(segment: string, index: number, totalLength: number, allSegments: string[]): boolean {
    // Don't make the last segment clickable (usually an ID or final page)
    if (index === totalLength - 1)
      return false

    // Skip 'app', 'p', and 'settings' segments - they're not clickable
    if (segment === 'p' || segment === 'settings')
      return false

    const previousSegment = allSegments.length ? allSegments[index - 1] : undefined
    const previousTwoSegments = allSegments.length > 1 ? allSegments[index - 2] : undefined

    // Include 'app' only if followed by 'p' and an appId
    if (segment === 'app' && previousSegment !== 'p')
      return true

    // Include appId (segment after 'p') only if there are more segments after it
    if (previousSegment === 'p' && previousTwoSegments === 'app' && index < totalLength - 1)
      return true

    // Include organization when it's under settings and has sub-paths
    if (segment === 'organization' && previousSegment === 'settings' && index < totalLength - 1)
      return true

    // Skip other route segments that shouldn't be clickable
    const nonClickableSegments = ['channel', 'bundle', 'device', 'onboarding']
    if (nonClickableSegments.includes(segment))
      return false

    return false
  }

  function updatePathTitle(path: string) {
    lastPath.value = path
    const splitPath = path.split('/').filter(Boolean)

    const breadcrumbs: BreadcrumbItem[] = []

    // App flow: Apps / <AppName> / <Section>
    if (splitPath[0] === 'app' && splitPath[1]) {
      const appId = splitPath[1]
      breadcrumbs.push({ path: '/apps', name: 'apps' })

      // App name entry
      const hasCachedName = appNameCache.value.has(appId)
      const cachedName = appNameCache.value.get(appId)
      const resolvedName = appNameResolver.value(appId)
        ?? cachedName
        ?? appId
      breadcrumbs.push({
        path: `/app/${appId}`,
        name: resolvedName,
        translate: false,
      })

      // Kick off fetch if we still don't have a name
      if (appId !== 'new' && !hasCachedName && !appNameResolver.value(appId) && !pendingFetches.has(appId)) {
        const supabase = useSupabase()
        const fetchPromise = (async () => {
          try {
            const { data, error } = await supabase
              .from('apps')
              .select('name')
              .eq('app_id', appId)
              .maybeSingle()

            if (!error) {
              appNameCache.value.set(appId, data?.name ?? null)
              if (data?.name && lastPath.value)
                updatePathTitle(lastPath.value)
            }
          }
          catch {
            // Ignore lookup failures; a later route update may retry.
          }
          finally {
            pendingFetches.delete(appId)
          }
        })()
        pendingFetches.set(appId, fetchPromise)
      }

      // Additional segments after the app id (e.g., bundle, channel)
      for (let i = 2; i < splitPath.length; i++) {
        const segment = splitPath[i]
        const prev = splitPath[i - 1]

        // Handle plural tab names (bundles, channels, devices, etc.)
        // Include them in breadcrumb if they're the last segment (final destination)
        // Skip them if there are more segments after (intermediate path)
        if (['bundles', 'channels', 'devices', 'logs', 'builds', 'info'].includes(segment)) {
          const isLastSegment = i === splitPath.length - 1
          if (isLastSegment) {
            breadcrumbs.push({
              path: `/app/${appId}/${segment}`,
              name: segment,
            })
          }
          continue
        }

        // Handle resource type segments (bundle, channel, device)
        // These should link to the tab view in the main app page
        if (['bundle', 'channel', 'device'].includes(segment)) {
          const tabName = `${segment}s`
          breadcrumbs.push({
            path: `/app/${appId}/${tabName}`,
            name: tabName,
          })
          continue
        }

        // Handle ids following resource segments
        if (/^\d+$/.test(segment) && ['bundle', 'channel', 'build'].includes(prev)) {
          const pathUpToHere = `/${splitPath.slice(0, i + 1).join('/')}`
          const cached = prev === 'channel'
            ? channelNameCache.value.get(segment)
            : prev === 'bundle'
              ? bundleNameCache.value.get(segment)
              : undefined
          breadcrumbs.push({
            path: pathUpToHere,
            name: cached ?? segment,
            translate: false,
          })
          continue
        }

        // Device ids (uuid-ish) following `/device/`
        if (prev === 'device') {
          const pathUpToHere = `/${splitPath.slice(0, i + 1).join('/')}`
          const cached = deviceNameCache.value.get(segment)
          breadcrumbs.push({
            path: pathUpToHere,
            name: cached ?? segment,
            translate: false,
          })
          continue
        }

        const pathUpToHere = `/${splitPath.slice(0, i + 1).join('/')}`
        const prettyName = getPrettyName(segment, i, splitPath)

        breadcrumbs.push({
          path: pathUpToHere,
          name: prettyName,
        })
      }

      pathTitle.value = breadcrumbs
      return
    }

    // Dashboard: rely on NavTitle (keep breadcrumb empty for consistent sizing)
    if (splitPath[0] === 'dashboard') {
      pathTitle.value = []
      return
    }

    // Handle special case for account-related settings
    if (splitPath.length === 2 && splitPath[0] === 'settings' && (splitPath[1] === 'changepassword' || splitPath[1] === 'notifications')) {
      pathTitle.value = [{
        path: '/settings/account',
        name: 'account',
      }]
      return
    }

    // Generic fallback
    for (let i = 0; i < splitPath.length; i++) {
      const segment = splitPath[i]
      const isValid = isValidClickableSegment(segment, i, splitPath.length, splitPath)
      if (!isValid)
        continue

      const pathUpToHere = `/${splitPath.slice(0, i + 1).join('/')}`
      let prettyName = getPrettyName(segment, i, splitPath)
      let translate = true

      if (splitPath[i - 1] === 'p') {
        translate = false
        prettyName = appNameResolver.value(segment) ?? segment
      }

      breadcrumbs.push({
        path: pathUpToHere,
        name: prettyName,
        translate,
      })
    }

    pathTitle.value = path === '/' ? [] : breadcrumbs
  }

  watch(NavTitle, () => {
    if (lastPath.value)
      updatePathTitle(lastPath.value)
  })

  watch(resolverReady, (ready) => {
    if (ready && lastPath.value)
      updatePathTitle(lastPath.value)
  })

  return {
    messageToast,
    durationToast,
    lastButtonRole,
    NavTitle,
    pathTitle,
    defaultBack,
    selectedApps,
    selectedOrganizations,
    setAppNameResolver,
    setChannelName,
    setBundleName,
    setDeviceName,
    updatePathTitle,
    lastPath,
    clearCachesForOrg,
  }
})

if (import.meta.hot)
  import.meta.hot.accept(acceptHMRUpdate(useDisplayStore, import.meta.hot))
