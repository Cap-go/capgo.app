import type { UserModule } from '~/types'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { getAppSetupRedirect } from '~/utils/onboardingRedirect'

export const install: UserModule = ({ router }) => {
  // Resolve after auth/SSO guards and before the dashboard layout mounts.
  router.beforeResolve(async (to) => {
    if (to.name !== '/app/[app].getting-started' || typeof to.params.app !== 'string')
      return
    if (!useMainStore().auth)
      return

    const { data, error } = await useSupabase()
      .from('apps')
      .select('app_id, onboarding')
      .eq('app_id', to.params.app)
      .maybeSingle()

    if (error) {
      console.error('Cannot resolve Getting started setup route', error)
      return
    }
    if (!data)
      return
    const redirect = getAppSetupRedirect(data)
    if (!redirect)
      return

    const organizationStore = useOrganizationStore()
    await organizationStore.awaitInitialLoad()
    const organization = organizationStore.getOrgByAppId(data.app_id)
    if (organization)
      organizationStore.setCurrentOrganization(organization.gid)
    return redirect
  })
}
