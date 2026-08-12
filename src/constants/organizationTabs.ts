import type { Tab } from '~/components/comp_def'
import IconBell from '~icons/heroicons/bell'
import IconChart from '~icons/heroicons/chart-bar'
import IconAudit from '~icons/heroicons/clipboard-document-list'
import IconPlan from '~icons/heroicons/credit-card'
import IconCredits from '~icons/heroicons/currency-dollar'
import IconWebhook from '~icons/heroicons/globe-alt'
import IconInfo from '~icons/heroicons/information-circle'
import IconSecurity from '~icons/heroicons/shield-check'
import IconUserGroup from '~icons/heroicons/user-group'
import IconUsers from '~icons/heroicons/users'

/** Hub keys used as secondary org tabs for grouped sections. */
export const ORG_TEAM_HUB = '/settings/organization/members'
export const ORG_PLAN_HUB = '/settings/organization/plans'

export const organizationTeamSubTabs: Tab[] = [
  { label: 'members', key: '/settings/organization/members', icon: IconUsers },
  { label: 'groups', key: '/settings/organization/groups', icon: IconUserGroup },
  { label: 'security', key: '/settings/organization/security', icon: IconSecurity },
]

export const organizationPlanSubTabs: Tab[] = [
  { label: 'plans', key: '/settings/organization/plans', icon: IconPlan },
  { label: 'credits', key: '/settings/organization/credits', icon: IconCredits },
  // Billing is injected in the settings layout (Stripe portal / permission modal).
]

/** Flat list of every org settings route tab (used for order + permission lookups). */
export const organizationTabs: Tab[] = [
  { label: 'general', key: '/settings/organization', icon: IconInfo },
  { label: 'members', key: '/settings/organization/members', icon: IconUsers },
  { label: 'groups', key: '/settings/organization/groups', icon: IconUserGroup },
  { label: 'plans', key: '/settings/organization/plans', icon: IconPlan },
  { label: 'credits', key: '/settings/organization/credits', icon: IconCredits },
  { label: 'security', key: '/settings/organization/security', icon: IconSecurity },
  { label: 'usage', key: '/settings/organization/usage', icon: IconChart },
  { label: 'notifications', key: '/settings/organization/notifications', icon: IconBell },
  { label: 'audit-logs', key: '/settings/organization/auditlogs', icon: IconAudit },
  { label: 'webhooks', key: '/settings/organization/webhooks', icon: IconWebhook },
]

/** Secondary org tabs after grouping Team + Plan hubs. */
export const organizationMainTabs: Tab[] = [
  { label: 'general', key: '/settings/organization', icon: IconInfo },
  { label: 'team', key: ORG_TEAM_HUB, icon: IconUsers },
  { label: 'plan', key: ORG_PLAN_HUB, icon: IconPlan },
  { label: 'usage', key: '/settings/organization/usage', icon: IconChart },
  { label: 'notifications', key: '/settings/organization/notifications', icon: IconBell },
  { label: 'audit-logs', key: '/settings/organization/auditlogs', icon: IconAudit },
  { label: 'webhooks', key: '/settings/organization/webhooks', icon: IconWebhook },
]

export function isOrgTeamPath(path: string): boolean {
  const p = path.replace(/\/$/, '')
  return p === '/settings/organization/members'
    || p.startsWith('/settings/organization/members/')
    || p === '/settings/organization/groups'
    || p.startsWith('/settings/organization/groups/')
    || p === '/settings/organization/security'
    || p.startsWith('/settings/organization/security/')
}

export function isOrgPlanPath(path: string): boolean {
  const p = path.replace(/\/$/, '')
  return p === '/settings/organization/plans'
    || p.startsWith('/settings/organization/plans/')
    || p === '/settings/organization/credits'
    || p.startsWith('/settings/organization/credits/')
    || p === '/billing'
    || p.startsWith('/billing/')
}
