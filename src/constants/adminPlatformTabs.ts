import type { Tab } from '~/components/comp_def'
import IconBug from '~icons/heroicons/bug-ant'
import IconCircleStack from '~icons/heroicons/circle-stack'
import IconCpu from '~icons/heroicons/cpu-chip'

export const adminPlatformTabs: Tab[] = [
  { label: 'replication', icon: IconCircleStack, key: '/replication' },
  { label: 'admin-platform-capacity', icon: IconCpu, key: '/capacity' },
  { label: 'admin-debug', icon: IconBug, key: '/debug' },
]
