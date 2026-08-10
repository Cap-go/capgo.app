import type { Tab } from '~/components/comp_def'
import IconArrowPath from '~icons/heroicons/arrow-path'
import IconBell from '~icons/heroicons/bell'
import IconCommandLine from '~icons/heroicons/command-line'
import IconPuzzle from '~icons/heroicons/puzzle-piece'
import IconBuild from '~icons/heroicons/wrench-screwdriver'

export const adminProductTabs: Tab[] = [
  { label: 'updates', icon: IconArrowPath, key: '/updates' },
  { label: 'plugins', icon: IconPuzzle, key: '/plugins' },
  { label: 'cli', icon: IconCommandLine, key: '/cli' },
  { label: 'builder', icon: IconBuild, key: '/builder' },
  { label: 'notifications', icon: IconBell, key: '/notifications' },
]
