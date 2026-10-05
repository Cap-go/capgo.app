import type { Tab } from '~/components/comp_def'
import IconBell from '~icons/heroicons/bell-alert'
import IconCog from '~icons/heroicons/cog-6-tooth'
import IconCube from '~icons/heroicons/cube'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconObserve from '~icons/heroicons/eye'
import IconChannel from '~icons/heroicons/signal'
import IconBuild from '~icons/heroicons/wrench-screwdriver'

// Tabs follow the release workflow and the product groups used on capgo.app:
// observe first (the app overview is its landing sub-tab), then ship
// (bundles, channels, native builds), then monitor & reach users (devices,
// push), then configure.
export const appTabs: Tab[] = [
  { label: 'observe', icon: IconObserve, key: '', group: 'overview', description: 'observe-description' },
  { label: 'bundles', icon: IconCube, key: '/bundles', group: 'ship', description: 'bundles-description' },
  { label: 'channels', icon: IconChannel, key: '/channels', group: 'ship', description: 'channels-description' },
  { label: 'builds', icon: IconBuild, key: '/builds', group: 'ship', description: 'builds-description' },
  { label: 'devices', icon: IconDevice, key: '/devices', group: 'monitor', description: 'devices-description' },
  { label: 'notifications', icon: IconBell, key: '/notifications', badge: 'beta', group: 'monitor', description: 'notifications-description' },
  { label: 'settings', icon: IconCog, key: '/settings', group: 'configure', description: 'app-settings-description' },
]
