import type { Tab } from '../src/components/comp_def'
import { describe, expect, it } from 'vitest'
import {
  BILLING_TAB_KEY,
  cloneTabs,
  defaultChild,
  findActiveChildKey,
  findActiveTabKey,
  pathMatchesTab,
  TEAM_TAB_KEY,
} from '../src/utils/organizationTabs'

const organizationTabs: Tab[] = [
  { label: 'general', key: '/settings/organization' },
  {
    label: 'team',
    key: TEAM_TAB_KEY,
    children: [
      { label: 'members', key: '/settings/organization/members' },
      { label: 'groups', key: '/settings/organization/groups' },
      { label: 'security', key: '/settings/organization/security' },
    ],
  },
  {
    label: 'billing',
    key: BILLING_TAB_KEY,
    children: [
      { label: 'plans', key: '/settings/organization/plans' },
      { label: 'credits', key: '/settings/organization/credits' },
    ],
  },
  { label: 'usage', key: '/settings/organization/usage' },
  { label: 'webhooks', key: '/settings/organization/webhooks' },
]

describe('organization settings tab groups', () => {
  it.concurrent('defaults team to members and billing to plans', () => {
    const team = organizationTabs.find(tab => tab.key === TEAM_TAB_KEY)
    const billing = organizationTabs.find(tab => tab.key === BILLING_TAB_KEY)

    expect(defaultChild(team)?.key).toBe('/settings/organization/members')
    expect(defaultChild(billing)?.key).toBe('/settings/organization/plans')
    expect(team?.children?.map(tab => tab.label)).toEqual(['members', 'groups', 'security'])
    expect(billing?.children?.map(tab => tab.label)).toEqual(['plans', 'credits'])
  })

  it.concurrent('keeps grouped parent tabs active for nested routes', () => {
    expect(findActiveTabKey(organizationTabs, '/settings/organization/members')).toBe(TEAM_TAB_KEY)
    expect(findActiveTabKey(organizationTabs, '/settings/organization/groups/abc')).toBe(TEAM_TAB_KEY)
    expect(findActiveTabKey(organizationTabs, '/settings/organization/security')).toBe(TEAM_TAB_KEY)
    expect(findActiveTabKey(organizationTabs, '/settings/organization/plans')).toBe(BILLING_TAB_KEY)
    expect(findActiveTabKey(organizationTabs, '/settings/organization/credits')).toBe(BILLING_TAB_KEY)
    expect(findActiveTabKey(organizationTabs, '/settings/organization')).toBe('/settings/organization')
    expect(findActiveTabKey(organizationTabs, '/settings/organization/webhooks')).toBe('/settings/organization/webhooks')
  })

  it.concurrent('matches the active child inside a group', () => {
    const tabs = cloneTabs(organizationTabs)
    const team = tabs.find(tab => tab.key === TEAM_TAB_KEY)

    expect(findActiveChildKey(team, '/settings/organization/groups/new')).toBe('/settings/organization/groups')
    expect(pathMatchesTab(team!, '/settings/organization/members')).toBe(true)
    expect(pathMatchesTab(team!, '/settings/organization/plans')).toBe(false)
  })
})
