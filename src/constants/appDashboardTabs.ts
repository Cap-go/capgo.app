import type { Tab } from '~/components/comp_def'
import IconChart from '~icons/heroicons/chart-bar'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconCube from '~icons/heroicons/cube'
import IconDevice from '~icons/heroicons/device-phone-mobile'

const RESERVED_APP_SEGMENTS = new Set(['new', 'modules', 'modules_test'])
const DASHBOARD_SUBTABS = new Set(['native', 'installs', 'active-bundle'])

export type AppDashboardSection = 'usage' | 'native' | 'installs' | 'active-bundle'

export const appDashboardTabs: Tab[] = [
  { label: 'dashboard-tab-usage', icon: IconChart, key: '' },
  { label: 'native', icon: IconDevice, key: '/native' },
  { label: 'dashboard-tab-installs', icon: IconCheckCircle, key: '/installs' },
  { label: 'active-bundle', icon: IconCube, key: '/active-bundle' },
]

export function isAppDashboardPath(path: string) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  if (parts[0] !== 'app' || parts.length < 2 || parts.length > 3)
    return false
  if (RESERVED_APP_SEGMENTS.has(parts[1]))
    return false
  if (parts.length === 2)
    return true
  return DASHBOARD_SUBTABS.has(parts[2])
}
