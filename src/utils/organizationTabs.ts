import type { Tab } from '~/components/comp_def'

export const TEAM_TAB_KEY = 'org-team'
export const BILLING_TAB_KEY = 'org-billing'

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
