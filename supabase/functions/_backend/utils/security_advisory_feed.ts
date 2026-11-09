import type { Context } from 'hono'
import type { Advisory, AdvisoryFeed } from '../../shared/security_advisory.ts'
import { CacheHelper } from './cache.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

/** Host base for GET {BASE}/v1/advisories (unset until provisioned). */
export const SECURITY_ADVISORIES_BASE_URL_ENV = 'SECURITY_ADVISORIES_BASE_URL'

const ADVISORY_FEED_CACHE_PATH = '/private/security-advisories-feed'
const ADVISORY_FEED_CACHE_TTL_SECONDS = 120

const FIXTURE_GENERATED_AT = '2026-01-15T00:00:00.000Z'

const EXAMPLE_GHSA_ID = 'GHSA-example-0000'

/**
 * Example fixture only. Published advisories only; replace via SECURITY_ADVISORIES_BASE_URL when live.
 */
const FIXTURE_ADVISORY_FEED: AdvisoryFeed = {
  generated_at: FIXTURE_GENERATED_AT,
  advisories: [
    {
      id: EXAMPLE_GHSA_ID,
      ghsa_id: EXAMPLE_GHSA_ID,
      title: 'EXAMPLE: demonstration advisory only (not a real CVE)',
      severity: 'high',
      affected: [
        {
          package: '@capacitor/core',
          affected_range: '>= 6.0.0, < 6.2.0',
          patched_version: '6.2.0',
        },
        {
          package: '@capacitor/core',
          affected_range: '>= 7.0.0, < 7.2.1',
          patched_version: '7.2.1',
        },
        {
          package: '@capgo/cli',
          affected_range: '< 2.0.0',
          patched_version: '2.0.0',
        },
      ],
      fix_steps: '## Example only\n\nUpgrade affected packages to the patched versions listed for your major line.',
      published_at: '2026-01-15T00:00:00.000Z',
      url: 'https://capgo.app/security/',
    },
  ],
}

const ADVISORY_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical'])

function isAdvisoryAffected(value: unknown): value is Advisory['affected'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const row = value as Record<string, unknown>
  const patchedOk = row.patched_version === null
    || (typeof row.patched_version === 'string' && row.patched_version.length > 0)
  return typeof row.package === 'string'
    && typeof row.affected_range === 'string'
    && patchedOk
}

function isAdvisory(value: unknown): value is Advisory {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.ghsa_id !== 'string' || row.id !== row.ghsa_id)
    return false
  if (typeof row.title !== 'string' || typeof row.severity !== 'string' || !ADVISORY_SEVERITIES.has(row.severity))
    return false
  if (!Array.isArray(row.affected) || !row.affected.every(isAdvisoryAffected))
    return false
  if (typeof row.fix_steps !== 'string' || typeof row.published_at !== 'string' || typeof row.url !== 'string')
    return false
  if (row.plus_release_url !== undefined && typeof row.plus_release_url !== 'string')
    return false
  if (row.cve_id !== undefined && typeof row.cve_id !== 'string')
    return false
  return true
}

function isAdvisoryFeed(value: unknown): value is AdvisoryFeed {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const record = value as Record<string, unknown>
  return typeof record.generated_at === 'string'
    && Array.isArray(record.advisories)
    && record.advisories.every(isAdvisory)
}

function advisoryFeedUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/advisories`
}

async function fetchAdvisoryFeed(c: Context, url: string): Promise<AdvisoryFeed> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(`advisory feed HTTP ${response.status}`)
  const payload = await response.json()
  if (!isAdvisoryFeed(payload))
    throw new Error('advisory feed invalid JSON shape')
  return payload
}

export interface SecurityAdvisoryFeedLoader {
  loadFeed(c: Context): Promise<AdvisoryFeed>
}

export const configurableSecurityAdvisoryFeedLoader: SecurityAdvisoryFeedLoader = {
  async loadFeed(c) {
    const base = getEnv(c, SECURITY_ADVISORIES_BASE_URL_ENV).trim()
    const cache = new CacheHelper(c)
    const cacheKey = cache.buildRequest(ADVISORY_FEED_CACHE_PATH, { base: base || 'fixture' })
    const cached = await cache.matchJson<AdvisoryFeed>(cacheKey)
    if (cached)
      return cached

    if (!base) {
      await cache.putJson(cacheKey, FIXTURE_ADVISORY_FEED, ADVISORY_FEED_CACHE_TTL_SECONDS)
      return FIXTURE_ADVISORY_FEED
    }

    const url = advisoryFeedUrl(base)
    try {
      const feed = await fetchAdvisoryFeed(c, url)
      await cache.putJson(cacheKey, feed, ADVISORY_FEED_CACHE_TTL_SECONDS)
      return feed
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'advisory feed fetch failed',
        url,
        error: serializeError(error),
      })
      await cache.putJson(cacheKey, FIXTURE_ADVISORY_FEED, 30)
      return FIXTURE_ADVISORY_FEED
    }
  },
}

let activeLoader: SecurityAdvisoryFeedLoader = configurableSecurityAdvisoryFeedLoader

export function setSecurityAdvisoryFeedLoader(loader: SecurityAdvisoryFeedLoader) {
  activeLoader = loader
}

export function getSecurityAdvisoryFeedLoader(): SecurityAdvisoryFeedLoader {
  return activeLoader
}

export async function loadSecurityAdvisoryFeed(c: Context): Promise<AdvisoryFeed> {
  return await getSecurityAdvisoryFeedLoader().loadFeed(c)
}

export function fixtureAdvisoryFeedForTests(): AdvisoryFeed {
  return structuredClone(FIXTURE_ADVISORY_FEED)
}
