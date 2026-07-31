import type { Tab } from '~/components/comp_def'
import IconBell from '~icons/heroicons/bell'
import IconChart from '~icons/heroicons/chart-bar'
import IconAudit from '~icons/heroicons/clipboard-document-list'
import IconPlan from '~icons/heroicons/credit-card'
import IconCredits from '~icons/heroicons/currency-dollar'
import IconWebhook from '~icons/heroicons/globe-alt'
import IconInfo from '~icons/heroicons/information-circle'
import IconSecurity from '~icons/heroicons/shield-check'
import IconUsers from '~icons/heroicons/users'

export const organizationTabs: Tab[] = [
  { label: 'general', key: '/settings/organization', icon: IconInfo },
  { label: 'members', key: '/settings/organization/members', icon: IconUsers },
  { label: 'groups', key: '/settings/organization/groups', icon: IconUsers },
  { label: 'plans', key: '/settings/organization/plans', icon: IconPlan },
  { label: 'credits', key: '/settings/organization/credits', icon: IconCredits },
  { label: 'security', key: '/settings/organization/security', icon: IconSecurity },
  { label: 'usage', key: '/settings/organization/usage', icon: IconChart },
  { label: 'notifications', key: '/settings/organization/notifications', icon: IconBell },
  { label: 'audit-logs', key: '/settings/organization/auditlogs', icon: IconAudit },
  { label: 'webhooks', key: '/settings/organization/webhooks', icon: IconWebhook },
]
