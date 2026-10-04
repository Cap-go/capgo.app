import type { Tab } from '~/components/comp_def'
import IconCompatibility from '~icons/heroicons/check-circle'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconError from '~icons/heroicons/exclamation-triangle'
import IconRocket from '~icons/heroicons/rocket-launch'

// Grouped by the question each tab answers: did my OTA release land, what is
// failing, how healthy is the native app, are native dependencies in sync.
export const observeTabs: Tab[] = [
  { label: 'observe-tab-releases', icon: IconRocket, key: '/releases' },
  { label: 'observe-tab-errors', icon: IconError, key: '/errors' },
  { label: 'native', icon: IconDevice, key: '/native' },
  { label: 'compatibility', icon: IconCompatibility, key: '/compatibility' },
  { label: 'logs', icon: IconHistory, key: '/logs' },
]

// Observe tabs whose content is scoped by the shared ?days= period.
export const OBSERVE_PERIOD_TABS = ['releases', 'errors', 'native'] as const
