import type { UserModule } from '~/types'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

// App setup continues on Getting started inside the dashboard shell. Keep old
// resume links (emails, CLI login, bookmarks) working by forwarding them there.
export const install: UserModule = ({ router }) => {
  router.beforeResolve((to) => {
    if (to.path !== '/onboarding/app' && to.path !== '/app/new')
      return
    const resumeAppId = to.query.resume
    if (typeof resumeAppId !== 'string' || !resumeAppId)
      return
    return { path: getAppGettingStartedPath(resumeAppId), replace: true }
  })
}
