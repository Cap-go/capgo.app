import type { Tab } from '~/components/comp_def'
import type { AppDashboardSubtab } from '~/utils/appDashboardPath'
import IconChart from '~icons/heroicons/chart-bar'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconCube from '~icons/heroicons/cube'
import IconDevice from '~icons/heroicons/device-phone-mobile'

export type { AppDashboardSection } from '~/utils/appDashboardPath'

function subtabKey(name: AppDashboardSubtab) {
  return `/${name}`
}

export const appDashboardTabs: Tab[] = [
  { label: 'dashboard-tab-usage', icon: IconChart, key: '' },
  { label: 'native', icon: IconDevice, key: subtabKey('native') },
  { label: 'dashboard-tab-installs', icon: IconCheckCircle, key: subtabKey('installs') },
  { label: 'active-bundle', icon: IconCube, key: subtabKey('active-bundle') },
]
