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

export const TEAM_TAB_KEY = 'org-team'
export const BILLING_TAB_KEY = 'org-billing'

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
    ],
  },
  { label: 'usage', key: '/settings/organization/usage', icon: IconChart },
  { label: 'notifications', key: '/settings/organization/notifications', icon: IconBell },
  { label: 'audit-logs', key: '/settings/organization/auditlogs', icon: IconAudit },
  { label: 'webhooks', key: '/settings/organization/webhooks', icon: IconWebhook },
]

export function cloneTabs(tabs: Tab[]): Tab[] {
  return tabs.map(tab => ({
    ...tab,
    ...(tab.children ? { children: cloneTabs(tab.children) } : {}),
  }))
}

function pathMatchesKey(path: string, key: string): boolean {
  const normalizedPath = path.replace(/\/$/, '')
  const normalizedKey = key.replace(/\/$/, '')
  return normalizedPath === normalizedKey || normalizedPath.startsWith(`${normalizedKey}/`)
}

export function pathMatchesTab(tab: Tab, path: string): boolean {
  if (tab.children?.length)
    return tab.children.some(child => pathMatchesTab(child, path))
  return pathMatchesKey(path, tab.key)
}

export function findActiveTabKey(tabs: Tab[], path: string): string | undefined {
  const grouped = tabs.find(tab => tab.children?.length && pathMatchesTab(tab, path))
  if (grouped)
    return grouped.key

  const leaves = tabs.filter(tab => !tab.children?.length)
  const match = [...leaves]
    .sort((a, b) => b.key.length - a.key.length)
    .find(tab => pathMatchesKey(path, tab.key))

  return match?.key ?? tabs[0]?.key
}

export function findActiveChildKey(tab: Tab | undefined, path: string): string | undefined {
  if (!tab?.children?.length)
    return undefined
  return findActiveTabKey(tab.children, path)
}

export function defaultChild(tab: Tab | undefined): Tab | undefined {
  return tab?.children?.[0]
}
