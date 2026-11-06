/*
 * Backfill missing app icons from Google Play or the Apple App Store.
 *
 * Dry run:
 *   bun run admin:backfill-missing-app-icons
 *
 * Apply:
 *   bun run admin:backfill-missing-app-icons --apply
 *
 * Optional:
 *   bun run admin:backfill-missing-app-icons --apply --app-id=com.example.app
 *   bun run admin:backfill-missing-app-icons --apply --org-id=<uuid>
 *   bun run admin:backfill-missing-app-icons --apply --limit=100
 *   bun run admin:backfill-missing-app-icons --apply --concurrency=4
 *   bun run admin:backfill-missing-app-icons --apply --verify-storage
 *   bun run admin:backfill-missing-app-icons --apply --env-file=./internal/cloudflare/.env.preprod
 */
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { mkdir } from 'node:fs/promises'
import type { ImageStore } from './admin_image_storage.ts'
import { createImageStore } from './admin_image_storage.ts'
import { asyncPool, createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DEFAULT_CONCURRENCY = 4
const DEFAULT_PAGE_SIZE = 1000
const FAILURE_OUTPUT = './tmp/missing_app_icon_backfill_failures.json'
const RESULT_OUTPUT = './tmp/missing_app_icon_backfill_results.json'
const MAX_ICON_BYTES = 5 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (compatible; CapgoIconBackfillBot/1.0)'
const STORAGE_IMAGE_PATH_REGEX = /^\/storage\/v1\/object(?:\/public|\/sign)?\/images\//
const DEFAULT_ICON_VALUES = new Set([
  '',
  'capgo.png',
  '/capgo.png',
  'public/capgo.png',
  '/public/capgo.png',
])
const GOOGLE_IMAGE_HOSTS = new Set([
  'play-lh.googleusercontent.com',
  'play.googleusercontent.com',
])

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>
// Icons are stored in R2 (S3_* env vars), not Supabase Storage.
let images: ImageStore
type AppIconRow = Pick<
  Database['public']['Tables']['apps']['Row'],
  'android_store_url' | 'app_id' | 'icon_url' | 'ios_store_url' | 'name' | 'owner_org'
>

interface AppleLookupResult {
  artworkUrl100?: string
  artworkUrl512?: string
  bundleId?: string
  trackName?: string
  trackViewUrl?: string
}

interface StoreIconCandidate {
  iconUrl: string
  name: string | null
  source: 'apple_app_store' | 'google_play'
  storeUrl: string
}

interface DownloadedIcon {
  bytes: ArrayBuffer
  contentType: string
  sourceUrl: string
}

interface BackfillResult {
  appId: string
  contentType: string
  iconUrl: string
  source: StoreIconCandidate['source']
  status: 'dry_run' | 'updated'
  storeUrl: string
  storagePath: string
}

interface BackfillFailure {
  appId: string
  error: string
  ownerOrg: string
}

function printHelp() {
  console.log(`Backfill missing app icons from Google Play or the Apple App Store.

Usage:
  bun run admin:backfill-missing-app-icons [options]

Options:
  --apply             Upload icons and update public.apps.icon_url. Without this, dry-run only.
  --app-id=APP_ID     Only inspect one app id.
  --org-id=UUID       Only inspect apps owned by one org.
  --limit=N           Process at most N missing-icon apps.
  --concurrency=N     Store lookup/upload concurrency. Default: ${DEFAULT_CONCURRENCY}.
  --verify-storage    Also treat existing storage paths as missing when the object is absent.
  --env-file=PATH     Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --help              Show this help.

Required env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

function extractTitle(html: string) {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return match?.[1] ? decodeHtml(match[1]) : ''
}

function normalizeGooglePlayName(name: string) {
  return name
    .replace(/\s*[-|:]\s*Apps on Google Play\s*$/i, '')
    .replace(/\s*[-|:]\s*Google Play\s*$/i, '')
    .trim()
}

function normalizeIconPath(rawIconUrl: string | null) {
  const trimmed = rawIconUrl?.trim() ?? ''

  try {
    const url = new URL(trimmed)
    return decodeURIComponent(url.pathname)
      .replace(STORAGE_IMAGE_PATH_REGEX, '')
      .replace(/^\/+/, '')
  }
  catch {
    return trimmed.replace(/^images\//, '').replace(/^\/+/, '')
  }
}

function isExternalIconUrl(rawIconUrl: string | null) {
  const trimmed = rawIconUrl?.trim() ?? ''
  if (!trimmed)
    return false

  try {
    const url = new URL(trimmed)
    return !STORAGE_IMAGE_PATH_REGEX.test(url.pathname)
  }
  catch {
    return false
  }
}

function isDefaultIcon(rawIconUrl: string | null) {
  const normalized = normalizeIconPath(rawIconUrl)
  return DEFAULT_ICON_VALUES.has(normalized) || normalized.endsWith('/public/capgo.png')
}

function getAppIconStoragePath(ownerOrg: string, appId: string) {
  return `org/${ownerOrg}/${appId}/icon`
}

function getAllowedStoreUrl(rawUrl: string, allowedHosts: Set<string>) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()))
      return null
    return url
  }
  catch {
    return null
  }
}

function isAllowedIconUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:'
      && (GOOGLE_IMAGE_HOSTS.has(host) || host === 'mzstatic.com' || host.endsWith('.mzstatic.com'))
  }
  catch {
    return false
  }
}

function extractAppleStoreId(url: URL) {
  const pathMatch = /\/id(\d+)(?:[/?#]|$)/i.exec(url.pathname)
  const queryId = url.searchParams.get('id')?.trim()
  return pathMatch?.[1] ?? queryId ?? null
}

function extractAppleCountry(url: URL) {
  const country = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase()
  return country && /^[a-z]{2}$/.test(country) ? country : null
}

function buildGooglePlayUrl(appId: string) {
  const url = new URL('https://play.google.com/store/apps/details')
  url.searchParams.set('id', appId)
  url.searchParams.set('hl', 'en')
  url.searchParams.set('gl', 'US')
  return url.toString()
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok)
    return null

  return response.text()
}

async function fetchGooglePlayCandidate(storeUrl: string): Promise<StoreIconCandidate | null> {
  if (!getAllowedStoreUrl(storeUrl, new Set(['play.google.com'])))
    return null

  const html = await fetchHtml(storeUrl)
  if (!html)
    return null

  const iconUrl = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image')
  if (!iconUrl || !isAllowedIconUrl(iconUrl))
    return null

  const rawName = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title') || extractTitle(html)

  return {
    iconUrl,
    name: rawName ? normalizeGooglePlayName(rawName) : null,
    source: 'google_play',
    storeUrl,
  }
}

async function fetchAppleLookupCandidate(params: { bundleId?: string, country?: string | null, storeId?: string }): Promise<StoreIconCandidate | null> {
  const url = new URL('https://itunes.apple.com/lookup')
  if (params.storeId)
    url.searchParams.set('id', params.storeId)
  else if (params.bundleId)
    url.searchParams.set('bundleId', params.bundleId)
  else
    return null

  if (params.country)
    url.searchParams.set('country', params.country)

  const response = await fetch(url.toString(), {
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok)
    return null

  const data = await response.json() as { results?: AppleLookupResult[] }
  const result = data.results?.[0]
  const iconUrl = result?.artworkUrl512?.trim() || result?.artworkUrl100?.trim() || ''
  if (!iconUrl || !isAllowedIconUrl(iconUrl))
    return null

  return {
    iconUrl,
    name: result?.trackName?.trim() || null,
    source: 'apple_app_store',
    storeUrl: result?.trackViewUrl?.trim() || url.toString(),
  }
}

async function fetchAppleStoreUrlCandidate(storeUrl: string) {
  const url = getAllowedStoreUrl(storeUrl, new Set(['apps.apple.com', 'itunes.apple.com']))
  if (!url)
    return null

  const storeId = extractAppleStoreId(url)
  const country = extractAppleCountry(url)
  if (storeId) {
    const lookupCandidate = await fetchAppleLookupCandidate({ country, storeId })
    if (lookupCandidate)
      return lookupCandidate
  }

  const html = await fetchHtml(storeUrl)
  if (!html)
    return null

  const iconUrl = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image')
  if (!iconUrl || !isAllowedIconUrl(iconUrl))
    return null

  return {
    iconUrl,
    name: extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title') || extractTitle(html) || null,
    source: 'apple_app_store',
    storeUrl,
  } satisfies StoreIconCandidate
}

async function findStoreIcon(app: AppIconRow) {
  const candidates: Array<() => Promise<StoreIconCandidate | null>> = []
  const androidStoreUrl = app.android_store_url?.trim()
  const iosStoreUrl = app.ios_store_url?.trim()

  if (androidStoreUrl)
    candidates.push(() => fetchGooglePlayCandidate(androidStoreUrl))
  if (iosStoreUrl)
    candidates.push(() => fetchAppleStoreUrlCandidate(iosStoreUrl))

  candidates.push(() => fetchGooglePlayCandidate(buildGooglePlayUrl(app.app_id)))
  candidates.push(() => fetchAppleLookupCandidate({ bundleId: app.app_id }))

  for (const candidate of candidates) {
    const result = await candidate()
    if (result)
      return result
  }

  return null
}

function getHeaderContentType(response: Response) {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || ''
}

async function downloadIcon(iconUrl: string): Promise<DownloadedIcon | null> {
  if (!isAllowedIconUrl(iconUrl))
    return null

  const response = await fetch(iconUrl, {
    headers: {
      'accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok)
    return null

  const contentType = getHeaderContentType(response)
  if (!contentType.startsWith('image/'))
    return null

  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES)
    throw new Error(`Icon is too large: ${contentLength} bytes`)

  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0)
    return null
  if (bytes.byteLength > MAX_ICON_BYTES)
    throw new Error(`Icon is too large: ${bytes.byteLength} bytes`)

  return {
    bytes,
    contentType,
    sourceUrl: iconUrl,
  }
}

async function storageObjectExists(supabase: SupabaseClient, rawPath: string | null) {
  if (isExternalIconUrl(rawPath))
    return true

  const path = normalizeIconPath(rawPath)
  if (!path || isDefaultIcon(path))
    return false

  return images.exists(path)
}

async function fetchApps(supabase: SupabaseClient, filters: { appId: string | null, orgId: string | null }) {
  const rows: AppIconRow[] = []
  let offset = 0

  while (true) {
    let query = supabase
      .from('apps')
      .select('android_store_url, app_id, icon_url, ios_store_url, name, owner_org')
      .order('app_id', { ascending: true })
      .range(offset, offset + DEFAULT_PAGE_SIZE - 1)

    if (filters.appId)
      query = query.eq('app_id', filters.appId)
    if (filters.orgId)
      query = query.eq('owner_org', filters.orgId)

    const { data, error } = await query
    if (error)
      throw error

    if (!data?.length)
      break

    rows.push(...data)
    if (data.length < DEFAULT_PAGE_SIZE)
      break

    offset += DEFAULT_PAGE_SIZE
  }

  return rows
}

async function getMissingIconApps(supabase: SupabaseClient, apps: AppIconRow[], verifyStorage: boolean, concurrency: number) {
  if (!verifyStorage)
    return apps.filter(app => isDefaultIcon(app.icon_url))

  const missing: AppIconRow[] = []
  await asyncPool(concurrency, apps, async (app) => {
    if (isDefaultIcon(app.icon_url)) {
      missing.push(app)
      return
    }

    const exists = await storageObjectExists(supabase, app.icon_url)
    if (!exists)
      missing.push(app)
  })

  return missing
}

async function ensureStillMissingIcon(supabase: SupabaseClient, app: AppIconRow, verifyStorage: boolean) {
  const { data, error } = await supabase
    .from('apps')
    .select('android_store_url, app_id, icon_url, ios_store_url, name, owner_org')
    .eq('app_id', app.app_id)
    .eq('owner_org', app.owner_org)
    .maybeSingle()

  if (error)
    throw error
  if (!data)
    return false
  if (isDefaultIcon(data.icon_url))
    return true
  if (!verifyStorage)
    return false

  return !(await storageObjectExists(supabase, data.icon_url))
}

async function applyIcon(supabase: SupabaseClient, app: AppIconRow, candidate: StoreIconCandidate, icon: DownloadedIcon, verifyStorage: boolean) {
  if (!(await ensureStillMissingIcon(supabase, app, verifyStorage)))
    return null

  const storagePath = getAppIconStoragePath(app.owner_org, app.app_id)
  await images.upload(storagePath, icon.bytes, {
    contentType: icon.contentType,
    upsert: true,
  })

  const { data, error: updateError } = await supabase
    .from('apps')
    .update({ icon_url: storagePath })
    .eq('app_id', app.app_id)
    .eq('owner_org', app.owner_org)
    .select('app_id')

  if (updateError)
    throw updateError
  if (!data?.length)
    throw new Error('App row disappeared before update')

  return {
    appId: app.app_id,
    contentType: icon.contentType,
    iconUrl: icon.sourceUrl,
    source: candidate.source,
    status: 'updated',
    storagePath,
    storeUrl: candidate.storeUrl,
  } satisfies BackfillResult
}

async function processApp(supabase: SupabaseClient, app: AppIconRow, apply: boolean, verifyStorage: boolean) {
  const candidate = await findStoreIcon(app)
  if (!candidate)
    throw new Error('No matching store icon found')

  const icon = await downloadIcon(candidate.iconUrl)
  if (!icon)
    throw new Error(`Could not download icon from ${candidate.iconUrl}`)

  const storagePath = getAppIconStoragePath(app.owner_org, app.app_id)
  if (!apply) {
    return {
      appId: app.app_id,
      contentType: icon.contentType,
      iconUrl: icon.sourceUrl,
      source: candidate.source,
      status: 'dry_run',
      storagePath,
      storeUrl: candidate.storeUrl,
    } satisfies BackfillResult
  }

  return applyIcon(supabase, app, candidate, icon, verifyStorage)
}

async function main() {
  if (Bun.argv.includes('--help')) {
    printHelp()
    return
  }

  const apply = Bun.argv.includes('--apply')
  const verifyStorage = Bun.argv.includes('--verify-storage')
  const envFile = getArgValue(Bun.argv, '--env-file') ?? DEFAULT_ENV_FILE
  const appId = getArgValue(Bun.argv, '--app-id')
  const orgId = getArgValue(Bun.argv, '--org-id')
  const limit = getArgValue(Bun.argv, '--limit')
  const concurrency = parsePositiveInteger(getArgValue(Bun.argv, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)
  const parsedLimit = limit === null ? null : parsePositiveInteger(limit, '--limit', DEFAULT_PAGE_SIZE)

  const fileEnv = await loadEnv(envFile)
  const env = {
    ...fileEnv,
    ...Bun.env,
  }
  const supabase = createSupabaseServiceClient(env)
  images = createImageStore(env)
  const apps = await fetchApps(supabase, { appId, orgId })
  const missingApps = await getMissingIconApps(supabase, apps, verifyStorage, concurrency)
  const targetApps = parsedLimit === null ? missingApps : missingApps.slice(0, parsedLimit)
  const failures: BackfillFailure[] = []
  const results: BackfillResult[] = []
  let skippedAfterRecheck = 0

  console.log(`Loaded ${apps.length} apps`)
  console.log(`Missing icons: ${missingApps.length}`)
  console.log(`Target apps: ${targetApps.length}`)
  console.log(`Env file: ${envFile}`)
  if (appId)
    console.log(`Scoped to app: ${appId}`)
  if (orgId)
    console.log(`Scoped to org: ${orgId}`)
  if (verifyStorage)
    console.log('Storage verification enabled')
  if (!apply)
    console.log('Dry run only. Pass --apply to upload icons and update apps.')

  await asyncPool(concurrency, targetApps, async (app) => {
    try {
      const result = await processApp(supabase, app, apply, verifyStorage)
      if (!result) {
        skippedAfterRecheck++
        return
      }

      results.push(result)
      const verb = apply ? 'Updated' : 'Found'
      console.log(`${verb} ${app.app_id} from ${result.source}`)
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

  console.log(`Done. ${apply ? 'Updated' : 'Found'} ${results.length}/${targetApps.length}. Skipped after recheck: ${skippedAfterRecheck}. Failures: ${failures.length}`)

  await mkdir('./tmp', { recursive: true })
  await Bun.write(RESULT_OUTPUT, `${JSON.stringify(results, null, 2)}\n`)
  console.log(`Result details written to ${RESULT_OUTPUT}`)

  if (failures.length > 0) {
    await Bun.write(FAILURE_OUTPUT, `${JSON.stringify(failures, null, 2)}\n`)
    console.log(`Failure details written to ${FAILURE_OUTPUT}`)
    if (apply)
      throw new Error(`Missing app icon backfill completed with ${failures.length} failures`)
  }
}

await main()
