import type { Tab } from '~/components/comp_def'
import IconClock from '~icons/heroicons/clock'
import IconNoSymbol from '~icons/heroicons/no-symbol'
import IconPause from '~icons/heroicons/pause-circle'

export const adminRetentionTabs: Tab[] = [
  { label: 'admin-retention-trials', icon: IconClock, key: '' },
  { label: 'admin-retention-churn', icon: IconNoSymbol, key: '/churn' },
  { label: 'admin-retention-inactive', icon: IconPause, key: '/inactive' },
]
