import type { RouteLocationRaw } from 'vue-router'
import { compare, tryParse } from '@std/semver'
import { invokeCapgoApi } from '~/services/capgoApi'

export type ChangelogProduct = 'console' | 'cli' | 'updater' | 'plugin'
export type ChangelogSectionType = 'added' | 'changed' | 'fixed' | 'security' | 'removed' | 'deprecated' | 'other'
export type DigestImpact = 'high' | 'medium' | 'low'

export interface ChangelogSection {
  type: ChangelogSectionType
  items: string[]
}

export interface ChangelogRelease {
  version: string
  tag: string
  date: string
  url: string
  sections: ChangelogSection[]
}

export interface ChangelogReleasesResponse {
  product: ChangelogProduct
  repo: string
  latest: string | null
  truncated: boolean
  releases: ChangelogRelease[]
}

export interface ChangelogPlugin {
  name: string
  repo: string
  description: string
  version: string
  date: string
}

export interface DigestHighlight {
  title: string
  detail: string
  type: ChangelogSectionType
  version: string
  impact: DigestImpact
  relevant: boolean
}

export interface ChangelogDigest {
  product: ChangelogProduct
  repo: string
  fromVersion: string | null
  toVersion: string | null
  releaseCount: number
  counts: Record<ChangelogSectionType, number>
  headline: string
  highlights: DigestHighlight[]
  actionRequired: string[]
  aiGenerated: boolean
  truncated: boolean
  releases: ChangelogRelease[]
}

export interface DigestContext {
  platforms?: string[]
  features?: string[]
}

export const UPDATER_PACKAGE = '@capgo/capacitor-updater'
export const CLI_PACKAGE = '@capgo/cli'
export const SECTION_ORDER: ChangelogSectionType[] = ['security', 'removed', 'added', 'changed', 'fixed', 'deprecated', 'other']
export const CHANGELOG_PRODUCTS: ChangelogProduct[] = ['console', 'cli', 'updater', 'plugin']

const RELEASES_CACHE_MS = 5 * 60 * 1000
const releasesCache = new Map<string, { at: number, promise: Promise<ChangelogReleasesResponse | null> }>()
let pluginsPromise: Promise<ChangelogPlugin[]> | null = null
const digestCache = new Map<string, Promise<ChangelogDigest | null>>()

export function isChangelogProduct(value: unknown): value is ChangelogProduct {
  return typeof value === 'string' && (CHANGELOG_PRODUCTS as string[]).includes(value)
}

