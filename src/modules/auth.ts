import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import type { ConsoleClient } from '~/services/consoleClient'
import type { UserModule } from '~/types'
import { ADMIN_DASHBOARD_URL } from '~/constants/adminDashboard'
import { clearChartDataCache } from '~/services/chartDataService'
import { isAgentClaimPath, isCliLoginPath, isMcpAuthorizePath } from '~/services/cliLogin'
import { getLocalConfig, useConsole } from '~/services/console'
import { hideLoader } from '~/services/loader'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { setUser } from '~/services/posthog'
import { applySignupAttributionToPostHog } from '~/services/signupAttribution'
import { isSsoUser, provisionSsoUser } from '~/services/ssoProvisioning'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { sendEvent } from '~/services/tracking'
import { clearWebsitePaidUserCookie } from '~/services/websiteAuthCookie'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { shouldSkipOnboardingResume } from '~/utils/appOnboardingProgress'
import { needsInitialOnboardingName } from '~/utils/onboardingProfile'
import { canExploreOnboardingDashboard, getOnboardingResumeRedirect, isNewOnboardingUser } from '~/utils/onboardingRedirect'
import { AI_ONBOARDING_PATH, shouldRedirectToAiOnboarding } from '~/utils/onboardingSetupMode'
import { hasPendingInviteSkip } from '~/utils/pendingInviteSkip'
import { validateRedirectPath } from '~/utils/safeRedirect'
import { getPlans } from './../services/console'

