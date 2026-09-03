import type { Tab } from '~/components/comp_def'
import IconBell from '~icons/heroicons/bell'
import IconChart from '~icons/heroicons/chart-bar'
import IconAudit from '~icons/heroicons/clipboard-document-list'
import IconPlan from '~icons/heroicons/credit-card'
import IconCredits from '~icons/heroicons/currency-dollar'
import IconWebhook from '~icons/heroicons/globe-alt'
import IconInfo from '~icons/heroicons/information-circle'
import IconServer from '~icons/heroicons/server-stack'
import IconSecurity from '~icons/heroicons/shield-check'
import IconUserGroup from '~icons/heroicons/user-group'
import IconUsers from '~icons/heroicons/users'
import { BILLING_TAB_KEY, TEAM_TAB_KEY } from '~/utils/organizationTabs'

export const organizationTabs: Tab[] = [
  { label: 'general', key: '/settings/organization', icon: IconInfo },
  {
    label: 'team',
    key: TEAM_TAB_KEY,
    icon: IconUsers,
    children: [
      { label: 'members', key: '/settings/organization/members', icon: IconUsers },
      { label: 'groups', key: '/settings/organization/groups', icon: IconUserGroup },
      { label: 'security', key: '/settings/organization/security', icon: IconSecurity },
    ],
  },
  {
    label: 'billing',
    key: BILLING_TAB_KEY,
    icon: IconPlan,
    children: [
      { label: 'plans', key: '/settings/organization/plans', icon: IconPlan },
      { label: 'credits', key: '/settings/organization/credits', icon: IconCredits },
      { label: 'dedicated-builder', key: '/settings/organization/dedicated-builder', icon: IconServer },
    ],
  },
  { label: 'usage', key: '/settings/organization/usage', icon: IconChart },
  { label: 'notifications', key: '/settings/organization/notifications', icon: IconBell },
  { label: 'audit-logs', key: '/settings/organization/auditlogs', icon: IconAudit },
  { label: 'webhooks', key: '/settings/organization/webhooks', icon: IconWebhook },
]
