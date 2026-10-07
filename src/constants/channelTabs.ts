import type { Tab } from '~/components/comp_def'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconEye from '~icons/heroicons/eye'
import IconInfo from '~icons/heroicons/information-circle'

export const channelTabs: Tab[] = [
  { label: 'info', icon: IconInfo, key: '' },
  { label: 'statistics', icon: IconChartBar, key: '/statistics' },
  { label: 'devices', icon: IconDevice, key: '/devices' },
  { label: 'history', icon: IconHistory, key: '/history' },
  { label: 'preview-tab', icon: IconEye, key: '/preview' },
]
