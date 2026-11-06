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

const BULLET = /^[-*+]\s/
const SECTION_ORDER: ChangelogSectionType[] = ['security', 'removed', 'added', 'changed', 'fixed', 'deprecated', 'other']

function cleanItem(line: string) {
  return line.slice(1).replaceAll(/\s+/g, ' ').trim().slice(0, MAX_ITEM_LENGTH)
}

function headingText(line: string): string | null {
  if (!line.startsWith('#'))
    return null
  const text = line.replace(/^#+/, '')
  return text.startsWith(' ') ? text.trim() : null
}

/** Footer: a "---" rule then the "Full Changelog" compare link. */
function isFooter(line: string) {
  return /^-{3,}$/.test(line) || line.toLowerCase().includes('full changelog')
}

/** Parse one release body into typed sections; unknown prose lands in "other". */
export function parseReleaseBody(body: string | null | undefined): ChangelogSection[] {
  if (!body)
    return []
  const sections = new Map<ChangelogSectionType, string[]>()
  let current: ChangelogSectionType = 'other'
  for (const line of body.split(/\r?\n/).map(raw => raw.trim())) {
    if (isFooter(line))
      break
    const heading = headingText(line)
    if (heading !== null) {
      current = sectionTypeFromHeading(heading) ?? current
      continue
    }
    const item = BULLET.test(line) ? cleanItem(line) : ''
    if (!item)
      continue
    const items = sections.get(current) ?? []
    if (items.length < MAX_ITEMS_PER_SECTION)
      items.push(item)
    sections.set(current, items)
  }
  return SECTION_ORDER
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
const ACTION_PATTERN = /\b(breaking change|deprecated|migration (?:note|guide|required)|action required|(?:you )?must (?:now )?(?:set|update|upgrade|migrate|add|use|change|enable)|you need to)\b/i
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
  const byName = (a: string, b: string) => a.localeCompare(b)
  return { platforms: platforms.toSorted(byName), features: features.toSorted(byName) }
}

function mentions(item: string, needles: string[]) {
  const lower = item.toLowerCase()
  return needles.some(needle => lower.includes(needle))
}

function firstSentence(item: string) {
  if (item.startsWith('**')) {
    const close = item.indexOf('**', 2)
    if (close > 2)
      return { title: item.slice(2, close).replace(/[.:]$/, ''), detail: item.slice(close + 2).trim() }
  }
  const cut = item.search(/[.:;]\s/)
  if (cut > 20 && cut < 120)
    return { title: item.slice(0, cut), detail: item.slice(cut + 1).trim() }
  if (item.length > 110)
    return { title: `${item.slice(0, 107)}…`, detail: item }
  return { title: item, detail: '' }
}

const SECTION_SCORE: Record<ChangelogSectionType, number> = { security: 3, removed: 3, added: 2, changed: 1, fixed: 0.5, deprecated: 0.5, other: 0.5 }

function impactForScore(score: number): DigestImpact {
  if (score >= 3)
    return 'high'
  if (score >= 2)
    return 'medium'
  return 'low'
}

/** Items the developer must act on: every breaking or deprecated entry, plus explicit migration wording. */
export function requiredActions(releases: ChangelogRelease[]): string[] {
  return releases.flatMap(release => release.sections.flatMap((section) => {
    if (section.type === 'removed' || section.type === 'deprecated')
      return section.items
    return section.items.filter(item => ACTION_PATTERN.test(item))
  }))
}

function rankHighlights(releases: ChangelogRelease[], needles: string[]) {
  const scored: Array<DigestHighlight & { score: number }> = []
  for (const release of releases) {
    for (const section of release.sections) {
      const base = SECTION_SCORE[section.type]
      for (const item of section.items) {
        const relevant = needles.length > 0 && mentions(item, needles)
        scored.push({ ...firstSentence(item), type: section.type, version: release.version, impact: impactForScore(base), relevant, score: base + (relevant ? 2 : 0) })
      }
    }
  }
  return scored.toSorted((a, b) => b.score - a.score).map(({ score: _score, ...highlight }) => highlight)
}

function fallbackHeadline(counts: Record<ChangelogSectionType, number>, total: number, fromVersion: string | null) {
  if (total === 0)
    return 'You are on the latest version.'
  const releases = total === 1 ? '1 release' : `${total} releases`
  const parts = [`${counts.added} new`, `${counts.changed} improved`, `${counts.fixed} fixed`]
  if (counts.security)
    parts.push(`${counts.security} security`)
  return `${releases} since ${fromVersion ?? 'your version'}: ${parts.join(', ')}.`
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
  return {
    product,
    repo,
    fromVersion,
    toVersion: toVersion ?? releases[0]?.version ?? null,
    releaseCount: releases.length,
    counts,
    headline: fallbackHeadline(counts, releases.length, fromVersion),
    highlights: rankHighlights(releases, [...context.platforms, ...context.features]).slice(0, maxHighlights),
    actionRequired: requiredActions(releases).slice(0, 4),
    aiGenerated: false,
  }
}

const MAX_PROMPT_ITEM_CHARS = 400

/**
 * Compact text sent to the model: newest first, capped so one digest stays cheap.
 * `included` lists the versions that fit, so the caller can keep what the
 * model never saw (required actions, security fixes) from the deterministic digest.
 */
export function releasesToPromptText(releases: ChangelogRelease[], maxChars = 12_000) {
  let text = ''
  const included = new Set<string>()
  for (const release of releases) {
    const lines = [`## ${release.version} (${release.date.slice(0, 10)})`]
    for (const section of release.sections)
      lines.push(...section.items.map(item => `- [${section.type}] ${item.slice(0, MAX_PROMPT_ITEM_CHARS)}`))
    let chunk = `${lines.join('\n')}\n`
    if (text.length + chunk.length > maxChars) {
      // A single huge release still goes in, cut to the budget, so the prompt is never empty.
      if (included.size > 0)
        break
      chunk = chunk.slice(0, maxChars)
    }
    text += chunk
    included.add(release.version)
  }
  return { text, included }
}
