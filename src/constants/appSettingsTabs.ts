import type { Tab } from '~/components/comp_def'
import IconCog from '~icons/heroicons/cog-6-tooth'
import IconShield from '~icons/heroicons/shield-check'

export const appSettingsTabs: Tab[] = [
  { label: 'settings', icon: IconCog, key: '' },
  { label: 'access', icon: IconShield, key: '/access' },
]
