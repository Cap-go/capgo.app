import type { Tab } from '~/components/comp_def'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconHistory from '~icons/heroicons/clock'

export const logTabs: Tab[] = [
  { label: 'log-insights', icon: IconChartBar, key: '/insights' },
  { label: 'logs', icon: IconHistory, key: '' },
]
