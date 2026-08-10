import type { Tab } from '~/components/comp_def'
import IconArrowTrendingUp from '~icons/heroicons/arrow-trending-up'
import IconBanknotes from '~icons/heroicons/banknotes'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'

export const adminRevenueTabs: Tab[] = [
  { label: 'admin-revenue-overview', icon: IconBanknotes, key: '' },
  { label: 'admin-revenue-upgrades', icon: IconArrowTrendingUp, key: '/upgrades' },
  { label: 'admin-revenue-risk', icon: IconExclamationTriangle, key: '/risk' },
]
