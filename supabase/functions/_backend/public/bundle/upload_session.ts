import type { Context } from 'hono'
import type { TrackEventBody } from '../../private/events.ts'
import type { NativePackage } from '../../utils/bundle_compatibility.ts'
import type { DeltaPackManifest, ZipEntry } from '../../utils/bundle_zip.ts'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { ManifestPersistEntry } from '../../utils/manifest_persist.ts'
import type { ManifestSizeReceiptFacts } from '../../utils/manifest_size_receipt.ts'
import type { ManifestUploadRequest } from '../../utils/manifest_upload.ts'
import type { Permission } from '../../utils/rbac.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { createHash } from 'node:crypto'
import { greaterOrEqual, parse as parseSemver } from '@std/semver'
import { getRuntimeKey } from 'hono/adapter'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { ALERT_UPLOAD_SIZE_BYTES, MAX_UPLOAD_LENGTH_BYTES } from '../../files/util.ts'
import { runCliPreflight } from '../../private/cli/index.ts'
import { deleteFailedVersionRow } from '../../private/delete_failed_version.ts'
import { acceptTrackEvent } from '../../private/events.ts'
import { manifestUploadPublicUrl } from '../../private/request_manifest_upload.ts'
import { compareNativePackages, summarizeBundleCompatibility } from '../../utils/bundle_compatibility.ts'
import { BundleUploadTokenError, getBundleUploadSessionSecret, signBundleUploadToken, verifyBundleUploadToken } from '../../utils/bundle_upload_token.ts'
import { BundleZipError, checksumAlgorithmForUpdater, compressDeltaFile, containsAscii, Crc32, DELTA_PACK_MANIFEST_NAME, entryDataFromBuffer, findCentralDirectory, hasRootIndexHtml, inflateEntry, isJsEntry, parseCentralDirectory, parseDeltaPackManifest, readZipDirectory, selectDeltaEntries, sha256Hex, updaterSupportsDelta, walkZipStream, ZIP_TAIL_READ_SIZE } from '../../utils/bundle_zip.ts'
import { BRES, quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { ManifestInventoryConflict, registerManifestInventory, reserveManifestPaths, usesManifestInventory, withManifestInventory } from '../../utils/manifest_inventory.ts'
import { MAX_MANIFEST_ENTRIES } from '../../utils/manifest_limits.ts'
import { persistVersionManifestEntries } from '../../utils/manifest_persist.ts'
import { getManifestReceiptBucket } from '../../utils/manifest_size_receipt.ts'
import { createManifestUploadResponse, ManifestUploadRequestError, resolveManifestUploadPublicBaseUrl, validateManifestUploadRequest } from '../../utils/manifest_upload.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { s3 } from '../../utils/s3.ts'
import { bundleStorage } from '../../utils/bundle_storage.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { backgroundTask, getEnv, isValidAppId, isValidSemver } from '../../utils/utils.ts'
import { post as postChannel } from '../channel/post.ts'
import { getCurrentBundle } from '../channel/current_bundle.ts'
import { deleteBundle } from './delete.ts'
import { setChannel } from './set_channel.ts'
import { upsertBundle } from './upsert.ts'

/**
 * Bundle upload through presigned URLs, with the checks and side effects of
 * `capgo bundle upload` (cli/src/bundle/upload.ts) run server-side:
 *   POST /bundle/upload/prepare  -> checks, creates the r2-direct version, returns PUT URL(s) + token
 *   POST /bundle/upload/complete -> verifies the uploaded zip, delta manifest, finalizes, links channels
 *   POST /bundle/upload/abort    -> removes an unfinished upload
 */

type ApikeyRow = Database['public']['Tables']['apikeys']['Row']
type UploadContext = Context<MiddlewareKeyVariables>

export const UPLOAD_URL_TTL_SECONDS = 60 * 60
/** Server-side delta bounds: Workers allow 10k subrequests (<= 2 per file) and 128 MB of memory. */
export const MAX_SERVER_DELTA_FILES = 4000
export const MAX_SERVER_DELTA_BYTES = 48 * 1024 * 1024
export const MAX_DELTA_PACK_BYTES = 64 * 1024 * 1024
const MAX_NOTIFY_SCAN_FILE_BYTES = 32 * 1024 * 1024
const STORAGE_CONCURRENCY = 6
const CLI_HINT = 'Use `npx @capgo/cli@latest bundle upload` for this bundle instead.'

const nativePackageSchema = z.object({
  name: z.string().min(1).max(512),
  version: z.string().min(1).max(256),
  requested_version: z.string().max(256).optional(),
  ios_checksum: z.string().max(256).optional(),
  android_checksum: z.string().max(256).optional(),
})

const prepareSchema = z.object({
  app_id: z.string().min(1),
  version: z.string().min(1).max(256),
  channel: z.union([z.string(), z.array(z.string()).max(50)]).optional(),
  comment: z.string().max(4096).nullish(),
  link: z.string().max(2048).nullish(),
  min_update_version: z.string().max(256).optional(),
  auto_min_update_version: z.boolean().optional(),
  native_packages: z.array(nativePackageSchema).max(1000).optional(),
  updater_version: z.string().min(1).max(256).optional(),
  updater_package: z.string().max(256).optional(),
  checksum: z.string().min(1).max(1024).optional(),
  session_key: z.string().min(1).max(4096).optional(),
  key_id: z.string().max(256).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  delta: z.boolean().optional(),
  delta_pack: z.boolean().optional(),
  version_exists_ok: z.boolean().optional(),
  ignore_checksum_check: z.boolean().optional(),
  ignore_metadata_check: z.boolean().optional(),
  fail_on_incompatible: z.boolean().optional(),
  accept_incompatible: z.boolean().optional(),
  self_assign: z.boolean().optional(),
  rollout_percentage: z.number().min(0).max(100).optional(),
  rollout_percentage_bps: z.number().int().min(0).max(10000).optional(),
  advance_rollout: z.boolean().optional(),
  rollout_paused: z.boolean().optional(),
  rollout_cache_ttl_seconds: z.number().int().min(60).max(31536000).optional(),
  delete_linked_bundle_on_upload: z.boolean().optional(),
  code_check: z.boolean().optional(),
  ignore_notify_app_ready: z.boolean().optional(),
  cli_version: z.string().max(64).optional(),
}).strict()

export type PrepareUploadBody = z.infer<typeof prepareSchema>

const tokenBodySchema = z.object({ upload_token: z.string().min(1) }).strict()

type CompatibilityResult = 'compatible' | 'incompatible' | 'skipped'

interface SessionChannel {
  name: string
  compatibility: CompatibilityResult
  incompatible_count: number
  version_old_id?: string
  version_old_name?: string
}

export interface UploadSessionClaims {
  v: 1
  apikey_id: number
  user_id: string
  app_id: string
  owner_org: string
  version_id: number
  version: string
  bundle_path: string
  delta_pack_path?: string
  encrypted: boolean
  checksum?: string
  checksum_algorithm: 'sha256' | 'crc32'
  delta: 'none' | 'server' | 'pack'
  index_check: boolean
  notify_check: boolean
  checksum_check: boolean
  channels: SessionChannel[]
  rollout?: { bps?: number, advance: boolean, paused?: boolean, cache_ttl_seconds?: number }
  self_assign: boolean
  delete_linked_bundle: boolean
  accept_incompatible: boolean
}

interface ChannelContext {
  disable_auto_update: string
  checksum: string | null
  version: { id: number, name: string, min_update_version: string | null, native_packages: NativePackage[] } | null
}

interface UploadTargetChannel {
  id: number
  public: boolean
  version: number | null
  rollout_version: number | null
  rollout_enabled: boolean
  rollout_percentage_bps: number | null
}

interface DeltaFile {
  file_name: string
  file_hash: string
  compression: 'none' | 'brotli'
  payload: Uint8Array
  sha256: string
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  if (error instanceof HTTPException)
    return (error.cause as { error?: string } | undefined)?.error
  return undefined
}

/** True for deterministic rejections that justify deleting the unfinished upload. */
function isUploadRejection(error: unknown): boolean {
  return error instanceof HTTPException && error.status >= 400 && error.status < 500 && errorCode(error) !== 'upload_missing'
}

function parseUploadChannels(channel: string | string[] | undefined): string[] {
  const values = Array.isArray(channel) ? channel : (channel ?? '').split(',')
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function rolloutBps(body: PrepareUploadBody): number | undefined {
  if (body.rollout_percentage_bps != null)
    return body.rollout_percentage_bps
  if (body.rollout_percentage != null)
    return Math.round(body.rollout_percentage * 100)
  return undefined
}

function pickHighestMinUpdateVersion(values: Array<string | undefined>): string | undefined {
  let selected: string | undefined
  for (const value of values) {
    if (!value)
      continue
    if (!selected || greaterOrEqual(parseSemver(value), parseSemver(selected)))
      selected = value
  }
  return selected
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const output: U[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      output[index] = await mapper(values[index]!, index)
    }
  }))
  return output
}

