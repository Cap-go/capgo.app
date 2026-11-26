/*
 * Backfill missing Google Play and Apple App Store links from public.apps.app_id.
 *
 * Dry run:
 *   bun run admin:backfill-missing-store-urls
 *
 * Apply:
 *   bun run admin:backfill-missing-store-urls --apply
 *
 * Optional:
 *   bun run admin:backfill-missing-store-urls --apply --app-id=com.example.app
 *   bun run admin:backfill-missing-store-urls --apply --org-id=<uuid>
 *   bun run admin:backfill-missing-store-urls --apply --limit=100
 *   bun run admin:backfill-missing-store-urls --apply --concurrency=4
 *   bun run admin:backfill-missing-store-urls --apply --platform=android
 *   bun run admin:backfill-missing-store-urls --apply --platform=ios
 *   bun run admin:backfill-missing-store-urls --apply --apple-countries=all
 *   bun run admin:backfill-missing-store-urls --apply --apple-countries=us,fr,de
 *   bun run admin:backfill-missing-store-urls --apply --env-file=./internal/cloudflare/.env.preprod
 */
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import type pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { asyncPool, connectAdminDb, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_CONCURRENCY = 4
const DEFAULT_PAGE_SIZE = 1000
const FAILURE_OUTPUT = './tmp/missing_store_url_backfill_failures.json'
const MISS_OUTPUT = './tmp/missing_store_url_backfill_misses.json'
const RESULT_OUTPUT = './tmp/missing_store_url_backfill_results.json'
const USER_AGENT = 'Mozilla/5.0 (compatible; CapgoStoreUrlBackfillBot/1.0)'
const APPLE_FALLBACK_COUNTRIES = [
  'gb',
  'ca',
  'au',
  'fr',
  'de',
  'es',
  'it',
  'br',
  'jp',
  'kr',
  'in',
]

type AppStoreUrlRow = Pick<
  Database['public']['Tables']['apps']['Row'],
  'android_store_url' | 'app_id' | 'ios_store_url' | 'owner_org'
>
type StoreUrlUpdate = Partial<Pick<AppStoreUrlRow, 'android_store_url' | 'ios_store_url'>>

export type PlatformFilter = 'android' | 'both' | 'ios'
export type StorePlatform = 'android' | 'ios'

export interface StoreUrlFields {
  android_store_url: string | null
  ios_store_url: string | null
}

export interface AppleLookupResult {
  bundleId?: string
  trackViewUrl?: string
}

interface StoreUrlLookupResult {
  misses: StorePlatform[]
  update: StoreUrlUpdate
}

interface ProcessAppResult {
  misses: StorePlatform[]
  result: BackfillResult | null
  skippedAfterRecheck: boolean
}

interface BackfillResult {
  androidStoreUrl?: string
  appId: string
  iosStoreUrl?: string
  ownerOrg: string
  status: 'dry_run' | 'updated'
}

interface BackfillMiss {
  appId: string
  ownerOrg: string
  platform: StorePlatform
}

interface BackfillFailure {
  appId: string
  error: string
  ownerOrg: string
}

function printHelp() {
  console.log(`Backfill missing Google Play and Apple App Store links from public.apps.app_id.

Usage:
  bun run admin:backfill-missing-store-urls [options]

Options:
  --apply                    Update public.apps store URL columns. Without this, dry-run only.
  --app-id=APP_ID            Only inspect one app id.
  --org-id=UUID              Only inspect apps owned by one org.
  --limit=N                  Process at most N apps missing store URLs.
  --concurrency=N            Store lookup/update concurrency. Default: ${DEFAULT_CONCURRENCY}.
  --platform=android|ios|both
                             Only check one store platform. Default: both.
  --apple-countries=default  Use Apple lookup default storefront only. Default.
  --apple-countries=all      Try the default storefront, then common fallback storefronts.
  --apple-countries=us,fr    Try specific Apple storefront country codes.
  --env-file=PATH            Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --help                     Show this help.

Required env:
  MAIN_SUPABASE_DB_URL (or DATABASE_URL, SUPABASE_DB_URL, SUPABASE_DB_DIRECT_URL)
`)
}

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function extractMetaTag(html: string, name: string) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1])
      return decodeHtml(match[1])
  }

  return ''
}

function extractLinkHref(html: string, rel: string) {
  const patterns = [
    new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']+)["']`, 'i'),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${rel}["']`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1])
      return decodeHtml(match[1])
  }

  return ''
}

function extractTitle(html: string) {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return match?.[1] ? decodeHtml(match[1]) : ''
}

