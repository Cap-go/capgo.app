import type { Context } from 'hono'
import type { WebsiteLiveIconSet } from './website_live_icons.ts'
import { sql } from 'drizzle-orm'
import { quickError, simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import {
  AscCertificateLimitError,
  buildIosProvisioningMap,
  createAppStoreProfile,
  createDistributionCertificate,
  ensureAscBundleId,
  findAscApp,
  generateAndroidUploadKeystore,
  parseMobileProvision,
  validatePlayServiceAccountJson,
  verifyAscKey,
} from './store_signing.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'
import { fetchPublicWebsite, isBlockedWebsiteHost } from './website_live_check.ts'
import { generateWebsiteLiveIconSet } from './website_live_icons.ts'

export type StorePlatform = 'ios' | 'android'

/** Bumped together with templates/website-live-app/package.json when the template changes. */
export const WEBSITE_LIVE_TEMPLATE_VERSION = '1.0.0'
/** The builder rejects jobs from CLIs older than 7.83.0; server builds report this version. */
export const WEBSITE_LIVE_BUILDER_CLIENT_VERSION = '8.82.0'
export const WEBSITE_LIVE_BUILD_SOURCE = 'website_live'

const ICON_FILES = {
  ios1024: 'ios-1024.png',
  androidLegacy192: 'android-legacy-192.png',
  androidRound192: 'android-round-192.png',
  androidForeground432: 'android-foreground-432.png',
  playStore512: 'play-512.png',
  preview256: 'preview-256.png',
} as const satisfies Record<Exclude<keyof WebsiteLiveIconSet, 'backgroundColor'>, string>

const MAX_WEBSITE_HTML_BYTES = 1024 * 1024
const MAX_WEBSITE_ICON_BYTES = 5 * 1024 * 1024
const BUILDER_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024
const BUNDLE_ID_PATTERN = /^[A-Z]\w*(?:\.[A-Z]\w*)+$/i

export interface WebsiteLiveStoreConfig {
  app_id: string
  app_name: string | null
  version_name: string
  icon_background_color: string
  icon_storage_prefix: string | null
  submit_for_review: boolean
  updated_at: string | null
}

export interface IosStoreSecret {
  mode: 'automatic' | 'manual'
  ascKeyId: string
  ascIssuerId: string
  ascPrivateKey: string
  teamId: string
  certificateP12Base64: string
  certificatePassword: string
  provisioningProfileBase64: string
  provisioningProfileName: string
  certificateId?: string
  profileId?: string
}

export interface AndroidStoreSecret {
  keystoreBase64: string
  keyAlias: string
  keyPassword: string
  storePassword: string
  playServiceAccountJson?: string
  generated: boolean
}

export interface StoreCredentialSummary {
  platform: StorePlatform
  updated_at: string
  metadata: Record<string, unknown>
}

interface WebsiteLiveApp {
  app_id: string
  owner_org: string
  name: string | null
  update_mode: string
  website_url: string | null
}

// ---------------------------------------------------------------------------
// Encryption of uploaded store keys
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder()

function getStoreSecretKeyMaterial(c: Context): string {
  // Dedicated key: store keys must not depend on a secret that is shared or
  // rotated for other reasons. No fallback, so a missing key fails loudly.
  const secret = getEnv(c, 'STORE_CREDENTIALS_SECRET')
  if (!secret)
    throw simpleError('missing_store_credentials_secret', 'Store credential encryption is not configured')
  return secret
}

async function storeSecretKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(`capgo-store-credentials:${secret}`))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/^data:[^,]+,/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  }
  catch {
    throw simpleError('invalid_base64', 'File content must be base64 encoded')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptStoreSecret(c: Context, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await storeSecretKey(getStoreSecretKeyMaterial(c))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(JSON.stringify(value)))
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`
}

export async function decryptStoreSecret<T>(c: Context, ciphertext: string): Promise<T> {
  const [version, ivValue, cipherValue] = ciphertext.split(':')
  if (version !== 'v1' || !ivValue || !cipherValue)
    throw simpleError('invalid_store_secret_ciphertext', 'Stored store credentials are unreadable')
  const key = await storeSecretKey(getStoreSecretKeyMaterial(c))
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivValue) }, key, base64ToBytes(cipherValue))
  return JSON.parse(new TextDecoder().decode(decrypted)) as T
}

// ---------------------------------------------------------------------------
// Database access (tables are service-only; callers check RBAC first)
// ---------------------------------------------------------------------------

async function withDb<T>(c: Context, run: (db: ReturnType<typeof getDrizzleClient>) => Promise<T>): Promise<T> {
  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pgClient = await getPgClient(c)
    return await run(getDrizzleClient(pgClient))
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

export async function getWebsiteLiveApp(c: Context, appId: string): Promise<WebsiteLiveApp> {
  const row = await withDb(c, async (db) => {
    const result = await db.execute(sql`
      SELECT app_id, owner_org::text AS owner_org, name, update_mode, website_url
      FROM public.apps
      WHERE app_id = ${appId}
      LIMIT 1
    `)
    return result.rows[0] as unknown as WebsiteLiveApp | undefined
  })
  if (!row)
    throw quickError(404, 'app_not_found', 'App not found', { app_id: appId })
  return row
}

/** Same rules as the console (src/stores/appUpdateMode.ts) and the apps_website_url_check constraint. */
export function normalizeWebsiteLiveUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed)
    return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(url.hostname) || url.username || url.password || isBlockedWebsiteHost(url.hostname))
    return null
  if (url.pathname !== '/' && url.pathname !== '/index.html')
    return null
  return `${url.origin}/`
}

/** Turn on Web2App for the app with this website. */
export async function setWebsiteLiveUrl(c: Context, appId: string, input: string): Promise<string> {
  const websiteUrl = normalizeWebsiteLiveUrl(input)
  if (!websiteUrl)
    throw simpleError('invalid_website_url', 'Use the HTTPS address of the website root, such as https://app.example.com')
  await withDb(c, db => db.execute(sql`
    UPDATE public.apps
    SET update_mode = 'website', website_url = ${websiteUrl}, updated_at = now()
    WHERE app_id = ${appId}
  `))
  return websiteUrl
}

export async function getStoreConfig(c: Context, appId: string): Promise<WebsiteLiveStoreConfig> {
  const row = await withDb(c, async (db) => {
    const result = await db.execute(sql`
      SELECT app_id, app_name, version_name, icon_background_color, icon_storage_prefix, submit_for_review, updated_at
      FROM public.website_live_store_configs
      WHERE app_id = ${appId}
    `)
    return result.rows[0] as unknown as WebsiteLiveStoreConfig | undefined
  })
  return row ?? {
    app_id: appId,
    app_name: null,
    version_name: '1.0.0',
    icon_background_color: '#FFFFFF',
    icon_storage_prefix: null,
    submit_for_review: true,
    updated_at: null,
  }
}

export async function upsertStoreConfig(c: Context, appId: string, userId: string | null, patch: {
  app_name?: string
  version_name?: string
  icon_background_color?: string
  icon_storage_prefix?: string
  submit_for_review?: boolean
}): Promise<WebsiteLiveStoreConfig> {
  const current = await getStoreConfig(c, appId)
  const next = {
    app_name: patch.app_name ?? current.app_name,
    version_name: patch.version_name ?? current.version_name,
    icon_background_color: patch.icon_background_color ?? current.icon_background_color,
    icon_storage_prefix: patch.icon_storage_prefix ?? current.icon_storage_prefix,
    submit_for_review: patch.submit_for_review ?? current.submit_for_review,
  }
  return withDb(c, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO public.website_live_store_configs (app_id, app_name, version_name, icon_background_color, icon_storage_prefix, submit_for_review, updated_by)
      VALUES (${appId}, ${next.app_name}, ${next.version_name}, ${next.icon_background_color}, ${next.icon_storage_prefix}, ${next.submit_for_review}, ${userId}::uuid)
      ON CONFLICT (app_id) DO UPDATE SET
        updated_at = now(),
        app_name = EXCLUDED.app_name,
        version_name = EXCLUDED.version_name,
        icon_background_color = EXCLUDED.icon_background_color,
        icon_storage_prefix = EXCLUDED.icon_storage_prefix,
        submit_for_review = EXCLUDED.submit_for_review,
        updated_by = EXCLUDED.updated_by
      RETURNING app_id, app_name, version_name, icon_background_color, icon_storage_prefix, submit_for_review, updated_at
    `)
    return result.rows[0] as unknown as WebsiteLiveStoreConfig
  })
}

