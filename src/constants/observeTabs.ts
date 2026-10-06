import type { Tab } from '~/components/comp_def'
import IconCompatibility from '~icons/heroicons/check-circle'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconError from '~icons/heroicons/exclamation-triangle'
import IconRocket from '~icons/heroicons/rocket-launch'

// Keys are relative to the app root: Live release is the Observe landing page.
// Grouped by the question each tab answers: did my OTA release land, what is
// failing, how healthy is the native app, are native dependencies in sync.
export const observeTabs: Tab[] = [
  { label: 'dashboard-tab-live-release', icon: IconRocket, key: '' },
  { label: 'observe-tab-errors', icon: IconError, key: '/observe/errors' },
  { label: 'native', icon: IconDevice, key: '/observe/native', badge: 'beta' },
  { label: 'compatibility', icon: IconCompatibility, key: '/observe/compatibility' },
  { label: 'logs', icon: IconHistory, key: '/observe/logs' },
]
