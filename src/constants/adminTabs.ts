import type { Tab } from '~/components/comp_def'
import IconArrowPath from '~icons/heroicons/arrow-path'
import IconBanknotes from '~icons/heroicons/banknotes'
import IconBell from '~icons/heroicons/bell'
import IconBuildingOffice from '~icons/heroicons/building-office-2'
import IconChartBar from '~icons/heroicons/chart-bar-square'
import IconCircleStack from '~icons/heroicons/circle-stack'
import IconCommandLine from '~icons/heroicons/command-line'
import IconCurrencyDollar from '~icons/heroicons/currency-dollar'
import IconPuzzle from '~icons/heroicons/puzzle-piece'
import IconUsers from '~icons/heroicons/user-group'
import IconBuild from '~icons/heroicons/wrench-screwdriver'

export const adminTabs: Tab[] = [
  { label: 'builder', icon: IconBuild, key: '/builder' },
  { label: 'updates', icon: IconArrowPath, key: '/updates' },
  { label: 'replication', icon: IconCircleStack, key: '/replication' },
  { label: 'plugins', icon: IconPuzzle, key: '/plugins' },
  { label: 'cli', icon: IconCommandLine, key: '/cli' },
  { label: 'users', icon: IconUsers, key: '/users' },
  { label: 'admin-organizations', icon: IconBuildingOffice, key: '/organizations' },
  { label: 'revenue', icon: IconBanknotes, key: '/revenue' },
  { label: 'plans-analytics-title', icon: IconChartBar, key: '/plans' },
  { label: 'credits', icon: IconCurrencyDollar, key: '/credits' },
  { label: 'notifications', icon: IconBell, key: '/notifications' },
]