function getResponseContentType(response: Response) {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || ''
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
    },
  })

  if (response.status === 404 || response.status === 410)
    return null

  if (!response.ok)
    throw new Error(`Store lookup failed with HTTP ${response.status}`)

  const contentType = getResponseContentType(response)
  if (contentType && !contentType.includes('html'))
    throw new Error(`Store lookup returned ${contentType}`)

  return response.text()
}

export function isMissingStoreUrl(rawUrl: string | null | undefined) {
  return !rawUrl?.trim()
}

export function buildGooglePlayStoreUrl(appId: string) {
  const url = new URL('https://play.google.com/store/apps/details')
  url.searchParams.set('id', appId)
  return url.toString()
}

export function buildAppleLookupUrl(bundleId: string, country: string | null) {
  const url = new URL('https://itunes.apple.com/lookup')
  url.searchParams.set('bundleId', bundleId)
  if (country)
    url.searchParams.set('country', country)
  return url.toString()
}

function isGooglePlayUrlForAppId(rawUrl: string, appId: string) {
  try {
    const url = new URL(rawUrl)
    return url.hostname.toLowerCase() === 'play.google.com'
      && url.pathname === '/store/apps/details'
      && url.searchParams.get('id') === appId
  }
  catch {
    return false
  }
}

function htmlLooksLikeGooglePlayApp(html: string, appId: string) {
  const title = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title') || extractTitle(html)
  const image = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image')
  const canonicalUrl = extractMetaTag(html, 'og:url') || extractLinkHref(html, 'canonical')

  if (!title || !image)
    return false
  if (!canonicalUrl)
    return true

  return isGooglePlayUrlForAppId(canonicalUrl, appId)
}

async function findGooglePlayStoreUrl(appId: string) {
  const storeUrl = buildGooglePlayStoreUrl(appId)
  const html = await fetchHtml(storeUrl)
  if (!html)
    return null

  return htmlLooksLikeGooglePlayApp(html, appId) ? storeUrl : null
}

export function normalizeAppleStoreUrl(rawUrl: string | null | undefined) {
  const trimmed = rawUrl?.trim()
  if (!trimmed)
    return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'apps.apple.com')
      return null
    return url.toString()
  }
  catch {
    return null
  }
}

export function pickAppleLookupStoreUrl(results: AppleLookupResult[] | undefined, bundleId: string) {
  const result = results?.find(item => item.bundleId === bundleId && normalizeAppleStoreUrl(item.trackViewUrl))
  return normalizeAppleStoreUrl(result?.trackViewUrl)
}

async function findAppleStoreUrl(bundleId: string, countries: readonly (string | null)[]) {
  for (const country of countries) {
    const lookupUrl = buildAppleLookupUrl(bundleId, country)
    const response = await fetch(lookupUrl, {
      headers: {
        'accept': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': USER_AGENT,
      },
    })

    if (!response.ok)
      throw new Error(`Apple lookup failed with HTTP ${response.status}`)

    const data = await response.json() as { results?: AppleLookupResult[] }
    const storeUrl = pickAppleLookupStoreUrl(data.results, bundleId)
    if (storeUrl)
      return storeUrl
  }

  return null
}

export function parsePlatformFilter(rawValue: string | null): PlatformFilter {
  const value = rawValue?.trim().toLowerCase() || 'both'
  if (value === 'android' || value === 'both' || value === 'ios')
    return value

  throw new Error('--platform must be android, ios, or both')
}

export function parseAppleCountries(rawValue: string | null): Array<string | null> {
  const value = rawValue?.trim().toLowerCase() || 'default'
  if (value === 'default')
    return [null]
  if (value === 'all')
    return [null, ...APPLE_FALLBACK_COUNTRIES]

  const countries = value
    .split(',')
    .map(country => country.trim().toLowerCase())
    .filter(Boolean)

  if (countries.length === 0)
    throw new Error('--apple-countries must include at least one country code')

  for (const country of countries) {
    if (!/^[a-z]{2}$/.test(country))
      throw new Error('--apple-countries values must be ISO 3166-1 alpha-2 country codes')
  }

  return Array.from(new Set(countries))
}

function shouldCheckPlatform(platformFilter: PlatformFilter, platform: StorePlatform) {
  return platformFilter === 'both' || platformFilter === platform
}

export function getMissingStoreUrlPlatforms(app: StoreUrlFields, platformFilter: PlatformFilter) {
  const platforms: StorePlatform[] = []
  if (shouldCheckPlatform(platformFilter, 'android') && isMissingStoreUrl(app.android_store_url))
    platforms.push('android')
  if (shouldCheckPlatform(platformFilter, 'ios') && isMissingStoreUrl(app.ios_store_url))
    platforms.push('ios')
  return platforms
}

