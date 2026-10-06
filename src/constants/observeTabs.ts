import type { Tab } from '~/components/comp_def'
import IconCompatibility from '~icons/heroicons/check-circle'
import IconHistory from '~icons/heroicons/clock'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconError from '~icons/heroicons/exclamation-triangle'
import IconPuzzle from '~icons/heroicons/puzzle-piece'
import IconRocket from '~icons/heroicons/rocket-launch'
import IconTable from '~icons/heroicons/table-cells'

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

// Third-level tabs inside an Observe page, selected with ?view=<key>. The
// first entry is the default view.
export const observeViewTabs: Record<string, Tab[]> = {
  native: [
    { label: 'native-observe-version-health', icon: IconTable, key: 'versions' },
    { label: 'native-observe-action-breakdown', icon: IconError, key: 'actions' },
    { label: 'native-release-stats-title', icon: IconDevice, key: 'releases' },
  ],
  compatibility: [
    { label: 'compatibility-events', icon: IconCompatibility, key: 'events' },
    { label: 'plugins', icon: IconPuzzle, key: 'plugins' },
  ],
}
