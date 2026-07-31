import type { Tab } from '~/components/comp_def'
import IconChartBar from '~icons/heroicons/chart-bar'
import IconPuzzlePiece from '~icons/heroicons/puzzle-piece'

export const observeTabs: Tab[] = [
  { label: 'global', icon: IconChartBar, key: '' },
  { label: 'plugins', icon: IconPuzzlePiece, key: '/plugins' },
]