/** Same event pipeline as POST /private/events (what the CLI calls); never fails the upload. */
function emitEvent(c: UploadContext, event: TrackEventBody) {
  const work = acceptTrackEvent(c, {
    tracking_version: 2,
    ...event,
    nonPersonTags: { upload_flow: 'api_upload_session', ...event.nonPersonTags },
  }).catch((error) => {
    cloudlog({ requestId: c.get('requestId'), message: 'bundle upload event failed', event: event.event, error })
  })
  return backgroundTask(c, work)
}

function cliStyleEvent(c: UploadContext, orgId: string, appId: string, channel: string, event: string, tags: Record<string, string | number | boolean> = {}, notifyConsole = false) {
  return emitEvent(c, {
    channel,
    event,
    org_id: orgId,
    tags: { 'app-id': appId, ...tags },
    ...(notifyConsole ? { notifyConsole: true } : {}),
  } as TrackEventBody)
}

function trackStyleEvent(c: UploadContext, orgId: string, appId: string, event: string, tags: Record<string, string | number | boolean>) {
  return emitEvent(c, {
    channel: 'bundle',
    event,
    org_id: orgId,
    tags: { app_id: appId, ...tags },
  } as TrackEventBody)
}

async function loadChannelContext(c: UploadContext, apikey: ApikeyRow, appId: string, channel: string): Promise<ChannelContext | null> {
  try {
    const data = await (await getCurrentBundle(c, { app_id: appId, channel }, apikey)).json() as {
      bundle_name: string | null
      bundle_id: number | null
      min_update_version: string | null
      checksum: string | null
      native_packages: NativePackage[] | null
      disable_auto_update: string
    }
    return {
      disable_auto_update: data.disable_auto_update ?? 'none',
      checksum: data.bundle_name ? data.checksum : null,
      version: data.bundle_name && data.bundle_id != null
        ? { id: data.bundle_id, name: data.bundle_name, min_update_version: data.min_update_version, native_packages: Array.isArray(data.native_packages) ? data.native_packages : [] }
        : null,
    }
  }
  catch (error) {
    if (errorCode(error) === 'cannot_find_channel')
      return null
    throw error
  }
}

/** Mirrors getChannelsToAssignAfterChecksumCheck: drop channels already serving this checksum. */
async function channelsAfterChecksumCheck(c: UploadContext, apikey: ApikeyRow, appId: string, channels: string[], checksum: string, contexts?: Map<string, ChannelContext | null>) {
  const alreadyCurrent: string[] = []
  const toAssign: string[] = []
  for (const channel of channels) {
    let remote: string | null = null
    try {
      const context = contexts?.has(channel) ? contexts.get(channel)! : await loadChannelContext(c, apikey, appId, channel)
      contexts?.set(channel, context)
      remote = context?.checksum ?? null
    }
    catch {
      // The CLI ignores checksum lookup failures; compatibility loading reports them.
    }
    if (remote && remote === checksum)
      alreadyCurrent.push(channel)
    else
      toAssign.push(channel)
  }
  if (toAssign.length === 0) {
    throw simpleError('same_checksum', `Cannot upload the same bundle content: the bundle checksum matches the bundle already on channel${channels.length > 1 ? 's' : ''} ${channels.join(', ')}. Did you build your app before uploading? Set ignore_checksum_check to skip this check.`, { channels, checksum })
  }
  return { alreadyCurrent, toAssign }
}

async function findUploadTargetChannel(c: UploadContext, appId: string, channel: string): Promise<UploadTargetChannel | null> {
  // Caller-key read, like the CLI: hidden channels behave as missing.
  const { data, error } = await supabaseApikey(c, c.get('capgkey') as string)
    .from('channels')
    .select('id, public, version, rollout_version, rollout_enabled, rollout_percentage_bps')
    .eq('app_id', appId)
    .eq('name', channel)
    .maybeSingle()
  if (error)
    throw simpleError('cannot_check_channel', `Cannot check channel ${channel}`, { error })
  if (!data?.id)
    return null
  return {
    id: data.id,
    public: data.public ?? false,
    version: data.version ?? null,
    rollout_version: data.rollout_version ?? null,
    rollout_enabled: data.rollout_enabled ?? false,
    rollout_percentage_bps: data.rollout_percentage_bps ?? null,
  }
}

/** Mirrors preflightRequiredChannelAssignments. */
async function preflightChannelAssignments(
  c: UploadContext,
  appId: string,
  channels: string[],
  selfAssign: boolean,
  rollout: UploadSessionClaims['rollout'],
): Promise<Map<string, UploadTargetChannel | null>> {
  const targets = new Map<string, UploadTargetChannel | null>()
  const assignsRollout = !!rollout && (rollout.bps != null || rollout.advance)
  const can = (permission: Permission, channelId?: number) => checkPermission(c, permission, channelId ? { appId, channelId } : { appId })
  for (const channel of channels) {
    const target = await findUploadTargetChannel(c, appId, channel)
    if (target) {
      targets.set(channel, target)
      if (!(await can('channel.promote_bundle', target.id)))
        throw quickError(403, 'permission_denied', 'Cannot set channel because this API key lacks channel.promote_bundle for the target channel', { channel, permission: 'channel.promote_bundle' })
      if ((selfAssign || assignsRollout) && !(await can('channel.update_settings', target.id))) {
        throw quickError(403, 'permission_denied', selfAssign
          ? 'Cannot enable device self-assign because this API key lacks channel.update_settings'
          : 'Cannot set rollout because this API key lacks channel.update_settings for the target channel', { channel, permission: 'channel.update_settings' })
      }
      if (assignsRollout && !target.version)
        throw simpleError('rollout_requires_stable_bundle', `Cannot set rollout, channel ${channel} needs a stable bundle before using progressive rollout`, { channel })
      if (rollout?.advance && target.rollout_version == null)
        throw simpleError('rollout_advance_unavailable', `Cannot advance rollout, channel ${channel} has no rollout target to promote to stable`, { channel })
      if (rollout?.advance && rollout.bps == null && !((target.rollout_percentage_bps ?? 0) > 0))
        throw simpleError('rollout_advance_unavailable', `Cannot advance rollout, channel ${channel} has no rollout percentage to reuse. Pass rollout_percentage or rollout_percentage_bps`, { channel })
      continue
    }
    if (assignsRollout)
      throw simpleError('rollout_requires_stable_bundle', `Cannot set rollout, channel ${channel} must already exist with a stable bundle`, { channel })
    if (!(await can('app.create_channel')))
      throw quickError(403, 'permission_denied', 'Cannot create target channel because this API key lacks app.create_channel', { channel, permission: 'app.create_channel' })
    targets.set(channel, null)
  }
  return targets
}

