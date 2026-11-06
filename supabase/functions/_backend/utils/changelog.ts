import type { SemVer } from '@std/semver'
import { compare, tryParse } from '@std/semver'

/**
 * Release notes shared by the console changelog page, the "what's new since
 * your version" digest and the console update modal. Every Capgo product
 * publishes GitHub releases with the same markdown shape:
 *
 *   ## 🆕 Changelog
 *   ## Added
 *   - item
 *   ## Fixed
 *   - item
 *   ---
 *   🔗 **Full Changelog**: ...
 */

export type ChangelogProduct = 'console' | 'cli' | 'updater' | 'plugin'
export type ChangelogSectionType = 'added' | 'changed' | 'fixed' | 'security' | 'removed' | 'deprecated' | 'other'

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

export interface ChangelogSource {
  repo: string
  tagPrefix: string
}

export const CHANGELOG_PRODUCTS: ChangelogProduct[] = ['console', 'cli', 'updater', 'plugin']

const GITHUB_REPO_NAME = /^[\w.-]{1,100}$/
const MAX_ITEM_LENGTH = 600
const MAX_ITEMS_PER_SECTION = 40

export function isChangelogProduct(value: unknown): value is ChangelogProduct {
  return typeof value === 'string' && (CHANGELOG_PRODUCTS as string[]).includes(value)
}

/** Only repos owned by the Cap-go org are ever fetched: the repo name is user input. */
export function isValidPluginRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && GITHUB_REPO_NAME.test(repo) && !repo.startsWith('.')
}

export function changelogSource(product: ChangelogProduct, pluginRepo?: string): ChangelogSource | null {
  switch (product) {
    case 'console':
      return { repo: 'capgo.app', tagPrefix: 'capgo-' }
    case 'cli':
      return { repo: 'capgo.app', tagPrefix: 'cli-' }
    case 'updater':
      return { repo: 'capacitor-updater', tagPrefix: '' }
    case 'plugin':
      return isValidPluginRepo(pluginRepo) ? { repo: pluginRepo, tagPrefix: '' } : null
  }
}

export function sectionTypeFromHeading(heading: string): ChangelogSectionType | null {
  const normalized = heading.toLowerCase().replace(/[^a-z\s]/g, ' ').trim()
  if (!normalized || normalized === 'changelog')
    return null
  if (/\b(added|new|features?)\b/.test(normalized))
    return 'added'
  if (/\b(fixed|fix|fixes|bug)\b/.test(normalized))
    return 'fixed'
  if (/\bsecurity\b/.test(normalized))
    return 'security'
  if (/\b(removed|breaking)\b/.test(normalized))
    return 'removed'
  if (/\bdeprecat/.test(normalized))
    return 'deprecated'
  if (/\b(changed|improved|improvements?|performance|updated?)\b/.test(normalized))
    return 'changed'
  return 'other'
}

function cleanItem(line: string) {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ITEM_LENGTH)
}

/** Parse one release body into typed sections; unknown prose lands in "other". */
export function parseReleaseBody(body: string | null | undefined): ChangelogSection[] {
  if (!body)
    return []
  const sections = new Map<ChangelogSectionType, string[]>()
  let current: ChangelogSectionType = 'other'
  for (const rawLine of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line)
      continue
    // Footer: "---" then the compare link.
    if (/^-{3,}$/.test(line) || /full changelog/i.test(line))
      break
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      const type = sectionTypeFromHeading(heading[1])
      if (type)
        current = type
      continue
    }
    if (!/^[-*+]\s+/.test(line))
      continue
    const item = cleanItem(line)
    if (!item)
      continue
    const items = sections.get(current) ?? []
    if (items.length < MAX_ITEMS_PER_SECTION)
      items.push(item)
    sections.set(current, items)
  }
  const order: ChangelogSectionType[] = ['security', 'removed', 'added', 'changed', 'fixed', 'deprecated', 'other']
  return order
    .filter(type => sections.get(type)?.length)
    .map(type => ({ type, items: sections.get(type)! }))
}

export function versionFromTag(tag: string, tagPrefix: string): string | null {
  if (tagPrefix && !tag.startsWith(tagPrefix))
    return null
  const version = tag.slice(tagPrefix.length).replace(/^v/, '')
  return tryParse(version) ? version : null
}

export interface GithubReleaseLike {
  tag_name?: string
  html_url?: string
  body?: string | null
  published_at?: string | null
  created_at?: string | null
  draft?: boolean
  prerelease?: boolean
}

export function normalizeReleases(releases: GithubReleaseLike[], tagPrefix: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = []
  for (const release of releases) {
    if (!release || release.draft || release.prerelease || !release.tag_name)
      continue
    const version = versionFromTag(release.tag_name, tagPrefix)
    if (!version)
      continue
    // Prerelease semver (rc, beta) is noise for customers reading "what's new".
    const parsed = tryParse(version)
    if (!parsed || parsed.prerelease?.length)
      continue
    out.push({
      version,
      tag: release.tag_name,
      date: release.published_at ?? release.created_at ?? '',
      url: release.html_url ?? '',
      sections: parseReleaseBody(release.body),
    })
  }
  return sortReleasesDesc(out)
}

export function sortReleasesDesc(releases: ChangelogRelease[]): ChangelogRelease[] {
  return [...releases].sort((a, b) => {
    const left = tryParse(a.version)
    const right = tryParse(b.version)
    if (left && right)
      return compare(right, left)
    return b.date.localeCompare(a.date)
  })
}

function parseOrNull(version: string | null | undefined): SemVer | null {
  if (!version)
    return null
  return tryParse(version.trim().replace(/^[v^~]/, '')) ?? null
}

