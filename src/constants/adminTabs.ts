import type { Tab } from '~/components/comp_def'
import IconBanknotes from '~icons/heroicons/banknotes'
import IconBuildingOffice from '~icons/heroicons/building-office-2'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconCircleStack from '~icons/heroicons/circle-stack'
import IconHeart from '~icons/heroicons/heart'
import IconRocket from '~icons/heroicons/rocket-launch'
import IconSparkles from '~icons/heroicons/sparkles'

/** Primary admin hubs — organized by admin intention, not product feature. */
export const adminTabs: Tab[] = [
  { label: 'admin-pulse', icon: IconChartBar, key: '/pulse' },
  { label: 'admin-onboarding', icon: IconRocket, key: '/onboarding' },
  { label: 'admin-product', icon: IconSparkles, key: '/product/updates' },
  { label: 'admin-retention', icon: IconHeart, key: '/retention' },
  { label: 'admin-customers', icon: IconBuildingOffice, key: '/customers/organizations' },
  { label: 'admin-revenue', icon: IconBanknotes, key: '/revenue' },
  { label: 'admin-platform', icon: IconCircleStack, key: '/platform/replication' },
]