function versionPath(ownerOrg: string, appId: string, version: string) {
  return `orgs/${ownerOrg}/apps/${appId}/${version}.zip`
}

function deltaPackPath(ownerOrg: string, appId: string, versionId: number) {
  return `orgs/${ownerOrg}/apps/${appId}/uploads/${versionId}/delta-pack.zip`
}

async function presignedPut(c: UploadContext, path: string) {
  const url = await s3.getUploadUrl(c, path, UPLOAD_URL_TTL_SECONDS)
  if (!url)
    throw simpleError('cannot_get_upload_link', 'Cannot get upload link')
  return {
    url,
    method: 'PUT' as const,
    headers: { 'Content-Type': 'application/zip' },
    expires_at: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

function validateOptionConflicts(body: PrepareUploadBody) {
  const hasRollout = body.rollout_percentage != null || body.rollout_percentage_bps != null || body.advance_rollout === true
  if (body.min_update_version && body.auto_min_update_version)
    throw simpleError('invalid_options', 'You cannot set both min_update_version and auto_min_update_version, use only one of them')
  if (hasRollout && body.delete_linked_bundle_on_upload)
    throw simpleError('invalid_options', 'You cannot use rollout options with delete_linked_bundle_on_upload because rollout needs the stable channel bundle as fallback')
  if (body.fail_on_incompatible && body.ignore_metadata_check)
    throw simpleError('invalid_options', 'You cannot use fail_on_incompatible together with ignore_metadata_check')
  if (body.accept_incompatible && body.fail_on_incompatible)
    throw simpleError('invalid_options', 'You cannot use accept_incompatible together with fail_on_incompatible')
  if (body.accept_incompatible && body.ignore_metadata_check)
    throw simpleError('invalid_options', 'You cannot use accept_incompatible together with ignore_metadata_check')
  if (body.session_key && !body.checksum)
    throw simpleError('missing_checksum', 'Encrypted bundles need the client-side encrypted checksum (checksum)')
  if (!body.session_key && !body.updater_version)
    throw simpleError('missing_updater_version', 'updater_version (installed @capgo/capacitor-updater version) is required to pick the bundle checksum algorithm')
  if (!body.ignore_metadata_check && !body.native_packages)
    throw simpleError('missing_native_packages', 'native_packages is required for the native compatibility check (pass ignore_metadata_check to skip it)')
}

async function resolveChannels(c: UploadContext, body: PrepareUploadBody): Promise<string[]> {
  if (body.channel !== undefined) {
    const channels = parseUploadChannels(body.channel)
    if (channels.length === 0)
      throw simpleError('missing_channel', 'Missing channel name, pass one channel or a list of channels')
    return channels
  }
  const { data } = await supabaseApikey(c, c.get('capgkey') as string)
    .from('apps')
    .select('default_upload_channel')
    .eq('app_id', body.app_id)
    .maybeSingle()
  if (!data?.default_upload_channel)
    throw simpleError('missing_default_upload_channel', 'Cannot find default upload channel, pass channel or set it in the app settings', { app_id: body.app_id })
  return parseUploadChannels(data.default_upload_channel)
}

interface CompatibilityOutcome {
  channel: string
  result: CompatibilityResult
  incompatibleCount: number
  reasons: string[]
  minUpdateVersion?: string
  versionOldId?: string
  versionOldName?: string
}

/** Mirrors verifyCompatibility for one channel. */
function verifyChannelCompatibility(body: PrepareUploadBody, channel: string, context: ChannelContext | null, warnings: string[]): CompatibilityOutcome {
  const ignore = !!body.ignore_metadata_check
  let minUpdateVersion = body.min_update_version
  let result: CompatibilityResult = 'skipped'
  let incompatibleCount = 0
  let reasons: string[] = []

  if (context?.version && !ignore) {
    const comparisons = compareNativePackages(body.native_packages ?? [], context.version.native_packages)
    const summary = summarizeBundleCompatibility(comparisons)
    result = summary.compatible ? 'compatible' : 'incompatible'
    incompatibleCount = summary.incompatibleCount
    reasons = [...new Set(comparisons.filter(entry => !entry.compatible).flatMap(entry => entry.reasons))]
    if (!summary.compatible) {
      warnings.push(`Bundle NOT compatible with channel ${channel} (${summary.offenders.join(', ')}). An app store update may be required for these changes to take effect.`)
      if (body.auto_min_update_version)
        minUpdateVersion = body.version
    }
    else if (body.auto_min_update_version) {
      const last = context.version.min_update_version
      if (!last || !isValidSemver(last))
        throw simpleError('invalid_remote_min_update_version', `Cannot auto set min_update_version: channel ${channel} bundle has no valid min_update_version`, { channel })
      minUpdateVersion = last
    }
  }
  else if (!ignore) {
    warnings.push(`Channel ${channel} is new or it's your first upload with compatibility check, it will be ignored this time`)
    if (body.auto_min_update_version)
      minUpdateVersion = body.version
  }

  if (context?.disable_auto_update === 'version_number' && !minUpdateVersion && !ignore)
    throw simpleError('min_update_version_required', `You need to provide a min_update_version to upload a bundle to channel ${channel}`, { channel })
  if (minUpdateVersion && !isValidSemver(minUpdateVersion))
    throw simpleError('invalid_min_update_version', `Your minimal version update ${minUpdateVersion} is not valid semver`, { min_update_version: minUpdateVersion })

  return {
    channel,
    result,
    incompatibleCount,
    reasons,
    minUpdateVersion,
    versionOldId: context?.version?.id != null ? String(context.version.id) : undefined,
    versionOldName: context?.version?.name,
  }
}

export async function prepareBundleUpload(c: UploadContext, rawBody: unknown, apikey: ApikeyRow): Promise<Response> {
  const parsed = safeParseSchema(prepareSchema, rawBody)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  const body = parsed.data
  if (!isValidAppId(body.app_id))
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  if (!isValidSemver(body.version))
    throw simpleError('invalid_version_format', `Your bundle name ${body.version} is not valid, it should follow semver convention: https://semver.org/`, { version: body.version })
  validateOptionConflicts(body)

  // Same gate the CLI runs first: 2FA, app.upload_bundle, storage plan, org CLI warnings.
  const preflight = await runCliPreflight(c, {
    app_id: body.app_id,
    permission: 'app.upload_bundle',
    plan: 'upload',
    ...(body.cli_version ? { cli_version: body.cli_version } : {}),
  })
  const orgId = preflight.org_id!
  const warnings: string[] = []
  const channels = await resolveChannels(c, body)

  const { data: existing, error: existingError } = await supabaseAdmin(c)
    .from('app_versions')
    .select('id, deleted')
    .eq('app_id', body.app_id)
    .eq('name', body.version)
    .maybeSingle()
  if (existingError)
    throw simpleError('cannot_check_version', 'Cannot check bundle version', { error: existingError })
  if (existing) {
    if (body.version_exists_ok)
      return c.json({ ...BRES, skipped: true, reason: 'VERSION_EXISTS', app_id: body.app_id, version: body.version })
    throw quickError(409, 'version_already_exists', `Version ${body.version} already exists${existing.deleted ? ' (a deleted bundle still occupies the name)' : ''}. Pick a new version or set version_exists_ok.`, { version: body.version })
  }

  if (body.size_bytes != null && body.size_bytes > MAX_UPLOAD_LENGTH_BYTES) {
    throw simpleError('bundle_too_large', `The bundle size is ${Math.floor(body.size_bytes / 1024 / 1024)} Mb, this is greater than the maximum upload length ${Math.floor(MAX_UPLOAD_LENGTH_BYTES / 1024 / 1024)} Mb`, { max_size_bytes: MAX_UPLOAD_LENGTH_BYTES })
  }

  const encrypted = !!body.session_key
  const bps = rolloutBps(body)
  const rollout = bps != null || body.advance_rollout
    ? { bps, advance: !!body.advance_rollout, paused: body.rollout_paused, cache_ttl_seconds: body.rollout_cache_ttl_seconds }
    : undefined
  const checksumCheck = !body.ignore_checksum_check && !rollout

  // Delta mode: the files config disables delta outside Workers, so does the CLI.
  let delta: UploadSessionClaims['delta'] = 'none'
  if (body.delta || body.delta_pack) {
    if (getRuntimeKey() !== 'workerd') {
      warnings.push('Delta updates are not available on this server; only the full bundle will be uploaded')
    }
    else {
      if (encrypted && !body.delta_pack)
        throw simpleError('delta_pack_required', 'Encrypted delta updates must be packed locally by the Capgo CLI (the server never sees your private key). Upload the delta pack (delta_pack: true) or disable delta.')
      if (!updaterSupportsDelta(body.updater_version)) {
        throw simpleError('delta_updater_unsupported', `Your project is using an older version of @capgo/capacitor-updater (${body.updater_version ?? 'unknown'}). To use Delta updates, please upgrade to version 5.10.0 (v5), 6.25.0 (v6) or 7.0.30 (v7) or higher.`)
      }
      delta = body.delta_pack ? 'pack' : 'server'
    }
  }

  const contexts = new Map<string, ChannelContext | null>()
  let channelsToAssign = channels
  if (checksumCheck && body.checksum) {
    const filtered = await channelsAfterChecksumCheck(c, apikey, body.app_id, channels, body.checksum, contexts)
    channelsToAssign = filtered.toAssign
    if (filtered.alreadyCurrent.length)
      warnings.push(`Skipping channel${filtered.alreadyCurrent.length > 1 ? 's' : ''} ${filtered.alreadyCurrent.join(', ')} because they already have this bundle content.`)
  }

  const outcomes: CompatibilityOutcome[] = []
  for (const channel of channelsToAssign) {
    let context: ChannelContext | null
    try {
      context = contexts.has(channel) ? contexts.get(channel)! : await loadChannelContext(c, apikey, body.app_id, channel)
    }
    catch (error) {
      if (error instanceof HTTPException)
        throw error
      throw simpleError('cannot_load_channel', `Cannot load channel ${channel} for compatibility checks`, { channel })
    }
    const outcome = verifyChannelCompatibility(body, channel, context, warnings)
    outcomes.push(outcome)
    trackStyleEvent(c, orgId, body.app_id, 'Bundle Upload Compatibility Checked', {
      result: outcome.result,
      incompatible_count: outcome.incompatibleCount,
      channel,
      channel_name: channel,
      ...(outcome.reasons.length ? { reasons: outcome.reasons.join(',') } : {}),
      ...(outcome.result === 'skipped' ? { skip_reason: body.ignore_metadata_check ? 'ignore_metadata_check' : 'no_remote_metadata' } : {}),
    })
  }

  const incompatible = outcomes.filter(outcome => outcome.result === 'incompatible')
  if (incompatible.length && body.fail_on_incompatible && !body.accept_incompatible) {
    const label = incompatible.map(outcome => outcome.channel).join(', ')
    const incompatibleCount = incompatible.reduce((max, outcome) => Math.max(max, outcome.incompatibleCount), 0)
    trackStyleEvent(c, orgId, body.app_id, 'Bundle Upload Blocked', { reason: 'incompatible', channel: label, channel_name: label, channel_names: label, channel_count: incompatible.length, incompatible_count: incompatibleCount, interactive: false })
    throw simpleError('incompatible_bundle', `Upload aborted: bundle is incompatible with channel${incompatible.length > 1 ? 's' : ''} "${label}" (${incompatibleCount} native package(s) changed). A native build / app-store update is required, or remove fail_on_incompatible to upload anyway.`, { channels: incompatible.map(outcome => outcome.channel) })
  }
  if (incompatible.length && body.accept_incompatible)
    warnings.push('Proceeding because accept_incompatible was set. The incompatible-bundle crash warning will not be emailed.')

  await preflightChannelAssignments(c, body.app_id, channelsToAssign, !!body.self_assign, rollout)

  const bundlePath = versionPath(orgId, body.app_id, body.version)
  if (await bundleStorage.statObject(c, bundlePath))
    throw simpleError('error_already_exist', 'A bundle file already exists for this version', { version: body.version })

  const minUpdateVersion = pickHighestMinUpdateVersion(outcomes.map(outcome => outcome.minUpdateVersion))
  const upserted = await (await upsertBundle(c, {
    app_id: body.app_id,
    name: body.version,
    session_key: body.session_key ?? undefined,
    storage_provider: 'r2-direct',
    min_update_version: minUpdateVersion ?? undefined,
    native_packages: body.ignore_metadata_check ? undefined : (body.native_packages ?? []) as unknown as Database['public']['Tables']['app_versions']['Insert']['native_packages'],
    checksum: body.checksum ?? undefined,
    link: body.link || null,
    comment: body.comment || null,
    key_id: body.key_id || undefined,
    cli_version: body.cli_version ?? undefined,
    r2_path: bundlePath,
  }, apikey)).json() as { id: number }

  if (encrypted)
    cliStyleEvent(c, orgId, body.app_id, 'app', 'App encryption v2')

  const claims: UploadSessionClaims = {
    v: 1,
    apikey_id: apikey.id,
    user_id: apikey.user_id,
    app_id: body.app_id,
    owner_org: orgId,
    version_id: upserted.id,
    version: body.version,
    bundle_path: bundlePath,
    ...(delta === 'pack' ? { delta_pack_path: deltaPackPath(orgId, body.app_id, upserted.id) } : {}),
    encrypted,
    ...(body.checksum ? { checksum: body.checksum } : {}),
    checksum_algorithm: encrypted ? 'sha256' : checksumAlgorithmForUpdater(body.updater_version!, body.updater_package),
    delta,
    index_check: body.code_check !== false && !encrypted,
    notify_check: body.code_check !== false && !body.ignore_notify_app_ready && !encrypted,
    checksum_check: checksumCheck,
    channels: outcomes.map(outcome => ({
      name: outcome.channel,
      compatibility: outcome.result,
      incompatible_count: outcome.incompatibleCount,
      ...(outcome.versionOldId ? { version_old_id: outcome.versionOldId } : {}),
      ...(outcome.versionOldName ? { version_old_name: outcome.versionOldName } : {}),
    })),
    ...(rollout ? { rollout } : {}),
    self_assign: !!body.self_assign,
    delete_linked_bundle: !!body.delete_linked_bundle_on_upload,
    accept_incompatible: !!body.accept_incompatible,
  }
  if (encrypted && claims.index_check === false && body.code_check !== false)
    warnings.push('Encrypted bundles cannot be inspected server-side: run the notifyAppReady/index.html check locally before zipping.')

  const { token, expiresAt } = await signBundleUploadToken(getBundleUploadSessionSecret(c), claims)
  const bundleUpload = await presignedPut(c, bundlePath)
  const deltaPackUpload = claims.delta_pack_path ? await presignedPut(c, claims.delta_pack_path) : undefined

  for (const warning of preflight.warnings) {
    const message = (warning as { message?: unknown })?.message
    if (typeof message === 'string')
      warnings.push(message)
  }

  return c.json({
    upload_token: token,
    expires_at: new Date(expiresAt * 1000).toISOString(),
    app_id: body.app_id,
    version: body.version,
    version_id: upserted.id,
    encrypted,
    checksum_algorithm: claims.checksum_algorithm,
    min_update_version: minUpdateVersion ?? null,
    delta: claims.delta,
    bundle_upload: { ...bundleUpload, max_size_bytes: MAX_UPLOAD_LENGTH_BYTES },
    ...(deltaPackUpload ? { delta_pack_upload: { ...deltaPackUpload, max_size_bytes: MAX_DELTA_PACK_BYTES } } : {}),
    channels: outcomes.map(outcome => ({
      name: outcome.channel,
      compatibility: outcome.result,
      incompatible_count: outcome.incompatibleCount,
      reasons: outcome.reasons,
      current_version: outcome.versionOldName ?? null,
    })),
    channels_skipped_same_checksum: channels.filter(channel => !channelsToAssign.includes(channel)),
    warnings,
    next_step: `PUT the zip to bundle_upload.url with header Content-Type: application/zip${deltaPackUpload ? ', PUT the delta pack to delta_pack_upload.url' : ''}, then call POST /bundle/upload/complete with { upload_token } before ${new Date(expiresAt * 1000).toISOString()}.`,
  })
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

async function readClaims(c: UploadContext, rawBody: unknown, apikey: ApikeyRow, allowExpired = false): Promise<UploadSessionClaims> {
  const parsed = safeParseSchema(tokenBodySchema, rawBody)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  let claims: UploadSessionClaims
  try {
    // Abort accepts expired (still authentic) tokens so stale uploads can always be cleaned up.
    claims = await verifyBundleUploadToken<UploadSessionClaims>(getBundleUploadSessionSecret(c), parsed.data.upload_token, allowExpired ? 0 : undefined)
  }
  catch (error) {
    if (error instanceof BundleUploadTokenError) {
      if (error.reason === 'expired')
        throw quickError(410, 'upload_token_expired', 'The upload session expired. Call POST /bundle/upload/abort with the same token to clean it up, then run prepare again.')
      throw quickError(401, 'invalid_upload_token', 'Invalid upload token')
    }
    throw error
  }
  if (claims.v !== 1 || claims.apikey_id !== apikey.id)
    throw quickError(403, 'upload_token_mismatch', 'This upload token was issued to another API key')
  if (!(await checkPermission(c, 'app.upload_bundle', { appId: claims.app_id })))
    throw quickError(403, 'permission_denied', 'Missing permission app.upload_bundle', { app_id: claims.app_id })
  return claims
}

async function loadSessionVersion(c: UploadContext, claims: UploadSessionClaims) {
  const { data: version, error } = await supabaseAdmin(c)
    .from('app_versions')
    .select('id, name, app_id, owner_org, storage_provider, deleted, r2_path, session_key, checksum')
    .eq('id', claims.version_id)
    .maybeSingle()
  if (error)
    throw quickError(503, 'upstream_unavailable', 'Cannot load the upload session version', { error })
  if (!version || version.app_id !== claims.app_id || version.name !== claims.version || version.owner_org !== claims.owner_org)
    throw quickError(404, 'upload_session_not_found', 'The bundle version for this upload session no longer exists')
  return version
}

async function cleanupFailedUpload(c: UploadContext, claims: UploadSessionClaims) {
  for (const path of [claims.bundle_path, claims.delta_pack_path]) {
    if (path)
      await bundleStorage.removeObject(c, path).catch(error => cloudlog({ requestId: c.get('requestId'), message: 'bundle upload cleanup delete failed', path, error }))
  }
  await deleteFailedVersionRow(c, { id: claims.version_id, r2_path: claims.bundle_path, owner_org: claims.owner_org })
}

interface InspectionResult {
  checksum: string
  deltaFiles: DeltaFile[] | null
}

/** One streamed pass over the uploaded zip: archive checksum, CLI code checks and, for server delta, file extraction. */
async function inspectBundle(c: UploadContext, claims: UploadSessionClaims, size: number): Promise<InspectionResult> {
  const tailSize = Math.min(size, ZIP_TAIL_READ_SIZE)
  let entries: ZipEntry[]
  try {
    const tail = await bundleStorage.getObjectRange(c, claims.bundle_path, size - tailSize, tailSize)
    const location = findCentralDirectory(tail, size)
    const tailStart = size - tailSize
    const directory = location.centralDirectoryOffset >= tailStart
      ? tail.subarray(location.centralDirectoryOffset - tailStart, location.centralDirectoryOffset - tailStart + location.centralDirectorySize)
      : await bundleStorage.getObjectRange(c, claims.bundle_path, location.centralDirectoryOffset, location.centralDirectorySize)
    entries = parseCentralDirectory(directory, location.entryCount)
  }
  catch (error) {
    if (error instanceof BundleZipError)
      throw simpleError(error.code, error.message, error.moreInfo)
    throw error
  }

  if (claims.index_check && !hasRootIndexHtml(entries))
    throw simpleError('index_html_missing', 'index.html is missing at the root of the zip. Zip the content of your build folder (webDir), not the folder itself.')

  let deltaEntries: Set<ZipEntry> | null = null
  if (claims.delta === 'server') {
    const selected = selectDeltaEntries(entries)
    const withSpaces = selected.filter(entry => entry.name.includes(' '))
    if (withSpaces.length)
      throw simpleError('delta_file_name_invalid', `Files with spaces in their names (${withSpaces.slice(0, 20).map(entry => entry.name).join(', ')}). Please rename the files.`)
    if (selected.length === 0)
      throw simpleError('delta_manifest_empty', 'Cannot request a manifest upload for an empty manifest')
    if (selected.length > MAX_MANIFEST_ENTRIES)
      throw simpleError('error_manifest_too_large', `Delta manifests are limited to ${MAX_MANIFEST_ENTRIES} files (got ${selected.length}). Upload without delta or reduce files in the web build.`, { max: MAX_MANIFEST_ENTRIES, count: selected.length })
    const totalBytes = selected.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    if (selected.length > MAX_SERVER_DELTA_FILES || totalBytes > MAX_SERVER_DELTA_BYTES)
      throw simpleError('delta_too_large_for_server', `This bundle (${selected.length} files, ${Math.ceil(totalBytes / 1024 / 1024)} MB) exceeds the server-side delta limits (${MAX_SERVER_DELTA_FILES} files, ${MAX_SERVER_DELTA_BYTES / 1024 / 1024} MB). Upload without delta, or send a CLI delta pack. ${CLI_HINT}`, { files: selected.length, bytes: totalBytes })
    deltaEntries = new Set(selected)
  }

  const sha256 = claims.checksum_algorithm === 'sha256' ? createHash('sha256') : null
  const crc32 = claims.checksum_algorithm === 'crc32' ? new Crc32() : null
  let notifyFound = !claims.notify_check
  const deltaFiles: DeltaFile[] = []

  const wants = (entry: ZipEntry) => (claims.notify_check && isJsEntry(entry) && entry.uncompressedSize <= MAX_NOTIFY_SCAN_FILE_BYTES) || !!deltaEntries?.has(entry)
  const stream = (await bundleStorage.readObjectStream(c, claims.bundle_path))?.body
  if (!stream)
    throw quickError(503, 'storage_unavailable', 'Cannot read the uploaded bundle, retry complete')
  try {
    await walkZipStream(stream, entries, wants, async (entry, compressed) => {
      const isDelta = !!deltaEntries?.has(entry)
      if (!isDelta && notifyFound)
        return
      const content = await inflateEntry(entry, compressed)
      if (!notifyFound && isJsEntry(entry) && containsAscii(content, 'notifyAppReady'))
        notifyFound = true
      if (isDelta) {
        const { payload, compression } = compressDeltaFile(content)
        deltaFiles.push({
          file_name: compression === 'brotli' ? `${entry.name}.br` : entry.name,
          file_hash: await sha256Hex(content),
          compression,
          payload,
          sha256: payload === content ? await sha256Hex(content) : await sha256Hex(payload),
        })
      }
    }, (bytes) => {
      sha256?.update(bytes)
      crc32?.update(bytes)
    })
  }
  catch (error) {
    if (error instanceof BundleZipError)
      throw simpleError(error.code, error.message, error.moreInfo)
    throw error
  }

  if (!notifyFound) {
    throw simpleError('notify_app_ready_missing', 'notifyAppReady() is missing in the build folder of your app. see: https://capgo.app/docs/plugins/updater/notifyappready. If you are sure your app has this code, set code_check: false or ignore_notify_app_ready: true')
  }
  return { checksum: sha256 ? sha256.digest('hex') : crc32!.digestHex(), deltaFiles: deltaEntries ? deltaFiles : null }
}

async function readDeltaPack(c: UploadContext, claims: UploadSessionClaims, sessionKey: string | null): Promise<{ manifest: DeltaPackManifest, files: DeltaFile[] }> {
  const path = claims.delta_pack_path!
  const stat = await bundleStorage.statObject(c, path)
  if (!stat)
    throw quickError(409, 'upload_missing', 'The delta pack was not uploaded yet. PUT it to delta_pack_upload.url, then retry complete.', { object: 'delta_pack' })
  if (stat.size > MAX_DELTA_PACK_BYTES)
    throw simpleError('delta_too_large_for_server', `The delta pack is larger than ${MAX_DELTA_PACK_BYTES / 1024 / 1024} MB. Upload without delta. ${CLI_HINT}`)
  const response = await bundleStorage.readObjectStream(c, path)
  if (!response)
    throw quickError(503, 'storage_unavailable', 'Cannot read the delta pack, retry complete')
  const bytes = new Uint8Array(await response.arrayBuffer())
  try {
    const entries = readZipDirectory(bytes)
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    const manifestEntry = byName.get(DELTA_PACK_MANIFEST_NAME)
    if (!manifestEntry)
      throw new BundleZipError('delta_pack_invalid', `The delta pack has no ${DELTA_PACK_MANIFEST_NAME}`)
    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await inflateEntry(manifestEntry, entryDataFromBuffer(bytes, manifestEntry))))
    }
    catch (error) {
      if (error instanceof BundleZipError)
        throw error
      throw new BundleZipError('delta_pack_invalid', `${DELTA_PACK_MANIFEST_NAME} is not valid JSON`)
    }
    const manifest = parseDeltaPackManifest(manifestJson)
    if (manifest.delta_encryption.enabled && !sessionKey)
      throw new BundleZipError('delta_pack_invalid', 'The delta pack is encrypted but the bundle has no session_key')
    if (manifest.entries.length > MAX_MANIFEST_ENTRIES || manifest.entries.length > MAX_SERVER_DELTA_FILES)
      throw new BundleZipError('delta_too_large_for_server', `The delta pack has ${manifest.entries.length} files, above the server limit of ${Math.min(MAX_MANIFEST_ENTRIES, MAX_SERVER_DELTA_FILES)}. ${CLI_HINT}`)
    const withSpaces = manifest.entries.filter(entry => entry.file_name.includes(' '))
    if (withSpaces.length)
      throw new BundleZipError('delta_file_name_invalid', `Files with spaces in their names (${withSpaces.slice(0, 20).map(entry => entry.file_name).join(', ')}). Please rename the files.`)
    const files: DeltaFile[] = []
    for (const [index, entry] of manifest.entries.entries()) {
      const blob = byName.get(entry.pack_path)
      if (!blob)
        throw new BundleZipError('delta_pack_invalid', `Delta pack entry ${index} points to a missing blob ${entry.pack_path}`, { index })
      const payload = await inflateEntry(blob, entryDataFromBuffer(bytes, blob))
      const digest = await sha256Hex(payload)
      if (payload.byteLength !== entry.uploaded_bytes_size || digest !== entry.uploaded_bytes_sha256)
        throw new BundleZipError('delta_pack_invalid', `Delta pack blob ${entry.pack_path} does not match its manifest entry`, { index })
      files.push({ file_name: entry.file_name, file_hash: entry.file_hash, compression: entry.compression, payload, sha256: digest })
    }
    return { manifest, files }
  }
  catch (error) {
    if (error instanceof BundleZipError)
      throw simpleError(error.code, error.message, error.moreInfo)
    throw error
  }
}