export async function listStoreCredentialSummaries(c: Context, appId: string): Promise<StoreCredentialSummary[]> {
  return withDb(c, async (db) => {
    const result = await db.execute(sql`
      SELECT platform, updated_at, metadata
      FROM public.website_live_store_credentials
      WHERE app_id = ${appId}
      ORDER BY platform
    `)
    return result.rows as unknown as StoreCredentialSummary[]
  })
}

async function getStoreSecret<T>(c: Context, appId: string, platform: StorePlatform): Promise<T | null> {
  const ciphertext = await withDb(c, async (db) => {
    const result = await db.execute(sql`
      SELECT secret_ciphertext
      FROM public.website_live_store_credentials
      WHERE app_id = ${appId} AND platform = ${platform}
    `)
    return (result.rows[0] as { secret_ciphertext?: string } | undefined)?.secret_ciphertext
  })
  return ciphertext ? decryptStoreSecret<T>(c, ciphertext) : null
}

async function saveStoreSecret(c: Context, input: {
  appId: string
  platform: StorePlatform
  secret: IosStoreSecret | AndroidStoreSecret
  metadata: Record<string, unknown>
  userId: string | null
}): Promise<StoreCredentialSummary> {
  const ciphertext = await encryptStoreSecret(c, input.secret)
  return withDb(c, async (db) => {
    const result = await db.execute(sql`
      INSERT INTO public.website_live_store_credentials (app_id, platform, secret_ciphertext, metadata, created_by)
      VALUES (${input.appId}, ${input.platform}, ${ciphertext}, ${JSON.stringify(input.metadata)}::jsonb, ${input.userId}::uuid)
      ON CONFLICT (app_id, platform) DO UPDATE SET
        updated_at = now(),
        secret_ciphertext = EXCLUDED.secret_ciphertext,
        metadata = EXCLUDED.metadata,
        created_by = EXCLUDED.created_by
      RETURNING platform, updated_at, metadata
    `)
    return result.rows[0] as unknown as StoreCredentialSummary
  })
}

