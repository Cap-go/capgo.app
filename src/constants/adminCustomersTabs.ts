import type { Tab } from '~/components/comp_def'
import IconBuildingOffice from '~icons/heroicons/building-office-2'
import IconCurrencyDollar from '~icons/heroicons/currency-dollar'

export const adminCustomersTabs: Tab[] = [
  { label: 'admin-organizations', icon: IconBuildingOffice, key: '/organizations' },
  { label: 'credits', icon: IconCurrencyDollar, key: '/credits' },
]