/** Reserve manifest paths, write blobs (skipping existing objects) and persist manifest rows like set_manifest. */
async function writeDeltaManifest(
  c: UploadContext,
  claims: UploadSessionClaims,
  sessionKey: string | null,
  files: DeltaFile[],
  format: ManifestUploadRequest['file_hash_format'],
  encryptionEnabled: boolean,
) {
  let request: ManifestUploadRequest
  const capabilitySecret = getEnv(c, 'MANIFEST_UPLOAD_CAPABILITY_SECRET')
  if (capabilitySecret && capabilitySecret === getEnv(c, 'MANIFEST_SIZE_RECEIPT_SECRET'))
    throw quickError(503, 'upload_authorization_unavailable', 'Upload authorization is unavailable')
  const bucket = getManifestReceiptBucket(getEnv(c, 'ENV_NAME'))
  let prefix: string
  let suffixes: string[]
  try {
    request = validateManifestUploadRequest({
      protocol_version: 1,
      version_id: claims.version_id,
      delta_encryption: { enabled: encryptionEnabled },
      manifest_upload_auto_enabled: false,
      file_hash_format: format,
      entries: files.map((file, index) => ({
        id: index,
        file_name: file.file_name,
        compression: file.compression,
        file_hash: file.file_hash,
        uploaded_bytes_sha256: file.sha256,
        uploaded_bytes_size: file.payload.byteLength,
      })),
    })
    const response = await createManifestUploadResponse(request, {
      ownerOrg: claims.owner_org,
      appId: claims.app_id,
      sessionKey,
      secret: capabilitySecret,
      keyId: getEnv(c, 'MANIFEST_UPLOAD_CAPABILITY_KEY_ID'),
      publicBaseUrl: resolveManifestUploadPublicBaseUrl(c.req.url, manifestUploadPublicUrl(c)),
      reservePaths: usesManifestInventory(c)
        ? (reservePrefix, reserveSuffixes, sizes) => withManifestInventory(c, db => reserveManifestPaths(db, bucket, reservePrefix, reserveSuffixes, sizes))
        : undefined,
    })
    prefix = response.default_s3_path_prefix
    const byId = new Map(response.entries.map(entry => [entry.id, entry.s3_path_suffix]))
    suffixes = files.map((_, index) => byId.get(index)!)
  }
  catch (error) {
    if (error instanceof ManifestUploadRequestError)
      throw quickError(error.status, error.code, error.message, error.moreInfo)
    if (error instanceof ManifestInventoryConflict)
      throw quickError(409, 'error_manifest_inventory_conflict', `${error.message}. Retry complete.`, { entries: error.paths.slice(0, 20) })
    throw error
  }

  let uploaded = 0
  const results = await mapWithConcurrency(files, STORAGE_CONCURRENCY, async (file, index) => {
    const path = `${prefix}${suffixes[index]}`
    let info = await bundleStorage.statObject(c, path)
    let evidenceAt = Date.now()
    if (!info) {
      const put = await bundleStorage.putObject(c, path, file.payload)
      evidenceAt = Date.now()
      uploaded++
      info = { size: file.payload.byteLength, etag: put.etag, lastModified: null }
    }
    const facts: ManifestSizeReceiptFacts = {
      version: 2,
      size: info.size,
      signedAt: evidenceAt,
      evidenceAt,
      source: 'r2_read',
      uploadedAt: info.lastModified,
      etag: info.etag,
      etagHash: null,
      objectVersionHash: null,
      objectIdentity: null,
    }
    const entry: ManifestPersistEntry = { file_name: file.file_name, file_hash: file.file_hash, s3_path: path, file_size: info.size }
    return { entry, facts }
  })

  try {
    if (usesManifestInventory(c))
      await withManifestInventory(c, db => registerManifestInventory(db, bucket, results.map(result => ({ path: result.entry.s3_path!, facts: result.facts }))))
  }
  catch (error) {
    if (error instanceof ManifestInventoryConflict)
      throw quickError(409, 'error_manifest_inventory_conflict', `${error.message}. Retry complete.`, { entries: error.paths.slice(0, 20) })
    throw error
  }
  await persistVersionManifestEntries(
    c,
    { id: claims.version_id, app_id: claims.app_id },
    results.map(result => result.entry),
    { s3PathPrefix: `orgs/${claims.owner_org}/apps/${claims.app_id}/`, trustFileSizes: true },
  )
  return { files: files.length, uploaded, reused: files.length - uploaded, brotli: files.filter(file => file.compression === 'brotli').length }
}