async function fetchApps(db: pg.Pool, filters: { appId: string | null, orgId: string | null }) {
  const rows: AppStoreUrlRow[] = []
  let offset = 0

  while (true) {
    const { rows: data } = await db.query<AppStoreUrlRow>(
      `SELECT android_store_url, app_id, ios_store_url, owner_org
       FROM public.apps
       WHERE ($1::text IS NULL OR app_id = $1) AND ($2::uuid IS NULL OR owner_org = $2::uuid)
       ORDER BY app_id ASC
       LIMIT $3 OFFSET $4`,
      [filters.appId, filters.orgId, DEFAULT_PAGE_SIZE, offset],
    )

    if (!data.length)
      break

    rows.push(...data)
    if (data.length < DEFAULT_PAGE_SIZE)
      break

    offset += DEFAULT_PAGE_SIZE
  }

  return rows
}

async function findStoreUrls(app: AppStoreUrlRow, platformFilter: PlatformFilter, appleCountries: readonly (string | null)[]): Promise<StoreUrlLookupResult> {
  const update: StoreUrlUpdate = {}
  const misses: StorePlatform[] = []
  const missingPlatforms = getMissingStoreUrlPlatforms(app, platformFilter)

  if (missingPlatforms.includes('android')) {
    const androidStoreUrl = await findGooglePlayStoreUrl(app.app_id)
    if (androidStoreUrl)
      update.android_store_url = androidStoreUrl
    else
      misses.push('android')
  }

  if (missingPlatforms.includes('ios')) {
    const iosStoreUrl = await findAppleStoreUrl(app.app_id, appleCountries)
    if (iosStoreUrl)
      update.ios_store_url = iosStoreUrl
    else
      misses.push('ios')
  }

  return { misses, update }
}

function hasStoreUrlUpdate(update: StoreUrlUpdate) {
  return !!(update.android_store_url || update.ios_store_url)
}

async function ensureStillMissingStoreUrls(db: pg.Pool, app: AppStoreUrlRow) {
  const { rows } = await db.query<AppStoreUrlRow>(
    `SELECT android_store_url, app_id, ios_store_url, owner_org
     FROM public.apps
     WHERE app_id = $1 AND owner_org = $2`,
    [app.app_id, app.owner_org],
  )

  return rows[0] ?? null
}

async function applyStoreUrls(db: pg.Pool, app: AppStoreUrlRow, update: StoreUrlUpdate) {
  const current = await ensureStillMissingStoreUrls(db, app)
  if (!current)
    return null

  const safeUpdate: StoreUrlUpdate = {}
  if (update.android_store_url && isMissingStoreUrl(current.android_store_url))
    safeUpdate.android_store_url = update.android_store_url
  if (update.ios_store_url && isMissingStoreUrl(current.ios_store_url))
    safeUpdate.ios_store_url = update.ios_store_url

  if (!hasStoreUrlUpdate(safeUpdate))
    return null

  // Unset fields in safeUpdate keep their current value.
  const { rowCount } = await db.query(
    `UPDATE public.apps
     SET android_store_url = COALESCE($1, android_store_url), ios_store_url = COALESCE($2, ios_store_url)
     WHERE app_id = $3 AND owner_org = $4`,
    [safeUpdate.android_store_url ?? null, safeUpdate.ios_store_url ?? null, app.app_id, app.owner_org],
  )

  if (!rowCount)
    throw new Error('App row disappeared before update')

  return safeUpdate
}

async function processApp(db: pg.Pool, app: AppStoreUrlRow, apply: boolean, platformFilter: PlatformFilter, appleCountries: readonly (string | null)[]): Promise<ProcessAppResult> {
  const lookup = await findStoreUrls(app, platformFilter, appleCountries)
  if (!hasStoreUrlUpdate(lookup.update))
    return { misses: lookup.misses, result: null, skippedAfterRecheck: false }

  if (!apply) {
    return {
      misses: lookup.misses,
      result: {
        androidStoreUrl: lookup.update.android_store_url ?? undefined,
        appId: app.app_id,
        iosStoreUrl: lookup.update.ios_store_url ?? undefined,
        ownerOrg: app.owner_org,
        status: 'dry_run',
      } satisfies BackfillResult,
      skippedAfterRecheck: false,
    }
  }

  const appliedUpdate = await applyStoreUrls(db, app, lookup.update)
  if (!appliedUpdate)
    return { misses: lookup.misses, result: null, skippedAfterRecheck: true }

  return {
    misses: lookup.misses,
    result: {
      androidStoreUrl: appliedUpdate.android_store_url ?? undefined,
      appId: app.app_id,
      iosStoreUrl: appliedUpdate.ios_store_url ?? undefined,
      ownerOrg: app.owner_org,
      status: 'updated',
    } satisfies BackfillResult,
    skippedAfterRecheck: false,
  }
}

