import type { Tab } from '~/components/comp_def'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconCompatibility from '~icons/heroicons/check-circle'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconPuzzlePiece from '~icons/heroicons/puzzle-piece'

export const observeTabs: Tab[] = [
  { label: 'updater', icon: IconChartBar, key: '/updater' },
  { label: 'logs', icon: IconHistory, key: '/logs' },
  { label: 'native', icon: IconDevice, key: '/native' },
  { label: 'compatibility', icon: IconCompatibility, key: '/compatibility' },
  { label: 'plugins', icon: IconPuzzlePiece, key: '/plugins' },
]