async function linkedVersionOf(c: UploadContext, appId: string, versionId: number | null) {
  if (!versionId)
    return null
  const { data } = await supabaseAdmin(c)
    .from('app_versions')
    .select('id, name, deleted')
    .eq('app_id', appId)
    .eq('id', versionId)
    .maybeSingle()
  return data && !data.deleted ? { id: data.id, name: data.name } : null
}

async function linkChannels(c: UploadContext, claims: UploadSessionClaims, apikey: ApikeyRow, channels: string[], targets: Map<string, UploadTargetChannel | null>, warnings: string[]) {
  const updated: string[] = []
  const rollout = claims.rollout
  for (const channel of channels) {
    const target = targets.get(channel) ?? null
    try {
      if (rollout) {
        const previous = target?.rollout_percentage_bps
        const next = rollout.bps ?? previous ?? 0
        const resume = target?.rollout_version === claims.version_id && next > 0
        const paused = rollout.paused ?? (resume ? false : undefined)
        await postChannel(c, {
          app_id: claims.app_id,
          channel,
          rolloutVersion: claims.version,
          rolloutPercentageBps: next,
          rolloutEnabled: next > 0,
          ...(rollout.advance ? { advanceRollout: true } : {}),
          ...(paused !== undefined ? { rolloutPaused: paused } : {}),
          ...(rollout.cache_ttl_seconds != null ? { rolloutCacheTtlSeconds: rollout.cache_ttl_seconds } : {}),
          ...(claims.self_assign ? { allow_device_self_set: true } : {}),
        }, apikey)
      }
      else if (target) {
        const canSelfAssign = claims.self_assign && await checkPermission(c, 'channel.update_settings', { appId: claims.app_id, channelId: target.id })
        if (claims.self_assign && !canSelfAssign)
          warnings.push('Cannot enable device self-assign because this API key lacks channel.update_settings')
        if (canSelfAssign)
          await postChannel(c, { app_id: claims.app_id, channel, version: claims.version, allow_device_self_set: true }, apikey)
        else
          await setChannel(c, { app_id: claims.app_id, version_id: claims.version_id, channel_id: target.id }, apikey)
        if (target.rollout_enabled && target.rollout_version != null)
          warnings.push(`Channel ${channel} has an active progressive rollout. Linking this bundle as the stable version resets that rollout.`)
      }
      else {
        await postChannel(c, { app_id: claims.app_id, channel, version: claims.version, ...(claims.self_assign ? { allow_device_self_set: true } : {}) }, apikey)
      }
      updated.push(channel)
    }
    catch (error) {
      const cause = error instanceof HTTPException ? (error.cause as { error?: string, message?: string } | undefined) : undefined
      throw quickError(error instanceof HTTPException ? error.status : 500, 'channel_update_failed', `Bundle ${claims.version} was uploaded but channel ${channel} was not updated: ${cause?.message ?? (error as Error)?.message ?? 'unknown error'}`, {
        channel,
        cause: cause?.error ?? null,
        updated_channels: updated,
        version_id: claims.version_id,
      })
    }
  }
  return updated
}