export async function deleteStoreCredential(c: Context, appId: string, platform: StorePlatform): Promise<boolean> {
  return withDb(c, async (db) => {
    const result = await db.execute(sql`
      DELETE FROM public.website_live_store_credentials
      WHERE app_id = ${appId} AND platform = ${platform}
      RETURNING id
    `)
    return result.rows.length > 0
  })
}

/**
 * Apple allows very few distribution certificates per team, so automatic
 * signing reuses one already created for another app of the same org and team.
 */
async function findReusableIosCertificate(c: Context, ownerOrg: string, appId: string, ascIssuerId: string): Promise<IosStoreSecret | null> {
  const rows = await withDb(c, async (db) => {
    const result = await db.execute(sql`
      SELECT credentials.secret_ciphertext
      FROM public.website_live_store_credentials credentials
      JOIN public.apps apps ON apps.app_id = credentials.app_id
      WHERE apps.owner_org = ${ownerOrg}::uuid
        AND credentials.app_id <> ${appId}
        AND credentials.platform = 'ios'
        AND credentials.metadata ->> 'mode' = 'automatic'
        AND credentials.metadata ->> 'asc_issuer_id' = ${ascIssuerId}
      ORDER BY credentials.updated_at DESC
      LIMIT 5
    `)
    return result.rows as { secret_ciphertext: string }[]
  })
  for (const row of rows) {
    try {
      const secret = await decryptStoreSecret<IosStoreSecret>(c, row.secret_ciphertext)
      if (secret.certificateId && secret.certificateP12Base64)
        return secret
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot read reusable iOS certificate', error })
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Store key intake
// ---------------------------------------------------------------------------

export function assertStoreBundleId(appId: string): string {
  if (!BUNDLE_ID_PATTERN.test(appId) || appId.length > 155) {
    throw simpleError('invalid_bundle_id', 'This app ID cannot be used as a store bundle ID. Use a reverse-domain ID such as com.company.app, with letters, digits and underscores only.', { app_id: appId })
  }
  return appId
}

export async function saveIosCredentials(c: Context, input: {
  app: WebsiteLiveApp
  userId: string | null
  mode: 'automatic' | 'manual'
  ascKeyId: string
  ascIssuerId: string
  ascPrivateKey: string
  certificateP12Base64?: string
  certificatePassword?: string
  provisioningProfileBase64?: string
}): Promise<StoreCredentialSummary> {
  const bundleId = assertStoreBundleId(input.app.app_id)
  const ascCreds = { keyId: input.ascKeyId, issuerId: input.ascIssuerId, privateKeyP8: input.ascPrivateKey }
  const verified = await verifyAscKey(ascCreds)
  if (!verified.ok)
    throw simpleError('invalid_app_store_connect_key', verified.message, { reason: verified.reason })

  const ascApp = await findAscApp(ascCreds, bundleId)
  let secret: IosStoreSecret
  let certificateExpiresAt: string | null = null
  let profileExpiresAt: string | null = null

  if (input.mode === 'manual') {
    if (!input.certificateP12Base64 || !input.provisioningProfileBase64)
      throw simpleError('missing_ios_signing_files', 'Upload the .p12 distribution certificate and the App Store provisioning profile, or use automatic signing.')
    const profile = parseMobileProvision(input.provisioningProfileBase64)
    if (profile.bundleId !== bundleId && profile.bundleId !== '*')
      throw simpleError('provisioning_profile_bundle_mismatch', `This provisioning profile is for ${profile.bundleId}, not ${bundleId}.`)
    if (!profile.isAppStore)
      throw simpleError('provisioning_profile_not_app_store', 'This provisioning profile is not an App Store distribution profile.')
    profileExpiresAt = profile.expirationDate
    secret = {
      mode: 'manual',
      ascKeyId: input.ascKeyId,
      ascIssuerId: input.ascIssuerId,
      ascPrivateKey: input.ascPrivateKey,
      teamId: profile.teamId,
      certificateP12Base64: input.certificateP12Base64,
      certificatePassword: input.certificatePassword ?? '',
      provisioningProfileBase64: input.provisioningProfileBase64,
      provisioningProfileName: profile.name,
    }
  }
  else {
    const bundleIdResourceId = await ensureAscBundleId(ascCreds, bundleId, input.app.name || bundleId)
    // An issuer ID belongs to one Apple team: reuse the certificate made for another app of this org.
    let certificate = await findReusableIosCertificate(c, input.app.owner_org, input.app.app_id, input.ascIssuerId)
    let certificateId = certificate?.certificateId
    let teamId = certificate?.teamId ?? ''
    let p12Base64 = certificate?.certificateP12Base64
    let p12Password = certificate?.certificatePassword
    if (!certificate) {
      try {
        const created = await createDistributionCertificate(ascCreds)
        certificateId = created.certificateId
        teamId = created.teamId
        p12Base64 = created.p12Base64
        p12Password = created.p12Password
        certificateExpiresAt = created.expirationDate
      }
      catch (error) {
        if (error instanceof AscCertificateLimitError) {
          throw simpleError('apple_certificate_limit', 'Your Apple team already has the maximum number of distribution certificates. Revoke an unused one in the Apple Developer portal, or switch to manual signing and upload an existing .p12.')
        }
        throw error
      }
    }
    if (!certificateId || !p12Base64)
      throw simpleError('apple_certificate_unavailable', 'Could not prepare a distribution certificate')
    const profile = await createAppStoreProfile(ascCreds, {
      bundleIdResourceId,
      certificateId,
      name: `Capgo Web2App ${bundleId}`,
    })
    const parsedProfile = parseMobileProvision(profile.profileContentBase64)
    profileExpiresAt = parsedProfile.expirationDate
    certificate = null
    secret = {
      mode: 'automatic',
      ascKeyId: input.ascKeyId,
      ascIssuerId: input.ascIssuerId,
      ascPrivateKey: input.ascPrivateKey,
      teamId: teamId || parsedProfile.teamId,
      certificateP12Base64: p12Base64,
      certificatePassword: p12Password ?? '',
      provisioningProfileBase64: profile.profileContentBase64,
      provisioningProfileName: profile.name,
      certificateId,
      profileId: profile.profileId,
    }
  }

  return saveStoreSecret(c, {
    appId: input.app.app_id,
    platform: 'ios',
    secret,
    userId: input.userId,
    metadata: {
      mode: secret.mode,
      asc_key_id: input.ascKeyId,
      asc_issuer_id: input.ascIssuerId,
      team_id: secret.teamId,
      bundle_id: bundleId,
      profile_name: secret.provisioningProfileName,
      profile_expires_at: profileExpiresAt,
      certificate_expires_at: certificateExpiresAt,
      app_store_app_id: ascApp?.id ?? null,
      app_store_app_found: Boolean(ascApp),
    },
  })
}

export async function saveAndroidCredentials(c: Context, input: {
  app: WebsiteLiveApp
  userId: string | null
  generateKeystore: boolean
  keystoreBase64?: string
  keyAlias?: string
  keyPassword?: string
  storePassword?: string
  playServiceAccountJson?: string
}): Promise<{ summary: StoreCredentialSummary, generatedKeystore: { keystoreBase64: string, keyAlias: string, password: string } | null }> {
  assertStoreBundleId(input.app.app_id)
  const existing = await getStoreSecret<AndroidStoreSecret>(c, input.app.app_id, 'android')
  let play: { clientEmail: string, projectId: string } | null = null
  if (input.playServiceAccountJson)
    play = validatePlayServiceAccountJson(input.playServiceAccountJson)

  let secret: AndroidStoreSecret
  let fingerprints: { sha1: string | null, sha256: string | null } = { sha1: null, sha256: null }
  let generatedKeystore: { keystoreBase64: string, keyAlias: string, password: string } | null = null

  if (input.generateKeystore) {
    if (existing)
      throw simpleError('android_keystore_exists', 'This app already has an upload key. Delete it first if you really want a new one; Google Play only accepts the key it already knows.')
    const generated = await generateAndroidUploadKeystore({ alias: 'upload', commonName: input.app.name || input.app.app_id })
    secret = {
      keystoreBase64: generated.keystoreBase64,
      keyAlias: generated.alias,
      keyPassword: generated.keyPassword,
      storePassword: generated.storePassword,
      playServiceAccountJson: input.playServiceAccountJson,
      generated: true,
    }
    fingerprints = { sha1: generated.sha1Fingerprint, sha256: generated.sha256Fingerprint }
    generatedKeystore = { keystoreBase64: generated.keystoreBase64, keyAlias: generated.alias, password: generated.storePassword }
  }
  else if (input.keystoreBase64) {
    if (!input.keyAlias || !input.storePassword)
      throw simpleError('missing_android_keystore_fields', 'Key alias and keystore password are required with an uploaded keystore')
    secret = {
      keystoreBase64: input.keystoreBase64,
      keyAlias: input.keyAlias,
      keyPassword: input.keyPassword || input.storePassword,
      storePassword: input.storePassword,
      playServiceAccountJson: input.playServiceAccountJson,
      generated: false,
    }
  }
  else if (existing) {
    // Only the Play service account changes; keep the signing key.
    secret = { ...existing, playServiceAccountJson: input.playServiceAccountJson ?? existing.playServiceAccountJson }
    if (existing.playServiceAccountJson && !play)
      play = validatePlayServiceAccountJson(existing.playServiceAccountJson)
  }
  else {
    throw simpleError('missing_android_keystore', 'Upload your Android upload keystore or let Capgo generate one')
  }

  const existingSummary = (await listStoreCredentialSummaries(c, input.app.app_id)).find(row => row.platform === 'android')
  const summary = await saveStoreSecret(c, {
    appId: input.app.app_id,
    platform: 'android',
    secret,
    userId: input.userId,
    metadata: {
      key_alias: secret.keyAlias,
      generated: secret.generated,
      sha1: fingerprints.sha1 ?? (secret === existing ? existingSummary?.metadata.sha1 ?? null : null),
      sha256: fingerprints.sha256 ?? (secret === existing ? existingSummary?.metadata.sha256 ?? null : null),
      play_client_email: play?.clientEmail ?? null,
      play_project_id: play?.projectId ?? null,
      // The console reminds users to download a generated key until they do.
      exported_at: secret === existing ? existingSummary?.metadata.exported_at ?? null : null,
    },
  })
  return { summary, generatedKeystore }
}

export async function exportAndroidKeystore(c: Context, appId: string) {
  const secret = await getStoreSecret<AndroidStoreSecret>(c, appId, 'android')
  if (!secret)
    throw quickError(404, 'android_keystore_not_found', 'No Android upload key is stored for this app')
  await withDb(c, db => db.execute(sql`
    UPDATE public.website_live_store_credentials
    SET metadata = metadata || jsonb_build_object('exported_at', now())
    WHERE app_id = ${appId} AND platform = 'android'
  `))
  return {
    keystore_base64: secret.keystoreBase64,
    key_alias: secret.keyAlias,
    key_password: secret.keyPassword,
    store_password: secret.storePassword,
  }
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// Icons live in the Supabase images bucket next to the app icon (org/<org>/<app>/),
// so cron_clean_orphan_images removes them when the app is deleted.
const ICON_BUCKET = 'images'

function iconPrefix(app: WebsiteLiveApp): string {
  return `org/${app.owner_org}/${app.app_id}/website_live/${crypto.randomUUID()}`
}

async function putStorageObject(c: Context, key: string, bytes: Uint8Array, contentType: string) {
  const { error } = await supabaseAdmin(c).storage.from(ICON_BUCKET).upload(key, new Uint8Array(bytes), { contentType, upsert: true })
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Web2App icon upload failed', key, error })
    throw simpleError('icon_upload_failed', 'Could not store the generated icon')
  }
}

export async function storeIconSet(c: Context, app: WebsiteLiveApp, source: Uint8Array, backgroundColor: string): Promise<string> {
  const icons = generateWebsiteLiveIconSet(source, { backgroundColor })
  const prefix = iconPrefix(app)
  await Promise.all(Object.entries(ICON_FILES).map(([field, file]) =>
    putStorageObject(c, `${prefix}/${file}`, icons[field as keyof typeof ICON_FILES], 'image/png'),
  ))
  return prefix
}

export async function loadIconSet(c: Context, prefix: string, backgroundColor: string): Promise<WebsiteLiveIconSet> {
  const storage = supabaseAdmin(c).storage.from(ICON_BUCKET)
  const entries = await Promise.all(Object.entries(ICON_FILES).map(async ([field, file]) => {
    const { data, error } = await storage.download(`${prefix}/${file}`)
    if (error || !data)
      throw simpleError('icon_missing', 'The app icon is missing. Upload it again.')
    return [field, new Uint8Array(await data.arrayBuffer())] as const
  }))
  return { ...Object.fromEntries(entries), backgroundColor } as WebsiteLiveIconSet
}

export async function getIconPreviewUrl(c: Context, prefix: string | null): Promise<string | null> {
  if (!prefix)
    return null
  const { data, error } = await supabaseAdmin(c).storage.from(ICON_BUCKET).createSignedUrl(`${prefix}/${ICON_FILES.preview256}`, 3600)
  if (error || !data) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot sign Web2App icon preview', error })
    return null
  }
  return data.signedUrl
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes)
    throw simpleError('website_icon_too_large', 'The website icon is too large')
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > maxBytes)
    throw simpleError('website_icon_too_large', 'The website icon is too large')
  return body
}