export function cleanVersion(version: string | null | undefined): string | null {
  if (!version)
    return null
  const cleaned = version.trim().replace(/^[v^~=]+/, '')
  return tryParse(cleaned) ? cleaned : null
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewerVersion(latest: string | null | undefined, current: string | null | undefined): boolean {
  const left = tryParse(cleanVersion(latest) ?? '')
  const right = tryParse(cleanVersion(current) ?? '')
  if (!left || !right)
    return false
  return compare(left, right) > 0
}

export function releasesSince(releases: ChangelogRelease[], since: string | null | undefined) {
  const from = tryParse(cleanVersion(since) ?? '')
  if (!from)
    return releases
  return releases.filter((release) => {
    const version = tryParse(release.version)
    return !!version && compare(version, from) > 0
  })
}

/** Plugin repo for an npm package name, e.g. @capgo/capacitor-nfc → capacitor-nfc. */
export function pluginRepoFromPackage(name: string, plugins: ChangelogPlugin[] = []) {
  return plugins.find(plugin => plugin.name === name)?.repo ?? null
}

export function changelogLocation(product: ChangelogProduct, options: { since?: string | null, repo?: string | null } = {}): RouteLocationRaw {
  const query: Record<string, string> = { product }
  if (options.repo)
    query.repo = options.repo
  const since = cleanVersion(options.since)
  if (since)
    query.since = since
  return { path: '/changelog', query }
}

/** Where a native package's changelog lives: the updater has its own tab, other @capgo plugins share one. */
export function changelogLocationForPackage(name: string, version: string | null | undefined, plugins: ChangelogPlugin[]): RouteLocationRaw | null {
  if (name === UPDATER_PACKAGE)
    return changelogLocation('updater', { since: version })
  if (name === CLI_PACKAGE)
    return changelogLocation('cli', { since: version })
  const repo = pluginRepoFromPackage(name, plugins)
  return repo ? changelogLocation('plugin', { repo, since: version }) : null
}

export function fetchReleases(product: ChangelogProduct, repo?: string | null): Promise<ChangelogReleasesResponse | null> {
  const key = `${product}:${repo ?? ''}`
  const hit = releasesCache.get(key)
  if (hit && Date.now() - hit.at < RELEASES_CACHE_MS)
    return hit.promise
  const params = new URLSearchParams({ product })
  if (repo)
    params.set('repo', repo)
  const promise = invokeCapgoApi<ChangelogReleasesResponse>(`private/changelog?${params.toString()}`, { method: 'GET' })
    .then(({ data, error }) => {
      if (error || !data) {
        releasesCache.delete(key)
        return null
      }
      return data
    })
  releasesCache.set(key, { at: Date.now(), promise })
  return promise
}

export async function fetchLatestVersion(product: ChangelogProduct, repo?: string | null) {
  return (await fetchReleases(product, repo))?.latest ?? null
}

export function fetchPlugins(): Promise<ChangelogPlugin[]> {
  pluginsPromise ??= invokeCapgoApi<{ plugins: ChangelogPlugin[] }>('private/changelog/plugins', { method: 'GET' })
    .then(({ data, error }) => {
      if (error || !data) {
        pluginsPromise = null
        return []
      }
      return data.plugins
    })
  return pluginsPromise
}

export function fetchDigest(input: {
  product: ChangelogProduct
  repo?: string | null
  fromVersion: string
  toVersion?: string | null
  locale?: string
  context?: DigestContext
}): Promise<ChangelogDigest | null> {
  const key = JSON.stringify(input)
  const hit = digestCache.get(key)
  if (hit)
    return hit
  const promise = invokeCapgoApi<ChangelogDigest>('private/changelog/digest', {
    method: 'POST',
    body: input,
    // Workers AI can take a few seconds; never retry a paid call.
    retries: 0,
  }).then(({ data, error }) => {
    if (error || !data) {
      digestCache.delete(key)
      return null
    }
    return data
  })
  digestCache.set(key, promise)
  return promise
}

/** Case-insensitive match of every search word against a release's version and items. */
export function filterReleases(
  releases: ChangelogRelease[],
  query: string,
  types: Set<ChangelogSectionType>,
): ChangelogRelease[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return releases.flatMap((release) => {
    const versionHit = words.length > 0 && words.every(word => release.version.includes(word))
    const sections = release.sections
      .filter(section => types.size === 0 || types.has(section.type))
      .map(section => ({
        ...section,
        items: versionHit || !words.length
          ? section.items
          : section.items.filter((item) => {
              const lower = item.toLowerCase()
              return words.every(word => lower.includes(word))
            }),
      }))
      .filter(section => section.items.length)
    return sections.length ? [{ ...release, sections }] : []
  })
}

export interface HighlightPart {
  text: string
  match: boolean
}

/** Split text into parts so the template can wrap search hits in <mark> without v-html. */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const words = query.split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length)
    return [{ text, match: false }]
  const pattern = new RegExp(`(${words.join('|')})`, 'gi')
  return text.split(pattern).filter(Boolean).map(part => ({ text: part, match: words.some(word => new RegExp(`^${word}$`, 'i').test(part)) }))
}

/** Render the small markdown subset release notes use (**bold**, `code`, #123) as safe parts. */
export type InlinePart = { kind: 'text' | 'bold' | 'code', text: string } | { kind: 'issue', text: string, number: string }

export function inlineMarkdownParts(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\(#(\d+)\)|#(\d+)\b/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last)
      parts.push({ kind: 'text', text: text.slice(last, index) })
    if (match[1])
      parts.push({ kind: 'bold', text: match[1].replace(/`/g, '') })
    else if (match[2])
      parts.push({ kind: 'code', text: match[2] })
    else
      parts.push({ kind: 'issue', text: `#${match[3] ?? match[4]}`, number: match[3] ?? match[4] })
    last = index + match[0].length
  }
  if (last < text.length)
    parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

const LAST_SEEN_CONSOLE_KEY = 'capgo_changelog_console_seen'

export function getLastSeenConsoleVersion() {
  try {
    return localStorage.getItem(LAST_SEEN_CONSOLE_KEY)
  }
  catch {
    return null
  }
}

export function setLastSeenConsoleVersion(version: string) {
  try {
    localStorage.setItem(LAST_SEEN_CONSOLE_KEY, version)
  }
  catch {
    // Private mode: the modal may show again next session, which is harmless.
  }
}