export async function completeBundleUpload(c: UploadContext, rawBody: unknown, apikey: ApikeyRow): Promise<Response> {
  const claims = await readClaims(c, rawBody, apikey)
  const version = await loadSessionVersion(c, claims)
  if (version.storage_provider === 'r2')
    throw quickError(409, 'upload_already_completed', 'This upload session was already completed', { version: claims.version })
  if (version.deleted || version.storage_provider !== 'r2-direct')
    throw quickError(409, 'upload_session_invalid', 'The bundle version is no longer uploadable', { storage_provider: version.storage_provider })

  const stat = await bundleStorage.statObject(c, claims.bundle_path).catch((error: unknown) => {
    throw quickError(503, 'storage_unavailable', 'Cannot check the uploaded bundle, retry complete', { reason: (error as Error)?.message })
  })
  if (!stat || stat.size === 0)
    throw quickError(409, 'upload_missing', 'The bundle zip was not uploaded yet. PUT it to bundle_upload.url, then retry complete.', { object: 'bundle' })

  const warnings: string[] = []
  let checksum: string
  let channels = claims.channels.map(channel => channel.name)
  let skippedSameChecksum: string[] = []
  let deltaStats: Awaited<ReturnType<typeof writeDeltaManifest>> | null = null
  let targets: Map<string, UploadTargetChannel | null>
  try {
    if (stat.size > MAX_UPLOAD_LENGTH_BYTES)
      throw simpleError('bundle_too_large', `The bundle size is ${Math.floor(stat.size / 1024 / 1024)} Mb, this is greater than the maximum upload length ${Math.floor(MAX_UPLOAD_LENGTH_BYTES / 1024 / 1024)} Mb`, { size_bytes: stat.size })
    if (stat.size > ALERT_UPLOAD_SIZE_BYTES) {
      const sizeMb = Math.floor(stat.size / 1024 / 1024)
      warnings.push(`The bundle size is ${sizeMb} Mb, this may take a while to download for users. Learn how to optimize your assets https://capgo.app/blog/optimise-your-images-for-updates/`)
      cliStyleEvent(c, claims.owner_org, claims.app_id, 'app-error', 'App Too Large', { size_mb: sizeMb, recommended_size_mb: Math.floor(ALERT_UPLOAD_SIZE_BYTES / 1024 / 1024) })
    }

    let deltaFiles: DeltaFile[] | null = null
    if (claims.encrypted) {
      checksum = claims.checksum!
    }
    else {
      const inspection = await inspectBundle(c, claims, stat.size)
      if (claims.checksum && claims.checksum.toLowerCase() !== inspection.checksum)
        throw simpleError('checksum_mismatch', 'The uploaded zip does not match the checksum given to prepare', { expected: claims.checksum, actual: inspection.checksum })
      checksum = inspection.checksum
      deltaFiles = inspection.deltaFiles
    }

    if (claims.checksum_check) {
      const filtered = await channelsAfterChecksumCheck(c, apikey, claims.app_id, channels, checksum)
      channels = filtered.toAssign
      skippedSameChecksum = filtered.alreadyCurrent
      if (skippedSameChecksum.length)
        warnings.push(`Skipping channel${skippedSameChecksum.length > 1 ? 's' : ''} ${skippedSameChecksum.join(', ')} because they already have this bundle content.`)
    }

    targets = await preflightChannelAssignments(c, claims.app_id, channels, claims.self_assign, claims.rollout)

    if (claims.delta === 'server' && deltaFiles) {
      deltaStats = await writeDeltaManifest(c, claims, version.session_key, deltaFiles, 'sha256_hex', false)
    }
    else if (claims.delta === 'pack') {
      const pack = await readDeltaPack(c, claims, version.session_key)
      deltaStats = await writeDeltaManifest(c, claims, version.session_key, pack.files, pack.manifest.file_hash_format, pack.manifest.delta_encryption.enabled)
      await bundleStorage.removeObject(c, claims.delta_pack_path!).catch(() => undefined)
    }
  }
  catch (error) {
    if (isUploadRejection(error)) {
      try {
        await cleanupFailedUpload(c, claims)
      }
      catch (cleanupError) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'bundle upload cleanup failed', version_id: claims.version_id, error: cleanupError })
      }
    }
    throw error
  }

  // Finalize through the same upsert the CLI uses; legacy manifest jsonb stays null.
  await upsertBundle(c, { app_id: claims.app_id, name: claims.version, checksum, storage_provider: 'r2', manifest: null }, apikey)

  const canDeleteBundle = claims.delete_linked_bundle && await checkPermission(c, 'bundle.delete', { appId: claims.app_id })
  if (claims.delete_linked_bundle && !canDeleteBundle)
    warnings.push('Cannot delete linked bundle on upload because this API key lacks bundle.delete')
  const linkedBundles = canDeleteBundle
    ? await Promise.all(channels.map(async channel => ({ channel, version: await linkedVersionOf(c, claims.app_id, targets.get(channel)?.version ?? null) })))
    : []

  const updatedChannels = await linkChannels(c, claims, apikey, channels, targets, warnings)

  const deletedLinkedBundles: string[] = []
  const deletedIds = new Set<number>()
  for (const linked of linkedBundles) {
    if (!linked.version || !updatedChannels.includes(linked.channel) || deletedIds.has(linked.version.id) || linked.version.id === claims.version_id)
      continue
    try {
      await deleteBundle(c, { app_id: claims.app_id, version: linked.version.name }, apikey)
      deletedIds.add(linked.version.id)
      deletedLinkedBundles.push(linked.version.name)
    }
    catch (error) {
      warnings.push(`Cannot delete linked bundle ${linked.version.name}: ${(error as Error)?.message ?? 'unknown error'}`)
    }
  }

  cliStyleEvent(c, claims.owner_org, claims.app_id, 'app', 'App Uploaded', { bundle: claims.version })
  cliStyleEvent(c, claims.owner_org, claims.app_id, 'app', 'Bundle Uploaded', { bundle: claims.version }, true)
  for (const channel of claims.channels) {
    if (channel.compatibility !== 'incompatible')
      continue
    trackStyleEvent(c, claims.owner_org, claims.app_id, 'Bundle Incompatible', {
      source: 'upload',
      channel: channel.name,
      channel_name: channel.name,
      channel_overwritten: updatedChannels.includes(channel.name),
      version_new_name: claims.version,
      ...(channel.version_old_id ? { version_old_id: channel.version_old_id } : {}),
      ...(channel.version_old_name ? { version_old_name: channel.version_old_name } : {}),
      ...(claims.accept_incompatible ? { incompatibility_accepted: true } : {}),
    })
  }

  return c.json({
    ...BRES,
    app_id: claims.app_id,
    version: claims.version,
    version_id: claims.version_id,
    checksum,
    encrypted: claims.encrypted,
    storage_provider: 'r2',
    size_bytes: stat.size,
    channels_updated: updatedChannels,
    channels_skipped_same_checksum: skippedSameChecksum,
    delta: deltaStats ? { mode: claims.delta, ...deltaStats } : null,
    deleted_linked_bundles: deletedLinkedBundles,
    warnings,
  })
}

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

export async function abortBundleUpload(c: UploadContext, rawBody: unknown, apikey: ApikeyRow): Promise<Response> {
  const claims = await readClaims(c, rawBody, apikey, true)
  const version = await loadSessionVersion(c, claims)
  if (version.storage_provider === 'r2')
    throw quickError(409, 'upload_already_completed', 'This upload session was already completed; delete the bundle instead', { version: claims.version })
  if (version.deleted || version.storage_provider !== 'r2-direct')
    throw quickError(409, 'upload_session_invalid', 'The bundle version is no longer uploadable', { storage_provider: version.storage_provider })
  await cleanupFailedUpload(c, claims)
  return c.json({ ...BRES, app_id: claims.app_id, version: claims.version, aborted: true })
}