function sameOriginUrl(base: URL, href: string | null | undefined): URL | null {
  if (!href)
    return null
  try {
    const url = new URL(href, base)
    return url.origin === base.origin && url.protocol === 'https:' ? url : null
  }
  catch {
    return null
  }
}

async function fetchSameOrigin(base: URL, url: URL, maxBytes: number): Promise<Uint8Array | null> {
  const { response, finalUrl } = await fetchPublicWebsite(url.href, { accept: '*/*' })
  if (!response.ok || new URL(finalUrl).origin !== base.origin) {
    await response.body?.cancel()
    return null
  }
  return readLimited(response, maxBytes)
}

function parseIconSize(sizes: string | undefined): number {
  if (!sizes)
    return 0
  return Math.max(0, ...sizes.split(/\s+/).map(size => Number.parseInt(size.split('x')[0] ?? '0', 10) || 0))
}

/**
 * Find the biggest PNG icon the website publishes (web manifest first, then
 * apple-touch-icon). Only same-origin HTTPS URLs are fetched.
 */
export async function fetchWebsiteIcon(websiteUrl: string): Promise<Uint8Array> {
  const base = new URL(websiteUrl)
  if (base.protocol !== 'https:')
    throw simpleError('invalid_website_url', 'The website must use HTTPS')
  const html = await fetchSameOrigin(base, base, MAX_WEBSITE_HTML_BYTES)
  const candidates: { url: URL, size: number }[] = []
  if (html) {
    const text = new TextDecoder().decode(html)
    for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
      const tag = match[0]
      const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
      const url = sameOriginUrl(base, href)
      if (!url)
        continue
      if (rel.split(/\s+/).includes('manifest')) {
        const manifestBytes = await fetchSameOrigin(base, url, MAX_WEBSITE_HTML_BYTES).catch(() => null)
        if (!manifestBytes)
          continue
        try {
          const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { icons?: { src?: string, sizes?: string, type?: string, purpose?: string }[] }
          for (const icon of manifest.icons ?? []) {
            const iconUrl = sameOriginUrl(url, icon.src)
            if (iconUrl && (!icon.type || icon.type === 'image/png') && !(icon.purpose ?? '').includes('monochrome'))
              candidates.push({ url: iconUrl, size: parseIconSize(icon.sizes) })
          }
        }
        catch {
          // Invalid manifests are ignored; other icon sources may still work.
        }
      }
      else if (rel.includes('apple-touch-icon') || rel.split(/\s+/).includes('icon')) {
        const sizes = /\bsizes\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
        candidates.push({ url, size: parseIconSize(sizes) || (rel.includes('apple-touch-icon') ? 180 : 0) })
      }
    }
  }
  candidates.push({ url: new URL('/apple-touch-icon.png', base), size: 180 })
  candidates.sort((a, b) => b.size - a.size)
  for (const candidate of candidates) {
    const bytes = await fetchSameOrigin(base, candidate.url, MAX_WEBSITE_ICON_BYTES).catch(() => null)
    if (bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)
      return bytes
  }
  throw simpleError('website_icon_not_found', 'No PNG icon of at least 512x512 was found on the website. Upload one instead.')
}