export async function main() {
  if (process.argv.includes('--help')) {
    printHelp()
    return
  }

  const apply = process.argv.includes('--apply')
  const envFile = getArgValue(process.argv, '--env-file') ?? DEFAULT_ENV_FILE
  const appId = getArgValue(process.argv, '--app-id')
  const orgId = getArgValue(process.argv, '--org-id')
  const limit = getArgValue(process.argv, '--limit')
  const concurrency = parsePositiveInteger(getArgValue(process.argv, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)
  const parsedLimit = limit === null ? null : parsePositiveInteger(limit, '--limit', DEFAULT_PAGE_SIZE)
  const platformFilter = parsePlatformFilter(getArgValue(process.argv, '--platform'))
  const appleCountries = parseAppleCountries(getArgValue(process.argv, '--apple-countries'))

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...process.env,
  }
  const db = await connectAdminDb(env)
  try {
    await backfill(db, { apply, appId, appleCountries, concurrency, envFile, orgId, parsedLimit, platformFilter })
  }
  finally {
    await db.end()
  }
}

async function backfill(db: pg.Pool, { apply, appId, appleCountries, concurrency, envFile, orgId, parsedLimit, platformFilter }: {
  apply: boolean
  appId: string | null
  appleCountries: readonly (string | null)[]
  concurrency: number
  envFile: string
  orgId: string | null
  parsedLimit: number | null
  platformFilter: PlatformFilter
}) {
  const apps = await fetchApps(db, { appId, orgId })
  const missingApps = apps.filter(app => getMissingStoreUrlPlatforms(app, platformFilter).length > 0)
  const targetApps = parsedLimit === null ? missingApps : missingApps.slice(0, parsedLimit)
  const failures: BackfillFailure[] = []
  const misses: BackfillMiss[] = []
  const results: BackfillResult[] = []
  let skippedAfterRecheck = 0

  console.log(`Loaded ${apps.length} apps`)
  console.log(`Apps missing selected store URLs: ${missingApps.length}`)
  console.log(`Target apps: ${targetApps.length}`)
  console.log(`Env file: ${envFile}`)
  console.log(`Platform filter: ${platformFilter}`)
  console.log(`Apple storefront lookups: ${appleCountries.map(country => country ?? 'default').join(', ')}`)
  if (appId)
    console.log(`Scoped to app: ${appId}`)
  if (orgId)
    console.log(`Scoped to org: ${orgId}`)
  if (!apply)
    console.log('Dry run only. Pass --apply to update apps.')

  await asyncPool(concurrency, targetApps, async (app) => {
    try {
      const { misses: appMisses, result, skippedAfterRecheck: skipped } = await processApp(db, app, apply, platformFilter, appleCountries)
      misses.push(...appMisses.map(platform => ({
        appId: app.app_id,
        ownerOrg: app.owner_org,
        platform,
      })))

      if (!result) {
        if (skipped)
          skippedAfterRecheck++
        return
      }

      results.push(result)
      const found = [
        result.androidStoreUrl ? 'Google Play' : null,
        result.iosStoreUrl ? 'Apple App Store' : null,
      ].filter(Boolean).join(' and ')
      const verb = apply ? 'Updated' : 'Found'
      console.log(`${verb} ${app.app_id}: ${found}`)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({
        appId: app.app_id,
        error: message,
        ownerOrg: app.owner_org,
      })
      console.error(`Failed ${app.app_id}: ${message}`)
    }
  })

  console.log(`Done. ${apply ? 'Updated' : 'Found'} ${results.length}/${targetApps.length}. Misses: ${misses.length}. Skipped after recheck: ${skippedAfterRecheck}. Failures: ${failures.length}`)

  await mkdir('./tmp', { recursive: true })
  await writeFile(RESULT_OUTPUT, `${JSON.stringify(results, null, 2)}\n`)
  await writeFile(MISS_OUTPUT, `${JSON.stringify(misses, null, 2)}\n`)
  console.log(`Result details written to ${RESULT_OUTPUT}`)
  console.log(`Miss details written to ${MISS_OUTPUT}`)

  if (failures.length > 0) {
    await writeFile(FAILURE_OUTPUT, `${JSON.stringify(failures, null, 2)}\n`)
    console.log(`Failure details written to ${FAILURE_OUTPUT}`)
    if (apply)
      throw new Error(`Missing store URL backfill completed with ${failures.length} failures`)
  }
}

if (import.meta.main)
  await main()
