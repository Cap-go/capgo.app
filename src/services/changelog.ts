import type { RouteLocationRaw } from 'vue-router'
import { compare, tryParse } from '@std/semver'
import { invokeCapgoApi } from '~/services/capgoApi'

export type ChangelogProduct = 'console' | 'cli' | 'updater' | 'plugin' | 'capacitor' | 'dependency'
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
export const CHANGELOG_PRODUCTS: ChangelogProduct[] = ['console', 'cli', 'updater', 'plugin', 'capacitor', 'dependency']

const RELEASES_CACHE_MS = 5 * 60 * 1000
const releasesCache = new Map<string, { at: number, promise: Promise<ChangelogReleasesResponse | null> }>()
const PLUGINS_CACHE_MS = 30 * 60 * 1000
let pluginsCache: { at: number, promise: Promise<ChangelogPlugin[]> } | null = null
const digestCache = new Map<string, { at: number, ttl: number, promise: Promise<ChangelogDigest | null> }>()
const dependencyCache = new Map<string, { at: number, promise: Promise<string | null> }>()
const dependencyQueue: Array<() => void> = []
let dependencyRequests = 0

export const CAPACITOR_CORE_PACKAGES = new Set(['@capacitor/core', '@capacitor/android', '@capacitor/ios', '@capacitor/cli'])

export function githubRepoUrl(repo: string) {
  return `https://github.com/${repo.includes('/') ? repo : `Cap-go/${repo}`}`
}

export function packageChangelog(name: string, plugins: ChangelogPlugin[] = []): { product: ChangelogProduct, repo?: string } {
  if (name === UPDATER_PACKAGE)
    return { product: 'updater' }
  if (name === CLI_PACKAGE)
    return { product: 'cli' }
  if (CAPACITOR_CORE_PACKAGES.has(name))
    return { product: 'capacitor' }
  const repo = pluginRepoFromPackage(name, plugins)
  return repo ? { product: 'plugin', repo } : { product: 'dependency', repo: name }
}

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

export function changelogLocation(product: ChangelogProduct, options: { since?: string | null, repo?: string | null, to?: string | null } = {}): RouteLocationRaw {
  const query: Record<string, string> = { product }
  if (options.repo)
    query.repo = options.repo
  const since = cleanVersion(options.since)
  if (since)
    query.since = since
  // Upper bound of the upgrade, e.g. the latest updater for the app's Capacitor major (not the overall latest).
  const to = cleanVersion(options.to)
  if (to)
    query.to = to
  return { path: '/changelog', query }
}

/** Route every detected native dependency to its product's release notes. */
export function changelogLocationForPackage(name: string, version: string | null | undefined, plugins: ChangelogPlugin[]): RouteLocationRaw {
  const target = packageChangelog(name, plugins)
  return changelogLocation(target.product, { since: version, repo: target.repo })
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
  if (product === 'cli')
    return fetchDependencyVersion(CLI_PACKAGE)
  if (product === 'updater')
    return fetchDependencyVersion(UPDATER_PACKAGE)
  if (product === 'dependency' && repo)
    return fetchDependencyVersion(repo)
  if (product === 'capacitor')
    return fetchDependencyVersion('@capacitor/core')
  return (await fetchReleases(product, repo))?.latest ?? null
}

/** Limit registry lookups for a bundle with many native packages; release notes load only on navigation. */
function fetchDependencyVersion(name: string): Promise<string | null> {
  const cached = dependencyCache.get(name)
  if (cached && Date.now() - cached.at < PLUGINS_CACHE_MS)
    return cached.promise
  const promise = (async () => {
    if (dependencyRequests >= 4)
      await new Promise<void>(resolve => dependencyQueue.push(resolve))
    dependencyRequests++
    try {
      const params = new URLSearchParams({ package: name })
      const { data, error } = await invokeCapgoApi<{ version: string }>(`private/changelog/dependency?${params}`, { method: 'GET', retries: 0 })
      if (error || !data) {
        dependencyCache.delete(name)
        return null
      }
      return cleanVersion(data.version)
    }
    finally {
      dependencyRequests--
      dependencyQueue.shift()?.()
    }
  })()
  if (dependencyCache.size >= 200)
    dependencyCache.delete(dependencyCache.keys().next().value ?? '')
  dependencyCache.set(name, { at: Date.now(), promise })
  return promise
}

export function fetchPlugins(): Promise<ChangelogPlugin[]> {
  if (pluginsCache && Date.now() - pluginsCache.at < PLUGINS_CACHE_MS)
    return pluginsCache.promise
  const promise = invokeCapgoApi<{ plugins: ChangelogPlugin[] }>('private/changelog/plugins', { method: 'GET' })
    .then(({ data, error }) => {
      if (error || !data) {
        pluginsCache = null
        return []
      }
      return data.plugins
    })
  pluginsCache = { at: Date.now(), promise }
  return promise
}

export function fetchDigest(input: {
  product: ChangelogProduct
  repo?: string | null
  fromVersion: string
  toVersion?: string | null
  locale?: string
  context?: DigestContext
}): Promise<ChangelogDigest | null> {
  const normalized = {
    product: input.product,
    repo: input.repo ?? null,
    fromVersion: cleanVersion(input.fromVersion) ?? input.fromVersion,
    toVersion: cleanVersion(input.toVersion),
    locale: (input.locale ?? 'en').toLowerCase(),
    context: {
      platforms: [...new Set((input.context?.platforms ?? []).map(value => value.toLowerCase()))].sort(),
      features: [...new Set((input.context?.features ?? []).map(value => value.toLowerCase()))].sort(),
    },
  }
  const key = JSON.stringify(normalized)
  const hit = digestCache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl)
    return hit.promise
  const promise = invokeCapgoApi<ChangelogDigest>('private/changelog/digest', {
    method: 'POST',
    body: normalized,
    // Workers AI can take a few seconds; never retry a paid call.
    retries: 0,
  }).then(({ data, error }) => {
    if (error || !data) {
      digestCache.delete(key)
    }
    else if (!data.aiGenerated) {
      const cached = digestCache.get(key)
      if (cached)
        cached.ttl = 60_000
    }
    return error ? null : data
  })
  if (digestCache.size >= 100)
    digestCache.delete(digestCache.keys().next().value ?? '')
  digestCache.set(key, { at: Date.now(), ttl: RELEASES_CACHE_MS, promise })
  return promise
}

/** Case-insensitive match of every search word against a release's version and items. */
export function filterReleases(
  releases: ChangelogRelease[],
  query: string,
  types: Set<ChangelogSectionType>,
): ChangelogRelease[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  // Without filters every release stays, even one with no parsed notes (it shows its version and GitHub link).
  if (!words.length && types.size === 0)
    return releases
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
  const words = query.split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
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