// ---------------------------------------------------------------------------
// Template + builder
// ---------------------------------------------------------------------------

export function getTemplateUrl(c: Context): string {
  return getEnv(c, 'WEBSITE_LIVE_TEMPLATE_URL')
    || `https://github.com/Cap-go/capgo.app/releases/download/website-live-template-v${WEBSITE_LIVE_TEMPLATE_VERSION}/website-live-template.zip`
}

export async function fetchTemplateZip(c: Context): Promise<Uint8Array> {
  const url = getTemplateUrl(c)
  const response = await fetch(url)
  if (!response.ok) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Web2App template download failed', url, status: response.status })
    throw quickError(503, 'website_live_template_unavailable', 'The app template is not available right now. Try again in a few minutes.')
  }
  return new Uint8Array(await response.arrayBuffer())
}

function encodeTusMetadataValue(value: string): string {
  return bytesToBase64(textEncoder.encode(value))
}

/** Upload the patched project through the builder's TUS endpoint. */
export async function uploadToBuilder(c: Context, input: { builderUploadUrl: string, uploadPath: string, bytes: Uint8Array }) {
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  const create = await fetch(input.builderUploadUrl, {
    method: 'POST',
    headers: {
      'x-api-key': builderApiKey,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(input.bytes.byteLength),
      'Upload-Metadata': `filename ${encodeTusMetadataValue(input.uploadPath)},filetype ${encodeTusMetadataValue('application/zip')}`,
    },
  })
  const location = create.headers.get('Location')
  if (create.status !== 201 || !location) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder upload create failed', status: create.status, body: await create.text() })
    throw quickError(503, 'builder_upload_failed', 'Could not upload the app project to the builder')
  }
  for (let offset = 0; offset < input.bytes.byteLength; offset += BUILDER_UPLOAD_CHUNK_BYTES) {
    const chunk = input.bytes.slice(offset, Math.min(offset + BUILDER_UPLOAD_CHUNK_BYTES, input.bytes.byteLength))
    const patch = await fetch(new URL(location, input.builderUploadUrl), {
      method: 'PATCH',
      headers: {
        'x-api-key': builderApiKey,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: chunk,
    })
    if (patch.status !== 204) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Builder upload chunk failed', status: patch.status, offset, body: await patch.text() })
      throw quickError(503, 'builder_upload_failed', 'Could not upload the app project to the builder')
    }
  }
  cloudlog({ requestId: c.get('requestId'), message: 'Web2App project uploaded to builder', bytes: input.bytes.byteLength })
}

