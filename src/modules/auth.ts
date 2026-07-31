import type { SupabaseClient } from '@supabase/supabase-js'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import type { UserModule } from '~/types'
import { hideLoader } from '~/services/loader'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { setUser } from '~/services/posthog'
import { isSsoUser, provisionSsoUser } from '~/services/ssoProvisioning'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { getLocalConfig, useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { clearWebsitePaidUserCookie, setWebsitePaidUserCookie } from '~/services/websiteAuthCookie'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { hasPendingInviteSkip } from '~/utils/pendingInviteSkip'
import { getPlans, isPlatformAdmin } from './../services/supabase'

async function updateUser(
  main: ReturnType<typeof useMainStore>,
  supabase: SupabaseClient,
) {
  const config = getLocalConfig()
  // console.log('set auth', auth)
  try {
    const { data, error } = await supabase
      .from('users')
      .select()
      .eq('id', main.auth?.id)
      .maybeSingle()

    let userRecord = data ?? null

    if (error && error.code !== 'PGRST116')
      console.error('Failed to fetch public user profile', error)

    if (!userRecord && main.auth) {
      const { data: inserted, error: insertError } = await supabase
        .from('users')
        .insert({
          id: main.auth.id,
          email: main.auth.email ?? '',
          first_name: main.auth.user_metadata?.first_name ?? '',
          last_name: main.auth.user_metadata?.last_name ?? '',
          country: null,
          enable_notifications: true,
          opt_for_newsletters: true,
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
      const { error: updateError } = await supabase
        .from('users')
        .update({ email: main.auth?.email })
        .eq('id', main.auth?.id)
      if (updateError)
        console.error('update error', updateError)
      userRecord.email = main.auth?.email
    }

    const rawImageUrl = userRecord.image_url
    const immediateImageUrl = getImmediateImageUrl(rawImageUrl)
    if (rawImageUrl)
      userRecord.image_url = immediateImageUrl || null

    const updatePosthogUser = (avatar?: string | null) => {
      setUser(
        main.auth?.id ?? '',
        {
          email: userRecord.email,
          nickname: [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || undefined,
          avatar: avatar ?? undefined,
        },
        config.supaHost,
      )
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
  supabase: SupabaseClient,
  session: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>['data']['session'] | null,
): Promise<'continue' | 'redirect_login' | 'abort_navigation'> {
  if (!session || !isSsoUser(session.user))
    return 'continue'

  const result = await provisionSsoUser(session)

  if (result.merged) {
    const { error: signOutError } = await supabase.auth.signOut()
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

async function isDisabledAccount(supabase: SupabaseClient, userId: string | null | undefined) {
  if (!userId)
    return false

  try {
    const { data: isDisabled, error } = await supabase
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
  if (target.startsWith('/') && target !== '/accountDisabled')
    return target
  return '/dashboard'
}

async function guard(
  next: NavigationGuardNext,
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
) {
  const supabase = useSupabase()
  const main = useMainStore()
  const organizationStore = useOrganizationStore()
  const { data: claimsData } = await supabase.auth.getClaims()
  const { data: sessionData } = await supabase.auth.getSession()
  const sessionUser = sessionData?.session?.user ?? null
  const hasAuth = !!claimsData?.claims?.sub && !!sessionUser
  const hadAuth = !!main.auth
  const inviteOrgId = typeof to.query.invite_org === 'string' && to.query.invite_org.length > 0
    ? to.query.invite_org
    : null
  const isAdminRoute = to.path.startsWith('/admin')

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

  function shouldRedirectToOrgOnboarding() {
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
    if (!organizationsLoaded)
      return false
    if (isNativeAppStoreContext())
      return false
    if (to.path.startsWith('/onboarding/invitation'))
      return false
    if (hasPendingInviteSkip(sessionUser?.id ?? main.auth?.id))
      return false
    return organizationStore.organizations.some(org => isPendingOrganizationInvite(org))
  }

  if (hasAuth && sessionUser) {
    const authConfirmedAt = main.auth?.email_confirmed_at
    if (!main.auth || main.auth.id !== sessionUser.id || authConfirmedAt !== sessionUser.email_confirmed_at) {
      main.auth = sessionUser
    }
  }

  // TOTP means the user was force logged using the "email" tactic
  // In practice this means the user is being spoofed by an admin
  const isAdminForced
    = !!sessionUser?.factors?.find(f => f.factor_type === 'totp') || false

  const { data: mfaData, error: mfaError }
    = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (mfaError) {
    console.error('Cannot guard auth', mfaError)
    return
  }

  if (
    mfaData.currentLevel === 'aal1'
    && mfaData.nextLevel === 'aal2'
    && !isAdminForced
  ) {
    return next({
      path: '/login',
      query: {
        to: to.fullPath,
      },
    })
  }

  if (hasAuth && sessionUser && !hadAuth) {
    const isDisabled = await isDisabledAccount(supabase, sessionUser.id)
    if (to.path === '/accountDisabled') {
      hideLoader()
      return isDisabled ? next() : next(getPostRestorePath(to))
    }
    if (isDisabled) {
      hideLoader()
      return next(getAccountDisabledRedirect(to))
    }

    const provisioningResult = await maybeProvisionSsoMembership(supabase, sessionData?.session ?? null)
    if (provisioningResult === 'redirect_login') {
      return next('/login?message=sso_account_linked')
    }
    if (provisioningResult === 'abort_navigation') {
      hideLoader()
      return next(false)
    }

    if (!main.user) {
      await updateUser(main, supabase)
    }

    const organizationsLoaded = await tryLoadOrganizations(() => organizationStore.fetchOrganizations())
    if (shouldRedirectToPendingInviteOnboarding(organizationsLoaded)) {
      return next({
        path: '/onboarding/invitation',
        query: {
          to: to.path.startsWith('/onboarding/') ? '/dashboard' : to.fullPath,
        },
      })
    }

    if (organizationsLoaded && isAdminRoute) {
      try {
        main.isAdmin = await isPlatformAdmin()
        if (main.isAdmin)
          setWebsitePaidUserCookie(true)
      }
      catch (error) {
        console.error('Failed to resolve platform admin status:', error)
        main.isAdmin = false
      }
    }

    if (organizationsLoaded && !organizationStore.hasOrganizations && shouldRedirectToOrgOnboarding()) {
      if (!isAdminRoute || !main.isAdmin) {
        return next({
          path: '/onboarding/app',
          query: {
            to: to.fullPath,
          },
        })
      }
    }

    getPlans().then((pls) => {
      main.plans = pls
    })

    try {
      // isPlatformAdmin() is the only frontend admin-rights source.
      main.isAdmin = await isPlatformAdmin()
      if (main.isAdmin)
        setWebsitePaidUserCookie(true)
    }
    catch (error) {
      console.error('Failed to resolve platform admin status:', error)
      main.isAdmin = false
    }

    sendEvent({
      channel: 'user-login',
      event: 'User Login',
      icon: '✅',
      user_id: main.auth?.id,
      notify: false,
    }).catch()

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
    const isDisabled = await isDisabledAccount(supabase, sessionUser?.id ?? main.auth.id)
    if (isDisabled && to.path !== '/accountDisabled') {
      hideLoader()
      return next(getAccountDisabledRedirect(to))
    }
    if (!isDisabled && to.path === '/accountDisabled') {
      hideLoader()
      return next(getPostRestorePath(to))
    }

    let organizationsLoaded = await tryLoadOrganizations(() => organizationStore.dedupFetchOrganizations())
    if (shouldRedirectToPendingInviteOnboarding(organizationsLoaded)) {
      return next({
        path: '/onboarding/invitation',
        query: {
          to: to.path.startsWith('/onboarding/') ? '/dashboard' : to.fullPath,
        },
      })
    }

    if (organizationsLoaded && !organizationStore.hasOrganizations && isSsoUser(sessionUser)) {
      const didProvisionSsoMembership = await maybeProvisionSsoMembership(supabase, sessionData?.session ?? null)
      if (didProvisionSsoMembership === 'redirect_login') {
        return next('/login?message=sso_account_linked')
      }
      if (didProvisionSsoMembership === 'abort_navigation') {
        hideLoader()
        return next(false)
      }

      organizationsLoaded = await tryLoadOrganizations(() => organizationStore.fetchOrganizations())
    }

    if (organizationsLoaded && !organizationStore.hasOrganizations && shouldRedirectToOrgOnboarding()) {
      return next({
        path: '/onboarding/app',
        query: {
          to: to.fullPath,
        },
      })
    }

    // Check if user is trying to access admin routes
    if (isAdminRoute) {
      try {
        // Re-check via the single approved frontend path for admin-rights.
        main.isAdmin = await isPlatformAdmin()
        if (main.isAdmin)
          setWebsitePaidUserCookie(true)
      }
      catch (error) {
        console.error('Failed to resolve platform admin status:', error)
        main.isAdmin = false
      }

      // Redirect non-admin users to dashboard
      if (!main.isAdmin) {
        console.warn('Non-admin user attempted to access admin route:', to.path)
        return next('/dashboard')
      }
    }

    hideLoader()
    next()
  }
  else {
    hideLoader()
    next()
  }
}

export const install: UserModule = ({ router }) => {
  const supabase = useSupabase()
  supabase.auth.getSession()
    .then(({ data }) => {
      if (!data.session)
        clearWebsitePaidUserCookie()
    })
    .catch(error => console.error('Failed to clear website paid user cookie', error))

  if (typeof supabase.auth.onAuthStateChange === 'function') {
    supabase.auth.onAuthStateChange((_event, session) => {
      if (!session)
        clearWebsitePaidUserCookie()
    })
  }

  router.beforeEach(async (to, from, next) => {
    if (to.meta.middleware) {
      await guard(next, to, from)
    }
    else {
      hideLoader()
      next()
    }
  })
}