/** Releases strictly newer than `fromVersion` and up to `toVersion` (inclusive) when given. */
export function releasesBetween(releases: ChangelogRelease[], fromVersion: string | null | undefined, toVersion?: string | null): ChangelogRelease[] {
  const from = parseOrNull(fromVersion)
  const to = parseOrNull(toVersion)
  return releases.filter((release) => {
    const version = tryParse(release.version)
    if (!version)
      return false
    if (from && compare(version, from) <= 0)
      return false
    if (to && compare(version, to) > 0)
      return false
    return true
  })
}

export function countSections(releases: ChangelogRelease[]): Record<ChangelogSectionType, number> {
  const counts: Record<ChangelogSectionType, number> = { added: 0, changed: 0, fixed: 0, security: 0, removed: 0, deprecated: 0, other: 0 }
  for (const release of releases) {
    for (const section of release.sections)
      counts[section.type] += section.items.length
  }
  return counts
}

export type DigestImpact = 'high' | 'medium' | 'low'

export interface DigestHighlight {
  title: string
  detail: string
  type: ChangelogSectionType
  version: string
  impact: DigestImpact
  relevant: boolean
}

export interface ChangelogDigestContext {
  platforms: string[]
  features: string[]
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
}

// Only explicit calls to act: words like "no longer" or "removed" also describe ordinary fixes.
const ACTION_PATTERN = /\b(breaking change|deprecated|migrate|migration|must (?:now )?(?:set|update|upgrade|migrate|add|use|change)|action required)\b/i
const ALLOWED_PLATFORMS = new Set(['ios', 'android', 'electron', 'web'])
const FEATURE_PATTERN = /^[\w\s./-]{1,40}$/

/** Client-sent context is folded into the AI prompt, so it is clamped to short known-safe tokens. */
export function sanitizeDigestContext(value: unknown): ChangelogDigestContext {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const platforms = Array.isArray(record.platforms)
    ? [...new Set(record.platforms.filter((p): p is string => typeof p === 'string').map(p => p.toLowerCase()).filter(p => ALLOWED_PLATFORMS.has(p)))]
    : []
  const features = Array.isArray(record.features)
    ? [...new Set(record.features.filter((f): f is string => typeof f === 'string' && FEATURE_PATTERN.test(f)).map(f => f.trim().toLowerCase()))].slice(0, 12)
    : []
  return { platforms: platforms.sort(), features: features.sort() }
}

function mentions(item: string, needles: string[]) {
  const lower = item.toLowerCase()
  return needles.some(needle => lower.includes(needle))
}

function firstSentence(item: string) {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(item)
  if (bold)
    return { title: bold[1].replace(/[.:]$/, ''), detail: bold[2] }
  const cut = item.search(/[.:;]\s/)
  if (cut > 20 && cut < 120)
    return { title: item.slice(0, cut), detail: item.slice(cut + 1).trim() }
  return { title: item.length > 110 ? `${item.slice(0, 107)}…` : item, detail: item.length > 110 ? item : '' }
}

/**
 * Deterministic digest used when Workers AI is unavailable or fails, and as
 * the candidate list handed to the model. Security and breaking changes come
 * first, then features, then fixes that mention the user's platforms.
 */
export function buildFallbackDigest(
  product: ChangelogProduct,
  repo: string,
  releases: ChangelogRelease[],
  fromVersion: string | null,
  toVersion: string | null,
  context: ChangelogDigestContext,
  maxHighlights = 6,
): ChangelogDigest {
  const counts = countSections(releases)
  const needles = [...context.platforms, ...context.features]
  const scored: Array<DigestHighlight & { score: number }> = []
  for (const release of releases) {
    for (const section of release.sections) {
      for (const item of section.items) {
        const relevant = needles.length > 0 && mentions(item, needles)
        const base = section.type === 'security' || section.type === 'removed'
          ? 3
          : section.type === 'added' ? 2 : section.type === 'changed' ? 1 : 0.5
        const impact: DigestImpact = base >= 3 ? 'high' : base >= 2 ? 'medium' : 'low'
        const { title, detail } = firstSentence(item)
        scored.push({ title, detail, type: section.type, version: release.version, impact, relevant, score: base + (relevant ? 2 : 0) })
      }
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const highlights = scored.slice(0, maxHighlights).map(({ score: _score, ...highlight }) => highlight)
  const actionRequired = releases
    .flatMap(release => release.sections.flatMap(section => section.type === 'removed' || section.type === 'deprecated'
      ? section.items
      : section.items.filter(item => ACTION_PATTERN.test(item))))
    .slice(0, 4)
  const total = releases.length
  const headline = total === 0
    ? 'You are on the latest version.'
    : `${total} release${total === 1 ? '' : 's'} since ${fromVersion ?? 'your version'}: ${counts.added} new, ${counts.changed} improved, ${counts.fixed} fixed${counts.security ? `, ${counts.security} security` : ''}.`
  return {
    product,
    repo,
    fromVersion,
    toVersion: toVersion ?? releases[0]?.version ?? null,
    releaseCount: total,
    counts,
    headline,
    highlights,
    actionRequired,
    aiGenerated: false,
  }
}

/** Compact text sent to the model: newest first, capped so one digest stays cheap. */
export function releasesToPromptText(releases: ChangelogRelease[], maxChars = 12_000) {
  let text = ''
  for (const release of releases) {
    const block = [`## ${release.version} (${release.date.slice(0, 10)})`]
    for (const section of release.sections)
      block.push(...section.items.map(item => `- [${section.type}] ${item}`))
    const chunk = `${block.join('\n')}\n`
    if (text.length + chunk.length > maxChars)
      break
    text += chunk
  }
  return text
}