export async function getPublishSecrets(c: Context, appId: string, platform: StorePlatform) {
  return platform === 'ios'
    ? { ios: await getStoreSecret<IosStoreSecret>(c, appId, 'ios'), android: null }
    : { ios: null, android: await getStoreSecret<AndroidStoreSecret>(c, appId, 'android') }
}

export function iosBuilderCredentials(secret: IosStoreSecret, bundleId: string): Record<string, string> {
  return {
    BUILD_CERTIFICATE_BASE64: secret.certificateP12Base64,
    P12_PASSWORD: secret.certificatePassword,
    CAPGO_IOS_PROVISIONING_MAP: buildIosProvisioningMap(bundleId, secret.provisioningProfileBase64, secret.provisioningProfileName),
    APPLE_KEY_ID: secret.ascKeyId,
    APPLE_ISSUER_ID: secret.ascIssuerId,
    APPLE_KEY_CONTENT: bytesToBase64(textEncoder.encode(secret.ascPrivateKey)),
    APP_STORE_CONNECT_TEAM_ID: secret.teamId,
  }
}

export function androidBuilderCredentials(secret: AndroidStoreSecret): Record<string, string> {
  return {
    ANDROID_KEYSTORE_FILE: secret.keystoreBase64,
    KEYSTORE_KEY_ALIAS: secret.keyAlias,
    KEYSTORE_KEY_PASSWORD: secret.keyPassword,
    KEYSTORE_STORE_PASSWORD: secret.storePassword,
    ...(secret.playServiceAccountJson ? { PLAY_CONFIG_JSON: bytesToBase64(textEncoder.encode(secret.playServiceAccountJson)) } : {}),
  }
}

export function websiteLiveBuildOptions(platform: StorePlatform, submitForReview: boolean, hasPlayAccess: boolean) {
  return {
    platform,
    buildMode: 'release',
    cliVersion: WEBSITE_LIVE_BUILDER_CLIENT_VERSION,
    ...(platform === 'ios' ? { iosDistribution: 'app_store', iosScheme: 'App', iosTarget: 'App' } : {}),
    outputUploadEnabled: true,
    outputRetentionSeconds: 7 * 24 * 60 * 60,
    skipBuildNumberBump: false,
    skipMarketingVersionBump: false,
    // Without Play access the AAB is only produced for download.
    submitToStoreReview: submitForReview && (platform === 'ios' || hasPlayAccess),
  }
}
