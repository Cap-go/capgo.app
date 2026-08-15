import type { Tab } from '~/components/comp_def'
import IconChart from '~icons/heroicons/chart-bar'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconCube from '~icons/heroicons/cube'
import IconDevice from '~icons/heroicons/device-phone-mobile'

export type AppDashboardSection = 'usage' | 'native' | 'installs' | 'active-bundle'

export const appDashboardTabs: Tab[] = [
  { label: 'dashboard-tab-usage', icon: IconChart, key: '' },
  { label: 'native', icon: IconDevice, key: '/native' },
  { label: 'dashboard-tab-installs', icon: IconCheckCircle, key: '/installs' },
  { label: 'active-bundle', icon: IconCube, key: '/active-bundle' },
]
