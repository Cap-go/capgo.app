import type { Tab } from '~/components/comp_def'
import IconBell from '~icons/heroicons/bell-alert'
import IconChart from '~icons/heroicons/chart-bar'
import IconCog from '~icons/heroicons/cog-6-tooth'
import IconCube from '~icons/heroicons/cube'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconObserve from '~icons/heroicons/eye'
import IconChannel from '~icons/heroicons/signal'
import IconBuild from '~icons/heroicons/wrench-screwdriver'

export const appTabs: Tab[] = [
  { label: 'dashboard', icon: IconChart, key: '' },
  { label: 'observe', icon: IconObserve, key: '/observe/updater', badge: 'beta' },
  { label: 'settings', icon: IconCog, key: '/settings' },
  { label: 'bundles', icon: IconCube, key: '/bundles' },
  { label: 'channels', icon: IconChannel, key: '/channels' },
  { label: 'devices', icon: IconDevice, key: '/devices' },
  { label: 'notifications', icon: IconBell, key: '/notifications', badge: 'beta' },
  { label: 'builds', icon: IconBuild, key: '/builds' },
]
