import type { Tab } from '~/components/comp_def'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconCompatibility from '~icons/heroicons/check-circle'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'
import IconPuzzlePiece from '~icons/heroicons/puzzle-piece'

export const observeTabs: Tab[] = [
  { label: 'observe-update', icon: IconChartBar, key: '/update' },
  { label: 'observe-failure', icon: IconExclamationTriangle, key: '/failure' },
  { label: 'logs', icon: IconHistory, key: '/logs' },
  { label: 'native', icon: IconDevice, key: '/native' },
  { label: 'compatibility', icon: IconCompatibility, key: '/compatibility' },
  { label: 'plugins', icon: IconPuzzlePiece, key: '/plugins' },
]