async function updateUser(
  main: ReturnType<typeof useMainStore>,
  capgo: ConsoleClient,
) {
  const config = getLocalConfig()
  // console.log('set auth', auth)
  try {
    const { data, error } = await capgo
      .from('users')
      .select()
      .eq('id', main.auth?.id ?? '')
      .maybeSingle()

    let userRecord = data ?? null

    if (error && error.code !== 'PGRST116') {
      console.error('Failed to fetch public user profile', error)
      return
    }

    if (!userRecord && main.auth) {
      const { data: inserted, error: insertError } = await capgo
        .from('users')
        .insert({
          id: main.auth.id,
          email: main.auth.email ?? '',
          first_name: main.auth.user_metadata?.first_name ?? '',
          last_name: main.auth.user_metadata?.last_name ?? '',
          country: null,
          enable_notifications: true,
          opt_for_newsletters: false,
        })
        .select()
        .single()

      if (insertError) {
        console.error('Failed to create public user profile', insertError)
      }
      else {
        userRecord = inserted
      }
    }

    if (!userRecord)
      return

    if (main.auth?.email && userRecord.email !== main.auth?.email) {
      const { error: updateError } = await capgo
        .from('users')
        .update({ email: main.auth?.email })
        .eq('id', main.auth?.id ?? '')
      if (updateError)
        console.error('update error', updateError)
      userRecord.email = main.auth?.email
    }

    const rawImageUrl = userRecord.image_url
    const immediateImageUrl = getImmediateImageUrl(rawImageUrl)
    if (rawImageUrl)
      userRecord.image_url = immediateImageUrl || null

    const updatePosthogUser = (avatar?: string | null) => {
      const authUser = main.auth
      setUser(
        authUser?.id ?? '',
        {
          email: userRecord.email,
          nickname: [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || undefined,
          avatar: avatar ?? undefined,
        },
        config.apiHost,
      )
      applySignupAttributionToPostHog(authUser, config.apiHost)
    }

    main.user = userRecord
    updatePosthogUser(userRecord.image_url)

    if (rawImageUrl && !immediateImageUrl) {
      void (async () => {
        try {
          const signedImageUrl = await createSignedImageUrl(rawImageUrl)
          const currentUser = main.user
          if (!signedImageUrl || !currentUser || currentUser.id !== userRecord.id)
            return

          currentUser.image_url = signedImageUrl
          main.user = currentUser
          updatePosthogUser(signedImageUrl)
        }
        catch (error) {
          console.warn('Cannot load signed user image', { userId: userRecord.id, error })
        }
      })()
    }
  }
  catch (error) {
    console.error('auth', error)
  }
}

async function maybeProvisionSsoMembership(
  capgo: ConsoleClient,
  session: Awaited<ReturnType<ConsoleClient['auth']['getSession']>>['data']['session'] | null,
): Promise<'continue' | 'redirect_login' | 'abort_navigation'> {
  if (!session || !isSsoUser(session.user))
    return 'continue'

  const result = await provisionSsoUser(session)

  if (result.merged) {
    const { error: signOutError } = await capgo.auth.signOut()
    if (signOutError) {
      console.error('Failed to sign out merged SSO session during auth guard:', signOutError)
      return 'abort_navigation'
    }

    return 'redirect_login'
  }

  if (result.error) {
    console.error('Failed to provision SSO membership during auth guard:', result.error)
    return 'abort_navigation'
  }

  return 'continue'
}

async function isDisabledAccount(capgo: ConsoleClient, userId: string | null | undefined) {
  if (!userId)
    return false

  try {
    const { data: isDisabled, error } = await capgo
      .rpc('is_account_disabled', { user_id: userId })

    if (error) {
      console.error('Error checking account status:', error)
      return false
    }

    return !!isDisabled
  }
  catch (error) {
    console.error('Error checking if account is disabled:', error)
    return false
  }
}

function getAccountDisabledRedirect(to: RouteLocationNormalized) {
  return {
    path: '/accountDisabled',
    query: to.fullPath && to.path !== '/accountDisabled'
      ? { to: to.fullPath }
      : {},
  }
}

function getPostRestorePath(to: RouteLocationNormalized) {
  const target = typeof to.query.to === 'string' ? to.query.to : ''
  return validateRedirectPath(target, '/dashboard', { blockedPrefixes: ['/accountDisabled'] })
}

async function guard(
  next: NavigationGuardNext,
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
) {
  const capgo = useConsole()
  const main = useMainStore()
  const organizationStore = useOrganizationStore()
  const { data: claimsData } = await capgo.auth.getClaims()
  const { data: sessionData } = await capgo.auth.getSession()
  const sessionUser = sessionData?.session?.user ?? null
  const hasAuth = !!claimsData?.claims?.sub && !!sessionUser
  const hadAuth = !!main.auth
  const inviteOrgId = typeof to.query.invite_org === 'string' && to.query.invite_org.length > 0
    ? to.query.invite_org
    : null
  const isCliLoginRoute = isCliLoginPath(to.path) || isMcpAuthorizePath(to.path) || isAgentClaimPath(to.path)
  const organizationFetchOptions = { loadImages: !isCliLoginRoute }

  async function tryLoadOrganizations(fetcher: () => Promise<void>) {
    try {
      await fetcher()
      return true
    }
    catch (error) {
      console.error('Failed to load organizations during auth guard:', error)
      return false
    }
  }

  async function loadPlansIfNeeded() {
    if (main.plans.length > 0)
      return

    main.plans = await getPlans()
  }

  async function resolvePlatformAdminStatus() {
    try {
      await main.resolvePlatformAdminStatus()
    }
    catch (error) {
      console.error('Failed to resolve platform admin status:', error)
      main.isAdmin = false
    }
  }

  function requiredNameRedirect(organizationsLoaded: boolean) {
    // CLI and MCP authorization must finish before any onboarding detour.
    if (isCliLoginRoute)
      return null
    // An unknown profile cannot establish whether names are required. Offer a
    // retry without letting the user bypass required names or stranding navigation.
    if (!main.user)
      return { path: '/login', query: { profile_unavailable: '1', to: to.fullPath } }
    // Scope is unknown after an org fetch failure. Never force an established
    // member into initial onboarding; the onboarding wizard re-checks names.
    if (!organizationsLoaded || !needsInitialOnboardingName(main.user))
      return null
    if (to.path === '/onboarding/name' || organizationStore.hasOrganizations)
      return null
    return { path: '/onboarding/name', query: { to: to.fullPath } }
  }

  function shouldRedirectToOrgOnboarding() {
    if (isCliLoginRoute)
      return false
    if (to.path === '/onboarding/name')
      return false
    if (to.path.startsWith('/onboarding/app'))
      return false
    if (to.path.startsWith('/onboarding/organization'))
      return false
    if (to.path.startsWith('/onboarding/invitation'))
      return false
    if (!inviteOrgId)
      return true
    return !organizationStore.organizations.some(org => org.gid === inviteOrgId && isPendingOrganizationInvite(org))
  }

  function shouldRedirectToPendingInviteOnboarding(organizationsLoaded: boolean) {
    if (isCliLoginRoute)
      return false
    if (!organizationsLoaded)
      return false
    if (isNativeAppStoreContext())
      return false
    if (to.path === '/onboarding/name' || to.path.startsWith('/onboarding/invitation'))
      return false
    if (hasPendingInviteSkip(sessionUser?.id ?? main.auth?.id))
      return false
    return organizationStore.organizations.some(org => isPendingOrganizationInvite(org))
  }

  async function getPendingOnboardingRedirect(organizationsLoaded: boolean) {
    if (to.path === '/onboarding/name')
      return null
    if (isCliLoginRoute)
      return null
    // Creating another organization must not bounce back to pending setup.
    if (to.path === '/onboarding/app' && to.query.new_org === '1')
      return null
    if (!organizationsLoaded)
      return null
    if (!isNewOnboardingUser(sessionUser?.created_at))
      return null

    const selectableOrganizations = organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org))
    if (selectableOrganizations.length !== 1)
      return null

    const { data: apps, error } = await capgo
      .from('apps')
      .select('app_id, need_onboarding, onboarding')
      .eq('owner_org', selectableOrganizations[0].gid)
      .limit(2)

    if (error) {
      console.error('Cannot resolve onboarding redirect', error)
      return null
    }

    if (shouldRedirectToAiOnboarding({
      onboarding: main.user?.onboarding,
      appCount: apps?.length ?? 0,
      organizationCount: selectableOrganizations.length,
      path: to.path,
      canExploreDashboard: canExploreOnboardingDashboard(sessionUser?.id),
    })) {
      return { path: AI_ONBOARDING_PATH }
    }

    const app = apps?.[0]
    if (app && shouldSkipOnboardingResume(app.onboarding))
      return null
    return getOnboardingResumeRedirect({
      appId: app?.need_onboarding ? app.app_id : null,
      appCount: apps?.length ?? 0,
      createdAt: sessionUser?.created_at,
      organizationCount: selectableOrganizations.length,
      path: to.path,
      userId: sessionUser?.id,
    })
  }

  if (hasAuth && sessionUser) {
    const authConfirmedAt = main.auth?.email_confirmed_at
    if (!main.auth || main.auth.id !== sessionUser.id || authConfirmedAt !== sessionUser.email_confirmed_at) {
      main.auth = sessionUser
    }
    applySignupAttributionToPostHog(sessionUser, getLocalConfig().apiHost)
  }

  const { data: mfaData, error: mfaError }
    = await capgo.auth.mfa.getAuthenticatorAssuranceLevel()
  if (mfaError) {
    console.error('Cannot guard auth', mfaError)
    return next({
      path: '/login',
      query: {
        to: to.fullPath,
      },
    })
  }

  if (mfaData.currentLevel === 'aal1' && mfaData.nextLevel === 'aal2') {
    // Only the backend may waive MFA: verify_mfa passes an aal1 session solely
    // when platform-admin log_as registered its session_id as an impersonation.
    const { data: hasMfaAssurance, error: verifyMfaError } = await capgo.rpc('verify_mfa')
    if (verifyMfaError)
      console.error('Cannot verify MFA assurance', verifyMfaError)
    if (verifyMfaError || hasMfaAssurance !== true) {
      return next({
        path: '/login',
        query: {
          to: to.fullPath,
        },
      })
    }
  }

  if (hasAuth && sessionUser && !hadAuth) {
    const isDisabled = await isDisabledAccount(capgo, sessionUser.id)
    if (to.path === '/accountDisabled') {
      hideLoader()
      return isDisabled ? next() : next(getPostRestorePath(to))
    }
    if (isDisabled) {
      hideLoader()
      return next(getAccountDisabledRedirect(to))
    }

    const provisioningResult = await maybeProvisionSsoMembership(capgo, sessionData?.session ?? null)
    if (provisioningResult === 'redirect_login') {
      return next('/login?message=sso_account_linked')
    }
    if (provisioningResult === 'abort_navigation') {
      await hideLoader()
      next(false)
      return
    }

    if (!main.user) {
      await updateUser(main, capgo)
    }

    sendEvent({
      channel: 'user-login',
      event: 'User Login',
      user_id: main.auth?.id,
    }).catch()

    await loadPlansIfNeeded()

    const organizationsLoaded = await tryLoadOrganizations(() => organizationStore.fetchOrganizations(organizationFetchOptions))
    const nameRedirect = requiredNameRedirect(organizationsLoaded)
    if (nameRedirect) {
      await hideLoader()
      return next(nameRedirect)
    }
    if (shouldRedirectToPendingInviteOnboarding(organizationsLoaded)) {
      return next({
        path: '/onboarding/invitation',
        query: {
          to: to.path.startsWith('/onboarding/') ? '/dashboard' : to.fullPath,
        },
      })
    }

    await resolvePlatformAdminStatus()

    if (organizationsLoaded && !organizationStore.hasOrganizations && !main.isAdmin && shouldRedirectToOrgOnboarding()) {
      return next({
        path: '/onboarding/app',
        query: {
          to: to.fullPath,
        },
      })
    }

    const onboardingRedirect = await getPendingOnboardingRedirect(organizationsLoaded)
    if (onboardingRedirect)
      return next(onboardingRedirect)

    next()
    hideLoader()
  }
  else if (from.path !== 'login' && !hasAuth) {
    main.auth = undefined
    next({
      path: '/login',
      query: {
        to: to.fullPath,
      },
    })
  }
  else if (hasAuth && main.auth) {
    const isDisabled = await isDisabledAccount(capgo, sessionUser?.id ?? main.auth.id)
    if (isDisabled && to.path !== '/accountDisabled') {
      hideLoader()
      return next(getAccountDisabledRedirect(to))
    }
    if (!isDisabled && to.path === '/accountDisabled') {
      hideLoader()
      return next(getPostRestorePath(to))
    }

    if (!main.user)
      await updateUser(main, capgo)
    await loadPlansIfNeeded()

    let organizationsLoaded = await tryLoadOrganizations(() => organizationStore.dedupFetchOrganizations(organizationFetchOptions))
    if (shouldRedirectToPendingInviteOnboarding(organizationsLoaded)) {
      return next({
        path: '/onboarding/invitation',
        query: {
          to: to.path.startsWith('/onboarding/') ? '/dashboard' : to.fullPath,
        },
      })
    }

    if (organizationsLoaded && !organizationStore.hasOrganizations && isSsoUser(sessionUser)) {
      const didProvisionSsoMembership = await maybeProvisionSsoMembership(capgo, sessionData?.session ?? null)
      if (didProvisionSsoMembership === 'redirect_login') {
        return next('/login?message=sso_account_linked')
      }
      if (didProvisionSsoMembership === 'abort_navigation') {
        hideLoader()
        return next(false)
      }

      organizationsLoaded = await tryLoadOrganizations(() => organizationStore.fetchOrganizations(organizationFetchOptions))
    }

    // Check names after SSO provisioning so enterprise members are not sent to self-signup onboarding.
    const nameRedirect = requiredNameRedirect(organizationsLoaded)
    if (nameRedirect) {
      await hideLoader()
      return next(nameRedirect)
    }

    await resolvePlatformAdminStatus()

    if (organizationsLoaded && !organizationStore.hasOrganizations && !main.isAdmin && shouldRedirectToOrgOnboarding()) {
      return next({
        path: '/onboarding/app',
        query: {
          to: to.fullPath,
        },
      })
    }

    const onboardingRedirect = await getPendingOnboardingRedirect(organizationsLoaded)
    if (onboardingRedirect)
      return next(onboardingRedirect)

    await hideLoader()
    void next()
  }
  else {
    await hideLoader()
    void next()
  }
}

export const install: UserModule = ({ router }) => {
  const capgo = useConsole()
  capgo.auth.getSession()
    .then(({ data }) => {
      if (!data.session)
        clearWebsitePaidUserCookie()
    })
    .catch(error => console.error('Failed to clear website paid user cookie', error))

  if (typeof capgo.auth.onAuthStateChange === 'function') {
    capgo.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        clearWebsitePaidUserCookie()
        clearChartDataCache()
      }
    })
  }

  router.beforeEach(async (to, from, next) => {
    // The admin dashboard moved to its own app; send old bookmarks there.
    if (to.path === '/admin' || to.path.startsWith('/admin/')) {
      window.location.replace(ADMIN_DASHBOARD_URL)
      return next(false)
    }
    if (to.meta.middleware) {
      await guard(next, to, from)
    }
    else {
      hideLoader()
      next()
    }
  })
}
