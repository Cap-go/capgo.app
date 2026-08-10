import type { Tab } from '~/components/comp_def'
import IconFunnel from '~icons/heroicons/funnel'
import IconGlobe from '~icons/heroicons/globe-alt'
import IconUserGroup from '~icons/heroicons/user-group'

export const adminOnboardingTabs: Tab[] = [
  { label: 'admin-onboarding-funnel', icon: IconFunnel, key: '' },
  { label: 'admin-onboarding-sources', icon: IconGlobe, key: '/sources' },
  { label: 'admin-onboarding-cohorts', icon: IconUserGroup, key: '/cohorts' },
]
