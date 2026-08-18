import type { Buffer } from 'node:buffer'
import type { CapacitorConfig } from '../config'
import type { UploadBundleResult } from '../schemas/bundle'
import type { Database } from '../types/supabase.types'
import type { Compatibility, manifestType } from '../utils'
import type { UploadReporter, UploadSpinner } from './reporter'
import type { OptionsUpload } from './upload_interface'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { confirm as pConfirm, isCancel as pIsCancel, select as pSelect } from '@clack/prompts'
import { greaterOrEqual, parse } from '@std/semver'
// Native fetch is available in Node.js >= 18
import pack from '../../package.json'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { calcKeyId, encryptChecksum, encryptChecksumV3, encryptSource, generateSessionKey } from '../api/crypto'
import { checkAlerts } from '../api/update'
import { loadSavedCredentials } from '../build/credentials'
import { getChecksum } from '../checksum'
import { getRepoStarStatus, isRepoStarredInSession, starRepository } from '../github'
import { confirmWithRememberedChoice } from '../promptPreferences'
import { showReplicationProgress } from '../replicationProgress'
import { CliUserError } from '../shared/cli-user-error'
import { formatTable } from '../terminal-table'
import { usesAlwaysDirectUpdate } from '../updaterConfig'
import { baseKeyV2, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, canPromptInteractively, channelUpdatePackageCliError, checkCompatibilityCloud, checkPlanValidUpload, checkRemoteCliMessages, createSupabaseClient, deletedFailedVersion, deltaManifestTooLargeMessage, findRoot, findSavedKey, formatError, getAppId, getBundleVersion, getCompatibilityDetails, getConfig, getInstalledVersion, getLocalConfig, getLocalDependencies, getOrganizationId, getPMAndCommand, getRemoteChecksums, getRemoteFileConfig, hasCliPermission, invokeCapgoCliApi, isCompatible, isDeprecatedPluginVersion, MAX_MANIFEST_ENTRIES, regexSemver, resolveUserIdFromApiKey, sendEvent, setVersionManifest, updateConfigUpdater, updateOrCreateChannel, updateOrCreateVersion, UPLOAD_TIMEOUT, UPLOAD_TIMEOUT_ERROR_NAME, uploadTimeoutMessage, uploadTUS, uploadUrl, zipFile } from '../utils'
import type { AutoBumpLevel } from '../versionHelpers'
import { autoBumpVersionBy, getVersionSuggestions, interactiveVersionBump, normalizeAutoBumpInput } from '../versionHelpers'
import { resolveAutoBumpLevelFromAi } from './auto-bump-ai'
import { maybePromptBuilderCta, shouldBlockIncompatibleUpload } from './builder-cta'
import { checkIndexPosition, searchInDirectory } from './check'
import { summarizeUploadCompatibility } from './compatibility'
import { prepareBundlePartialFiles, uploadPartial } from './partial'
import { clackUploadReporter, getUploadReporter, runWithUploadReporter } from './reporter'
import { formatUploadChannels, getChannelsToAssignByChecksum, parseUploadChannels } from './upload-channels'

type SupabaseType = Awaited<ReturnType<typeof createSupabaseClient>>
type pmType = ReturnType<typeof getPMAndCommand>
type localConfigType = Awaited<ReturnType<typeof getLocalConfig>>
type UploadTargetChannel = Pick<Database['public']['Tables']['channels']['Row'], 'id' | 'public' | 'version' | 'rollout_version' | 'rollout_enabled'>

export type { UploadBundleResult }
export type { UploadReporter, UploadSpinner }

const UPLOAD_CANCELLED_BY_USER = 'Upload cancelled by user'

const log = {
  info: (message: string) => getUploadReporter().info(message),
  warn: (message: string) => getUploadReporter().warn(message),
  error: (message: string) => getUploadReporter().error(message),
  success: (message: string) => getUploadReporter().success(message),
}

// The upload path's single failure chokepoint. Every abort here is a deliberate,
// message-carrying stop — a bad flag, a duplicate version, a cancelled prompt,
// a backend refusal — not a CLI crash. Throwing `CliUserError` opts the whole
// path out of error tracking by type (via `shouldCapturePosthogException`), which
// covers `Version X already exists` and `Upload cancelled by user` without
// matching on message text. The non-zero exit and analytics events are unchanged;
// only the `$exception` capture goes away.
function uploadFail(message: string): never {
  log.error(message)
  throw new CliUserError(message)
}

async function uploadFailIfChannelError(error: unknown, fallback: () => string | Promise<string>): Promise<never> {
  const packageError = await channelUpdatePackageCliError(error)
  uploadFail(packageError || await fallback())
}

// A user-initiated cancel is an expected exit, not a crash: warn instead of
// error, and throw `CliUserError` so error tracking skips it.
function uploadCancel(): never {
  log.warn(UPLOAD_CANCELLED_BY_USER)
  throw new CliUserError(UPLOAD_CANCELLED_BY_USER)
}

/**
 * Thrown when `--fail-on-incompatible` aborts an upload because the bundle is
 * incompatible with the channel's current native packages. A dedicated type lets
 * `uploadBundle` skip the generic "retry the upload?" prompt — retrying an
 * incompatible bundle is pointless.
 *
 * Extends `CliUserError` so `shouldCapturePosthogException` skips it: the
 * `--fail-on-incompatible` abort is a state the user asked for, not a crash, so
 * it must not open an error tracking `$exception` issue. The non-zero exit, the
 * printed message, and the `Bundle Upload Blocked` event stay unchanged.
 */
export class IncompatibleBundleError extends CliUserError {}

async function persistVersionData(
  supabase: SupabaseType,
  versionData: Database['public']['Tables']['app_versions']['Insert'],
  action: 'add' | 'update',
) {
  const { error } = await updateOrCreateVersion(supabase, versionData)
  if (error)
    uploadFail(`Cannot ${action} bundle ${formatError(error)}`)
}

/**
 * Display a compatibility table for the given packages
 */
function displayCompatibilityTable(packages: Compatibility[]) {
  const rows = packages.map((entry) => {
    const details = getCompatibilityDetails(entry)
    return [
      entry.name,
      entry.localVersion || '-',
      entry.remoteVersion || '-',
      details.compatible ? '✅' : '❌',
      details.message,
    ]
  })

  log.info(formatTable({
    headers: ['Package', 'Local', 'Remote', 'Status', 'Details'],
    rows,
  }))
}

async function getBundle(config: CapacitorConfig, options: OptionsUpload) {
  const pkgVersion = getBundleVersion('', options.packageJson)
  // create bundle name format : 1.0.0-beta.x where x is a uuid
  const bundle = options.bundle
    || config?.plugins?.CapacitorUpdater?.version
    || pkgVersion
    || `0.0.1-beta.local-${randomUUID().split('-')[0]}`

  if (!regexSemver.test(bundle)) {
    uploadFail(`Your bundle name ${bundle}, is not valid it should follow semver convention : https://semver.org/`)
  }

  return bundle
}

function getApikey(options: OptionsUpload) {
  const apikey = options.apikey || findSavedKey()
  if (!apikey) {
    uploadFail('Missing API key, you need to provide an API key to upload your bundle')
  }

  return apikey
}

function getAppIdAndPath(appId: string | undefined, options: OptionsUpload, config: CapacitorConfig) {
  const finalAppId = getAppId(appId, config)
  const path = options.path || config?.webDir

  if (!finalAppId) {
    uploadFail('Missing argument, you need to provide a appid or be in a capacitor project')
  }
  if (!path) {
    uploadFail('Missing argument, you need to provide a path (--path), or be in a capacitor project')
  }

  if (!existsSync(path)) {
    uploadFail(`Path ${path} does not exist, build your app first, or provide a valid path`)
  }

  return { appid: finalAppId, path }
}

function checkNotifyAppReady(options: OptionsUpload, path: string) {
  const checkNotifyAppReady = options.codeCheck

  if (typeof checkNotifyAppReady === 'undefined' || checkNotifyAppReady) {
    const isPluginConfigured = searchInDirectory(path, 'notifyAppReady')
    if (!isPluginConfigured) {
      uploadFail(`notifyAppReady() is missing in the build folder of your app. see: https://capgo.app/docs/plugin/api/#notifyappready
      If you are sure your app has this code, you can use the --no-code-check option`)
    }
    const foundIndex = checkIndexPosition(path)
    if (!foundIndex) {
      uploadFail(`index.html is missing in the root folder of ${path}`)
    }
  }
}

async function verifyCompatibility(supabase: SupabaseType, pm: pmType, options: OptionsUpload, channel: string, appid: string, bundle: string, orgId: string) {
  // Check compatibility here
  const ignoreMetadataCheck = options.ignoreMetadataCheck
  const autoMinUpdateVersion = options.autoMinUpdateVersion
  let minUpdateVersion = options.minUpdateVersion

  const { data: channelData, error: channelError } = await supabase
    .from('channels')
    .select('disable_auto_update, version ( id, name, min_update_version, native_packages )')
    .eq('name', channel)
    .eq('app_id', appid)
    .maybeSingle()

  if (channelError)
    uploadFail(`Cannot load channel ${channel} for compatibility checks ${formatError(channelError)}`)

  // The version currently live on the channel — what the new bundle is compared
  // against. Captured here (before the channel is repointed at the new bundle)
  // so the incompatible-bundle Bento signal can report the prior version.
  const oldVersion = (channelData?.version ?? undefined) as unknown as { id?: number | string, name?: string } | undefined

  const updateMetadataRequired = !!channelData && channelData.disable_auto_update === 'version_number'

  let localDependencies: Awaited<ReturnType<typeof getLocalDependencies>> | undefined
  let finalCompatibility: Awaited<ReturnType<typeof checkCompatibilityCloud>>['finalCompatibility'] | undefined

  // We only check compatibility IF the channel exists
  if (!channelError && channelData && channelData.version && (channelData.version as any).native_packages && !ignoreMetadataCheck) {
    const spinner = getUploadReporter().spinner()
    spinner.start(`Checking bundle compatibility with channel ${channel}`)
    const {
      finalCompatibility: finalCompatibilityWithChannel,
      localDependencies: localDependenciesWithChannel,
    } = await checkCompatibilityCloud(supabase, appid, channel, options.packageJson, options.nodeModules)

    finalCompatibility = finalCompatibilityWithChannel
    localDependencies = localDependenciesWithChannel

    // Check if any package is incompatible
    const incompatiblePackages = finalCompatibility.filter(x => !isCompatible(x))
    if (incompatiblePackages.length > 0) {
      spinner.error(`Bundle NOT compatible with ${channel} channel`)
      log.warn('')
      displayCompatibilityTable(finalCompatibility)
      log.warn('')
      log.warn('An app store update may be required for these changes to take effect.')

      if (autoMinUpdateVersion) {
        minUpdateVersion = bundle
        log.info(`Auto set min-update-version to ${minUpdateVersion}`)
      }
    }
    else if (autoMinUpdateVersion) {
      try {
        const { min_update_version: lastMinUpdateVersion } = channelData.version as any
        if (!lastMinUpdateVersion || !regexSemver.test(lastMinUpdateVersion))
          uploadFail('Invalid remote min update version, skipping auto setting compatibility')

        minUpdateVersion = lastMinUpdateVersion
        spinner.stop(`Auto set min-update-version to ${minUpdateVersion}`)
      }
      catch {
        uploadFail(`Cannot auto set compatibility, invalid data ${channelData}`)
      }
    }
    else {
      spinner.stop(`Bundle compatible with ${channel} channel`)
    }
  }
  else if (!ignoreMetadataCheck) {
    log.warn(`Channel ${channel} is new or it's your first upload with compatibility check, it will be ignored this time`)
    localDependencies = await getLocalDependencies(options.packageJson, options.nodeModules)

    if (autoMinUpdateVersion) {
      minUpdateVersion = bundle
      log.info(`Auto set min-update-version to ${minUpdateVersion}`)
    }
  }

  const compatibilitySkipReason = finalCompatibility
    ? undefined
    : (ignoreMetadataCheck ? 'ignore_metadata_check' : 'no_remote_metadata')
  const compatibilitySummary = summarizeUploadCompatibility(finalCompatibility)
  void trackEvent({
    channel: 'bundle',
    event: 'Bundle Upload Compatibility Checked',
    icon: '🧪',
    apikey: options.apikey,
    appId: appid,
    orgId,
    tags: {
      result: compatibilitySummary.result,
      incompatible_count: compatibilitySummary.incompatibleCount,
      // `channel` is overwritten by the event category ('bundle') in PostHog, so
      // also send channel_name to keep the app channel queryable.
      channel,
      channel_name: channel,
      ...(compatibilitySummary.reasons.length > 0 ? { reasons: compatibilitySummary.reasons.join(',') } : {}),
      ...(compatibilitySkipReason ? { skip_reason: compatibilitySkipReason } : {}),
    },
  })

  if (updateMetadataRequired && !minUpdateVersion && !ignoreMetadataCheck) {
    uploadFail('You need to provide a min-update-version to upload a bundle to this channel')
  }

  if (minUpdateVersion) {
    if (!regexSemver.test(minUpdateVersion))
      uploadFail(`Your minimal version update ${minUpdateVersion}, is not valid it should follow semver convention : https://semver.org/`)
  }

  const hashedLocalDependencies = localDependencies
    ? new Map(localDependencies
        .filter(a => !!a.native && a.native !== undefined)
        .map(a => [a.name, a]))
    : new Map()

  const nativePackages = (hashedLocalDependencies.size > 0 || !options.ignoreMetadataCheck)
    ? Array.from(hashedLocalDependencies, ([name, value]) => ({
        name,
        version: value.version,
        requested_version: value.requested_version,
        ...(value.ios_checksum && { ios_checksum: value.ios_checksum }),
        ...(value.android_checksum && { android_checksum: value.android_checksum }),
      }))
    : undefined

  return {
    nativePackages,
    minUpdateVersion,
    incompatibleCount: compatibilitySummary.incompatibleCount,
    compatibility: {
      result: compatibilitySummary.result,
      versionOldId: oldVersion?.id != null ? String(oldVersion.id) : undefined,
      versionOldName: oldVersion?.name,
    },
  }
}

async function checkVersionExists(supabase: SupabaseType, appid: string, bundle: string, versionExistsOk = false, interactive = false): Promise<boolean | string> {
  // check if app already exist
  const { data: appVersion, error: appVersionError } = await supabase
    .rpc('exist_app_versions', { appid, name_version: bundle })
    .single()

  if (appVersionError)
    uploadFail(`Cannot check if version ${bundle} already exists ${formatError(appVersionError)}`)

  if (appVersion) {
    if (versionExistsOk) {
      log.warn(`Version ${bundle} already exists - exiting gracefully due to --version-exists-ok option`)
      getUploadReporter().outro('Bundle version already exists - exiting gracefully 🎉')
      return true
    }

    // Interactive mode - offer to bump version
    if (interactive) {
      log.error(`❌ Version ${bundle} already exists`)

      const suggestions = getVersionSuggestions(bundle)
      log.info(`💡 Here are some suggestions:`)
      suggestions.forEach((suggestion, idx) => {
        log.info(`   ${idx + 1}. ${suggestion}`)
      })

      const choice = await pSelect({
        message: 'What would you like to do?',
        options: [
          { value: 'suggest1', label: `Use ${suggestions[0]}` },
          { value: 'suggest2', label: `Use ${suggestions[1]}` },
          { value: 'suggest3', label: `Use ${suggestions[2]}` },
          { value: 'suggest4', label: `Use ${suggestions[3]}` },
          { value: 'custom', label: 'Enter a custom version' },
          { value: 'cancel', label: 'Cancel upload' },
        ],
      })

      if (pIsCancel(choice) || typeof choice !== 'string' || choice === 'cancel') {
        uploadCancel()
      }

      let newVersion: string
      if (choice === 'custom') {
        const customVersion = await interactiveVersionBump(bundle, 'upload')
        if (!customVersion) {
          uploadCancel()
        }
        newVersion = customVersion
      }
      else {
        const suggestionIndex = Number.parseInt(choice.replace('suggest', '')) - 1
        newVersion = suggestions[suggestionIndex]
      }

      log.info(`🔄 Retrying with new version: ${newVersion}`)
      return newVersion // Return the new version to retry with
    }

    uploadFail(`Version ${bundle} already exists`)
  }

  return false
}

function pickHighestMinUpdateVersion(results: Array<{ minUpdateVersion?: string }>): string | undefined {
  let selected: string | undefined

  for (const { minUpdateVersion } of results) {
    if (!minUpdateVersion)
      continue
    if (!selected || greaterOrEqual(parse(minUpdateVersion), parse(selected)))
      selected = minUpdateVersion
  }

  return selected
}

async function getChannelsToAssignAfterChecksumCheck(supabase: SupabaseType, appid: string, channels: string[], currentChecksum: string): Promise<string[]> {
  const remoteChecksums = new Map<string, string | null>()

  for (const targetChannel of channels) {
    const s = getUploadReporter().spinner()
    s.start(`Checking bundle checksum compatibility with channel ${targetChannel}`)
    const remoteChecksum = await getRemoteChecksums(supabase, appid, targetChannel)
    remoteChecksums.set(targetChannel, remoteChecksum)

    if (!remoteChecksum) {
      s.stop(`No checksum found for channel ${targetChannel}, the bundle will be uploaded`)
      continue
    }

    if (remoteChecksum === currentChecksum) {
      s.stop(`Channel ${targetChannel} already has this bundle checksum`)
      continue
    }

    s.stop(`Checksum compatible with ${targetChannel} channel`)
  }

  const { channelsAlreadyCurrent, channelsToAssign } = getChannelsToAssignByChecksum(channels, currentChecksum, remoteChecksums)

  if (channelsToAssign.length === 0) {
    const channelLabel = formatUploadChannels(channels)
    log.error(`Cannot upload the same bundle content.\nCurrent bundle checksum matches remote bundle for channel${channels.length > 1 ? 's' : ''} ${channelLabel}\nDid you build your app before uploading?\nPS: You can ignore this check with "--ignore-checksum-check"`)
    throw new Error('Cannot upload the same bundle content')
  }

  if (channelsAlreadyCurrent.length > 0) {
    log.warn(`Skipping channel${channelsAlreadyCurrent.length > 1 ? 's' : ''} ${formatUploadChannels(channelsAlreadyCurrent)} because ${channelsAlreadyCurrent.length > 1 ? 'they already have' : 'it already has'} this bundle content.`)
  }

  return channelsToAssign
}

async function prepareBundleFile(path: string, options: OptionsUpload, apikey: string, orgId: string, appid: string, maxUploadLength: number, alertUploadSize: number, publicKeyFromConfig?: string) {
  let ivSessionKey
  let sessionKey
  let checksum = ''
  let zipped: Buffer | null = null
  let encryptionMethod = 'none' as 'none' | 'v2' | 'v1'
  let finalKeyData = ''
  let keyId = ''
  const keyV2 = options.keyV2
  const noKey = options.key === false

  const s = getUploadReporter().spinner()
  s.start(`Zipping bundle from ${path}`)
  zipped = await zipFile(path)
  s.message(`Calculating checksum`)
  const root = findRoot(cwd())
  const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
  let useSha256 = false
  let coerced
  try {
    coerced = updaterVersion ? parse(updaterVersion) : undefined
  }
  catch {
    coerced = undefined
  }
  if (!updaterVersion) {
    uploadFail('Cannot find @capgo/capacitor-updater in node_modules, please install it first with your package manager')
  }
  else if (coerced) {
    // Use SHA256 for v5.10.0+, v6.25.0+ and v7.0.30+
    useSha256 = !isDeprecatedPluginVersion(coerced, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7)
  }
  else if (updaterVersion === 'link:@capgo/capacitor-updater' || updaterVersion === 'file:..' || updaterVersion === 'file:../') {
    log.warn('Using local @capgo/capacitor-updater. Assuming latest version for checksum calculation.')
    useSha256 = true
  }
  const forceCrc32 = options.forceCrc32Checksum === true
  const shouldUseSha256 = !forceCrc32 && (((keyV2 || options.keyDataV2 || existsSync(baseKeyV2)) && !noKey) || useSha256)
  checksum = await getChecksum(zipped, shouldUseSha256 ? 'sha256' : 'crc32')
  s.stop(`Checksum ${shouldUseSha256 ? 'SHA256' : 'CRC32'}${forceCrc32 ? ' (forced)' : ''}: ${checksum}`)
  // key should be undefined or a string if false it should ignore encryption DO NOT REPLACE key === false With !key it will not work
  if (noKey) {
    log.info(`Encryption ignored`)
  }
  else if ((keyV2 || existsSync(baseKeyV2) || options.keyDataV2) && !options.oldEncryption) {
    const privateKey = typeof keyV2 === 'string' ? keyV2 : baseKeyV2
    let keyDataV2 = options.keyDataV2 || ''
    if (!keyDataV2 && !existsSync(privateKey))
      uploadFail(`Cannot find private key ${privateKey}`)
    await sendEvent(apikey, {
      channel: 'app',
      event: 'App encryption v2',
      icon: '🔑',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appid,
      },
      notify: false,
    }, options.verbose)
    if (!keyDataV2) {
      const keyFile = readFileSync(privateKey)
      keyDataV2 = keyFile.toString()
    }
    // Use V3 encryption for new plugin versions (5.30.0+, 6.30.0+, 7.30.0+)
    const supportsV3Checksum = coerced && !isDeprecatedPluginVersion(coerced, '5.30.0', '6.30.0', '7.30.0')
    log.info(`Encrypting your bundle with ${supportsV3Checksum ? 'V3' : 'V2'}`)
    const { sessionKey: sKey, ivSessionKey: ivKey } = generateSessionKey(keyDataV2)
    const encryptedData = encryptSource(zipped, sKey, ivKey)
    checksum = supportsV3Checksum
      ? encryptChecksumV3(checksum, keyDataV2)
      : encryptChecksum(checksum, keyDataV2)
    ivSessionKey = ivKey
    sessionKey = sKey
    encryptionMethod = 'v2'
    finalKeyData = keyDataV2
    // Calculate key_id from the public key in capacitor config
    // This matches the key_id sent by devices for verification
    if (publicKeyFromConfig) {
      keyId = calcKeyId(publicKeyFromConfig)
      if (options.verbose) {
        log.info(`[Verbose] Encryption key_id: ${keyId}`)
      }
    }
    if (options.displayIvSession) {
      log.info(`Your Iv Session key is ${ivSessionKey},
    keep it safe, you will need it to decrypt your bundle.
    It will be also visible in your dashboard\n`)
    }
    zipped = encryptedData
  }
  const mbSize = Math.floor((zipped?.byteLength ?? 0) / 1024 / 1024)
  const mbSizeMax = Math.floor(maxUploadLength / 1024 / 1024)
  if (zipped?.byteLength > maxUploadLength) {
    uploadFail(`The bundle size is ${mbSize} Mb, this is greater than the maximum upload length ${mbSizeMax} Mb, please reduce the size of your bundle`)
  }
  else if (zipped?.byteLength > alertUploadSize) {
    log.warn(`WARNING !!\nThe bundle size is ${mbSize} Mb, this may take a while to download for users\n`)
    log.info(`Learn how to optimize your assets https://capgo.app/blog/optimise-your-images-for-updates/\n`)

    if (options.verbose) {
      log.info(`[Verbose] Bundle size details:`)
      log.info(`  - Actual size: ${mbSize} MB (${zipped?.byteLength} bytes)`)
      log.info(`  - Alert threshold: ${Math.floor(alertUploadSize / 1024 / 1024)} MB`)
      log.info(`  - Maximum allowed: ${mbSizeMax} MB`)
      log.info(`[Verbose] Sending 'App Too Large' event to analytics...`)
    }

    await sendEvent(apikey, {
      channel: 'app-error',
      event: 'App Too Large',
      icon: '🚛',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appid,
        'size_mb': mbSize,
      },
      notify: false,
    }, options.verbose)

    if (options.verbose)
      log.info(`[Verbose] Event sent successfully`)
  }
  else if (options.verbose) {
    log.info(`[Verbose] Bundle size OK: ${mbSize} MB (under ${Math.floor(alertUploadSize / 1024 / 1024)} MB alert threshold)`)
  }

  if (options.verbose)
    log.info(`[Verbose] Bundle preparation complete, returning bundle data`)

  return { zipped, ivSessionKey, sessionKey, checksum, encryptionMethod, finalKeyData, keyId }
}

async function uploadBundleToCapgoCloud(apikey: string, supabase: SupabaseType, appid: string, bundle: string, orgId: string, zipped: Buffer, options: OptionsUpload, tusChunkSize: number) {
  const spinner = getUploadReporter().spinner()
  spinner.start(`Uploading Bundle`)
  const startTime = performance.now()
  let isTus = false

  if (options.verbose) {
    log.info(`[Verbose] uploadBundleToCapgoCloud called:`)
    log.info(`  - Bundle size: ${Math.floor(zipped.byteLength / 1024)} KB`)
    log.info(`  - App ID: ${appid}`)
    log.info(`  - Bundle version: ${bundle}`)
    log.info(`  - Chunk size: ${Math.floor(tusChunkSize / 1024 / 1024)} MB`)
  }

  if (options.dryUpload) {
    spinner.stop(`Dry run, bundle not uploaded\nBundle uploaded 💪 in 0 seconds`)
    if (options.verbose)
      log.info(`[Verbose] Dry upload mode - skipping actual upload`)
    return
  }

  try {
    const localConfig = await getLocalConfig()
    if (options.verbose)
      log.info(`[Verbose] Local config retrieved for upload`)

    if ((options.multipart !== undefined && options.multipart) || (options.tus !== undefined && options.tus)) {
      if (options.multipart) {
        log.info(`Uploading bundle with multipart is deprecated, we upload with TUS instead`)
      }
      else {
        log.info(`Uploading bundle with TUS protocol`)
      }

      if (options.verbose) {
        log.info(`[Verbose] Starting TUS resumable upload...`)
        log.info(`  - Host: ${localConfig.hostWeb}`)
        log.info(`  - Chunk size: ${Math.floor(tusChunkSize / 1024 / 1024)} MB`)
      }

      await uploadTUS(apikey, zipped, orgId, appid, bundle, spinner, localConfig, tusChunkSize)
      isTus = true

      if (options.verbose)
        log.info(`[Verbose] TUS upload completed, updating database with R2 path...`)

      const filePath = `orgs/${orgId}/apps/${appid}/${bundle}.zip`
      const { error: changeError } = await supabase
        .from('app_versions')
        .update({ r2_path: filePath })
        .eq('name', bundle)
        .eq('app_id', appid)

      if (changeError) {
        log.error(`Cannot finish TUS upload ${formatError(changeError)}`)
        if (options.verbose)
          log.info(`[Verbose] Database update failed: ${formatError(changeError)}`)
        throw new Error('Cannot finish TUS upload')
      }

      if (options.verbose)
        log.info(`[Verbose] Database updated with R2 path: ${filePath}`)
    }
    else {
      if (options.verbose)
        log.info(`[Verbose] Using standard upload (non-TUS), getting presigned URL...`)

      const url = await uploadUrl(apikey, appid, bundle, options)
      if (!url) {
        log.error(`Cannot get upload url`)
        if (options.verbose)
          log.info(`[Verbose] Failed to retrieve presigned upload URL from database`)
        throw new Error('Cannot get upload url')
      }

      const uploadTimeoutMs = options.timeout || UPLOAD_TIMEOUT

      if (options.verbose) {
        log.info(`[Verbose] Presigned URL obtained, uploading via HTTP PUT...`)
        log.info(`  - Timeout: ${uploadTimeoutMs}ms`)
        log.info(`  - Retry attempts: 0 (standard upload does not retry, use --tus for resumable retries)`)
        log.info(`  - Content-Type: application/zip`)
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMs)

      try {
        const response = await fetch(url, {
          method: 'PUT',
          body: zipped,
          headers: {
            'Content-Type': 'application/zip',
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
      }
      catch (putError: any) {
        // A timeout fires as an AbortError from our controller. Convert it into a
        // typed, descriptive error so the user sees what happened and how to work
        // around it, instead of the raw "This operation was aborted" message.
        if (controller.signal.aborted || putError?.name === 'AbortError') {
          const timeoutError = new Error(uploadTimeoutMessage(uploadTimeoutMs))
          timeoutError.name = UPLOAD_TIMEOUT_ERROR_NAME
          throw timeoutError
        }
        throw putError
      }
      finally {
        clearTimeout(timeoutId)
      }

      if (options.verbose)
        log.info(`[Verbose] HTTP PUT upload completed successfully`)
    }
  }
  catch (errorUpload: any) {
    const endTime = performance.now()
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
    spinner.error(`Failed to upload bundle ( after ${uploadTime} seconds)`)

    if (options.verbose) {
      log.info(`[Verbose] Upload failed after ${uploadTime} seconds`)
      log.info(`[Verbose] Error type: ${errorUpload instanceof Error ? 'Error' : typeof errorUpload}`)
    }

    if (errorUpload instanceof Error && errorUpload.name === UPLOAD_TIMEOUT_ERROR_NAME) {
      // Already a descriptive, actionable message (names the elapsed budget and
      // points at --timeout / --tus); print it as-is without the generic prefix.
      log.error(errorUpload.message)
    }
    else if (errorUpload instanceof Error && errorUpload.message.includes('HTTP error')) {
      try {
        const statusMatch = errorUpload.message.match(/status: (\d+)/)
        const status = statusMatch ? statusMatch[1] : 'unknown'
        log.error(`Upload failed with status ${status}: ${errorUpload.message}`)
      }
      catch {
        log.error(`Upload failed: ${errorUpload.message}`)
      }
    }
    else {
      if (options.verbose)
        log.info(`[Verbose] Non-HTTP error: ${formatError(errorUpload)}`)

      if (!options.tus) {
        log.error(`Cannot upload bundle ( try again with --tus option) ${formatError(errorUpload)}`)
      }
      else {
        log.error(`Cannot upload bundle please contact support if the issue persists ${formatError(errorUpload)}`)
      }
    }

    if (options.verbose)
      log.info(`[Verbose] Cleaning up failed version from database...`)

    try {
      await deletedFailedVersion(apikey, appid, bundle, options)
      if (options.verbose)
        log.info(`[Verbose] Failed version cleaned up`)
    }
    catch (cleanupError) {
      log.error(`Cleanup of the incomplete version failed (${formatError(cleanupError)}); delete bundle ${bundle} manually before retrying.`)
    }

    throw errorUpload instanceof Error ? errorUpload : new Error(String(errorUpload))
  }

  const endTime = performance.now()
  const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
  spinner.stop(`Bundle uploaded 💪 in (${uploadTime} seconds)`)

  if (options.verbose) {
    log.info(`[Verbose] Upload successful:`)
    log.info(`  - Upload time: ${uploadTime} seconds`)
    log.info(`  - Upload method: ${isTus ? 'TUS (resumable)' : 'Standard HTTP PUT'}`)
    log.info(`  - Bundle size: ${Math.floor(zipped.byteLength / 1024)} KB`)
    log.info(`[Verbose] Sending performance event...`)
  }

  await sendEvent(apikey, {
    channel: 'performance',
    event: isTus ? 'TUS upload zip performance' : 'Upload zip performance',
    icon: '🚄',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appid,
      'time': uploadTime,
    },
    notify: false,
  }, options.verbose)

  if (options.verbose)
    log.info(`[Verbose] Performance event sent successfully`)
}

type LinkedChannelVersion = {
  deleted: boolean
  id: number
  name: string
} | null

function getUploadRolloutPercentageBps(options: OptionsUpload) {
  if (options.rollout == null && options.rolloutPercentageBps == null)
    return undefined

  if (options.rolloutPercentageBps != null)
    return options.rolloutPercentageBps

  return Math.round((options.rollout ?? 0) * 100)
}

function formatRolloutPercentage(bps: number) {
  return `${Number((bps / 100).toFixed(2))}%`
}

async function getVersionIdForChannelUpdate(supabase: SupabaseType, apikey: string, appid: string, bundle: string) {
  const { data: versionId } = await supabase
    .rpc('get_app_versions', { apikey, name_version: bundle, appid })
    .single()

  if (!versionId)
    uploadFail('Cannot get version id, cannot set channel')

  return versionId
}


async function versionExistsOnRemote(supabase: SupabaseType, appid: string, bundle: string): Promise<boolean> {
  const { data: appVersion, error: appVersionError } = await supabase
    .rpc('exist_app_versions', { appid, name_version: bundle })
    .single()

  if (appVersionError)
    uploadFail(`Cannot check if version ${bundle} already exists ${formatError(appVersionError)}`)

  return !!appVersion
}

async function getLatestRemoteAppVersion(supabase: SupabaseType, appid: string): Promise<string | null> {
  // Include deleted versions: Capgo forbids reusing deleted names (exist_app_versions
  // still treats them as occupied), so occupancy must drive the auto-bump base.
  const { data, error } = await supabase
    .from('app_versions')
    .select('name')
    .eq('app_id', appid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log.warn(`Cannot fetch latest remote version ${formatError(error)}`)
    return null
  }

  return data?.name ?? null
}

async function findFreeAutoBumpCandidate(
  supabase: SupabaseType,
  appid: string,
  startCandidate: string,
  level: AutoBumpLevel,
  baseVersion: string,
): Promise<string> {
  let candidate = startCandidate
  for (let attempt = 0; attempt < 100; attempt++) {
    const exists = await versionExistsOnRemote(supabase, appid, candidate)
    if (!exists) {
      if (candidate !== baseVersion)
        log.info(`🔢 Auto-bumped (${level}) version from ${baseVersion} to ${candidate}`)
      return candidate
    }
    candidate = autoBumpVersionBy(candidate, level)
  }

  uploadFail(`Could not find a free ${level}-bumped version after 100 attempts (started from ${baseVersion})`)
}

async function resolveAutoBumpVersion(
  supabase: SupabaseType,
  appid: string,
  channels: string[],
  localBundle: string,
  level: AutoBumpLevel,
): Promise<string> {
  const primaryChannel = channels[0]
  const linked = await getLinkedBundleOnChannel(supabase, appid, primaryChannel)
  let baseVersion = linked?.name ?? null

  if (baseVersion) {
    log.info(`📦 Auto-bump base from channel ${primaryChannel}: ${baseVersion}`)
  }
  else {
    baseVersion = await getLatestRemoteAppVersion(supabase, appid)
    if (baseVersion)
      log.info(`📦 Auto-bump base from latest remote app version: ${baseVersion}`)
  }

  if (!baseVersion) {
    log.info(`ℹ️ No remote versions found for auto-bump, keeping local version ${localBundle}`)
    return findFreeAutoBumpCandidate(supabase, appid, localBundle, level, localBundle)
  }

  const candidate = autoBumpVersionBy(baseVersion, level)
  return findFreeAutoBumpCandidate(supabase, appid, candidate, level, baseVersion)
}

// It is really important that this function never terminates the program, it should always return.
async function getLinkedBundleOnChannel(supabase: SupabaseType, appid: string, channel: string): Promise<LinkedChannelVersion> {
  const { data, error } = await supabase
    .from('channels')
    .select('version:app_versions!channels_version_fkey( id, name, deleted )')
    .eq('app_id', appid)
    .eq('name', channel)

  if (error) {
    log.error(`Cannot delete linked bundle on upload ${formatError(error)}`)
    return null
  }

  if (data.length === 0) {
    log.warn('No linked bundle found in the channel you are trying to upload to')
    return null
  }

  const version = data[0].version
  if (!version) {
    log.warn('No linked bundle found in the channel you are trying to upload to')
    return null
  }
  if (version.deleted) {
    log.warn('The linked bundle is already deleted')
    return null
  }

  return version
}

// It is really important that this function never terminates the program, it should always return.
async function deleteLinkedBundleOnUpload(supabase: SupabaseType, version: LinkedChannelVersion) {
  if (!version)
    return

  const { error: deleteError } = await supabase
    .from('app_versions')
    .update({ deleted: true })
    .eq('id', version.id)

  if (deleteError) {
    log.error(`Cannot delete linked bundle on upload ${formatError(deleteError)}`)
    return
  }

  log.info(`Linked bundle ${version.name} deleted`)
}

async function findUploadTargetChannel(
  supabase: SupabaseType,
  appid: string,
  channel: string,
  failOnError = true,
): Promise<UploadTargetChannel | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('id, public, version, rollout_version, rollout_enabled')
    .eq('app_id', appid)
    .eq('name', channel)
    .maybeSingle()

  if (error && failOnError)
    uploadFail(`Cannot check channel ${channel}: ${formatError(error)}`)

  return data
}

async function preflightRequiredChannelAssignments(
  supabase: SupabaseType,
  apikey: string,
  appid: string,
  channels: string[],
  selfAssign = false,
  rolloutPercentageBps?: number,
): Promise<Map<string, UploadTargetChannel | null>> {
  const uploadTargetChannels = new Map<string, UploadTargetChannel | null>()

  for (const channel of new Set(channels)) {
    const targetChannel = await findUploadTargetChannel(supabase, appid, channel)

    if (targetChannel) {
      uploadTargetChannels.set(channel, targetChannel)
      const canPromoteTargetChannel = await hasCliPermission(supabase, apikey, 'channel.promote_bundle', { appId: appid, channelId: targetChannel.id })
      if (!canPromoteTargetChannel)
        uploadFail('Cannot set channel because this API key lacks channel.promote_bundle for the target channel')

      const requiresSettingsUpdate = selfAssign || rolloutPercentageBps != null
      if (requiresSettingsUpdate) {
        const canUpdateChannelSettings = await hasCliPermission(supabase, apikey, 'channel.update_settings', { appId: appid, channelId: targetChannel.id })
        if (!canUpdateChannelSettings) {
          uploadFail(selfAssign
            ? 'Cannot enable device self-assign because this API key lacks channel.update_settings'
            : 'Cannot set rollout because this API key lacks channel.update_settings for the target channel')
        }
      }

      if (rolloutPercentageBps != null && !targetChannel.version)
        uploadFail(`Cannot set rollout, channel ${channel} needs a stable bundle before using progressive rollout`)

      continue
    }

    if (rolloutPercentageBps != null)
      uploadFail(`Cannot set rollout, channel ${channel} must already exist with a stable bundle`)

    const canCreateChannel = await hasCliPermission(supabase, apikey, 'app.create_channel', { appId: appid })
    if (!canCreateChannel)
      uploadFail('Cannot create target channel because this API key lacks app.create_channel')

    uploadTargetChannels.set(channel, null)
  }

  return uploadTargetChannels
}

async function formatFunctionInvokeError(error: unknown): Promise<string> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (context?.json) {
    try {
      return JSON.stringify(await context.json())
    }
    catch {
      // Fall back to the generic formatter when the error body cannot be read.
    }
  }

  return formatError(error)
}

async function promoteExistingChannel(
  apikey: string,
  appid: string,
  versionId: number,
  targetChannel: UploadTargetChannel,
  localConfig: localConfigType,
  displayBundleUrl: boolean,
  options?: { supaHost?: string, supaAnon?: string },
): Promise<boolean> {
  const { error } = await invokeCapgoCliApi('bundle', {
    apikey,
    method: 'PUT',
    body: {
      app_id: appid,
      version_id: versionId,
      channel_id: targetChannel.id,
    },
    supaHost: options?.supaHost,
    supaAnon: options?.supaAnon,
  })

  if (error) {
    await uploadFailIfChannelError(error, async () => `Cannot set channel because this API key does not have the required RBAC permission. ${await formatFunctionInvokeError(error)}`)
  }

  const bundleUrl = `${localConfig.hostWeb}/app/${appid}/channel/${targetChannel.id}`
  if (targetChannel.rollout_enabled && targetChannel.rollout_version != null) {
    log.warn('This channel has an active progressive rollout. Linking this bundle as the stable version resets that rollout, so devices receive the new bundle instead of the previous rollout target.')
  }
  else if (targetChannel.public) {
    log.info('Your update is now available in your public channel 🎉')
  }
  else {
    log.info(`Link device to this bundle to try it: ${bundleUrl}`)
  }

  if (displayBundleUrl)
    log.info(`Bundle url: ${bundleUrl}`)
  return true
}

async function setVersionInChannel(
  supabase: SupabaseType,
  apikey: string,
  displayBundleUrl: boolean,
  bundle: string,
  channel: string,
  userId: string,
  orgId: string,
  appid: string,
  localConfig: localConfigType,
  targetChannel: UploadTargetChannel | null,
  requireChannelAssignment = false,
  selfAssign?: boolean,
  cliHost?: { supaHost?: string, supaAnon?: string },
): Promise<boolean> {
  const canPromoteTargetChannel = targetChannel !== null
    && await hasCliPermission(supabase, apikey, 'channel.promote_bundle', { appId: appid, channelId: targetChannel.id })
  const canCreateChannel = targetChannel === null
    && await hasCliPermission(supabase, apikey, 'app.create_channel', { appId: appid })

  if (targetChannel && !canPromoteTargetChannel) {
    const message = 'Cannot set channel because this API key lacks channel.promote_bundle for the target channel'
    if (requireChannelAssignment)
      uploadFail(message)
    log.warn(message)
    return false
  }

  if (targetChannel && canPromoteTargetChannel) {
    const versionId = await getVersionIdForChannelUpdate(supabase, apikey, appid, bundle)
    if (selfAssign) {
      const canUpdateChannelSettings = await hasCliPermission(supabase, apikey, 'channel.update_settings', { appId: appid, channelId: targetChannel.id })
      if (!canUpdateChannelSettings) {
        log.warn('Cannot enable device self-assign because this API key lacks channel.update_settings')
        return promoteExistingChannel(apikey, appid, versionId, targetChannel, localConfig, displayBundleUrl, cliHost)
      }
    }

    if (!selfAssign)
      return promoteExistingChannel(apikey, appid, versionId, targetChannel, localConfig, displayBundleUrl, cliHost)

    const { error: dbError3, data } = await updateOrCreateChannel(supabase, {
      name: channel,
      app_id: appid,
      created_by: userId,
      version: versionId,
      owner_org: orgId,
      ...(selfAssign ? { allow_device_self_set: true } : {}),
    })
    if (dbError3) {
      await uploadFailIfChannelError(dbError3, () => `Cannot set channel because this API key does not have the required RBAC permission. ${formatError(dbError3)}`)
    }
    if (data?.id) {
      const bundleUrl = `${localConfig.hostWeb}/app/${appid}/channel/${data.id}`
      if (targetChannel.rollout_enabled && targetChannel.rollout_version != null) {
        log.warn('This channel has an active progressive rollout. Linking this bundle as the stable version resets that rollout, so devices receive the new bundle instead of the previous rollout target.')
      }
      else if (data.public) {
        log.info('Your update is now available in your public channel 🎉')
      }
      else {
        log.info(`Link device to this bundle to try it: ${bundleUrl}`)
      }
      if (displayBundleUrl)
        log.info(`Bundle url: ${bundleUrl}`)
    }
    return true
  }

  // The channel endpoint creates the preview channel, receives its scoped
  // lifecycle binding, and promotes this bundle in one transaction.
  if (canCreateChannel) {
    const { error, data } = await invokeCapgoCliApi('channel', {
      apikey,
      method: 'POST',
      body: {
        app_id: appid,
        channel,
        version: bundle,
        ...(selfAssign ? { allow_device_self_set: true } : {}),
      },
      supaHost: cliHost?.supaHost,
      supaAnon: cliHost?.supaAnon,
    })
    if (error) {
      await uploadFailIfChannelError(error, async () => `Cannot create channel and set its bundle because this API key does not have the required RBAC permission. ${await formatFunctionInvokeError(error)}`)
    }

    const createdChannel = data as { id?: unknown, public?: unknown } | null
    let createdChannelId = Number(createdChannel?.id)
    let createdChannelPublic = createdChannel?.public === true
    if (!Number.isSafeInteger(createdChannelId) || typeof createdChannel?.public !== 'boolean') {
      // Older channel endpoints do not return metadata, so only their fallback reads the new channel.
      const fallbackChannel = await findUploadTargetChannel(supabase, appid, channel, false)
      const fallbackChannelId = Number(fallbackChannel?.id)
      if (!Number.isSafeInteger(fallbackChannelId)) {
        if (!Number.isSafeInteger(createdChannelId)) {
          log.info('Your update is now available 🎉')
          return true
        }
      }
      else {
        createdChannelId = fallbackChannelId
        createdChannelPublic = fallbackChannel?.public === true
      }
    }

    const bundleUrl = `${localConfig.hostWeb}/app/${appid}/channel/${createdChannelId}`
    if (createdChannelPublic)
      log.info('Your update is now available in your public channel 🎉')
    else
      log.info(`Link device to this bundle to try it: ${bundleUrl}`)

    if (displayBundleUrl)
      log.info(`Bundle url: ${bundleUrl}`)
    return true
  }

  const message = 'Cannot create target channel because this API key lacks app.create_channel'
  if (requireChannelAssignment)
    uploadFail(message)
  log.warn(message)
  return false
}

async function setRolloutVersionInChannel(
  supabase: SupabaseType,
  apikey: string,
  displayBundleUrl: boolean,
  bundle: string,
  channel: string,
  appid: string,
  localConfig: localConfigType,
  targetChannel: UploadTargetChannel | null,
  rolloutPercentageBps: number,
  rolloutCacheTtlSeconds?: number,
  selfAssign?: boolean,
  cliHost?: { supaHost?: string, supaAnon?: string },
): Promise<boolean> {
  if (!targetChannel)
    uploadFail(`Cannot set rollout, channel ${channel} must already exist with a stable bundle`)
  if (!targetChannel.version)
    uploadFail(`Cannot set rollout, channel ${channel} needs a stable bundle before using progressive rollout`)

  const versionId = await getVersionIdForChannelUpdate(supabase, apikey, appid, bundle)
  const [canPromote, canUpdateSettings] = await Promise.all([
    hasCliPermission(supabase, apikey, 'channel.promote_bundle', { appId: appid, channelId: targetChannel.id }),
    hasCliPermission(supabase, apikey, 'channel.update_settings', { appId: appid, channelId: targetChannel.id }),
  ])
  if (!canPromote)
    uploadFail('Cannot set rollout because this API key lacks channel.promote_bundle for the target channel')
  if (!canUpdateSettings)
    uploadFail('Cannot set rollout because this API key lacks channel.update_settings for the target channel')

  const shouldResumeSameRollout = targetChannel.rollout_version === versionId && rolloutPercentageBps > 0
  const { error: rolloutError } = await invokeCapgoCliApi('channel', {
    apikey,
    method: 'POST',
    body: {
      app_id: appid,
      channel,
      rolloutVersion: bundle,
      rolloutPercentageBps,
      rolloutEnabled: rolloutPercentageBps > 0,
      ...(shouldResumeSameRollout ? { rolloutPaused: false } : {}),
      ...(rolloutCacheTtlSeconds != null ? { rolloutCacheTtlSeconds } : {}),
      ...(selfAssign ? { allow_device_self_set: true } : {}),
    },
    supaHost: cliHost?.supaHost,
    supaAnon: cliHost?.supaAnon,
  })

  if (rolloutError) {
    await uploadFailIfChannelError(rolloutError, async () => `Cannot set rollout in channel ${await formatFunctionInvokeError(rolloutError)}`)
  }

  const bundleUrl = `${localConfig.hostWeb}/app/${appid}/channel/${targetChannel.id}`
  log.info(`Set ${appid} channel ${channel} rollout target to @${bundle} (${formatRolloutPercentage(rolloutPercentageBps)})`)
  if (displayBundleUrl)
    log.info(`Bundle url: ${bundleUrl}`)
  return true
}
export async function getDefaultUploadChannel(appId: string, supabase: SupabaseType, hostWeb: string) {
  const { error, data } = await supabase.from('apps')
    .select('default_upload_channel')
    .eq('app_id', appId)
    .single()

  if (error) {
    throw new Error(`Cannot find default upload channel: ${formatError(error)}. You can set it here: ${hostWeb}/app/${appId}/info`)
  }

  return data.default_upload_channel
}

export async function uploadBundleInternal(preAppid: string, options: OptionsUpload, silent = false, reporter?: UploadReporter): Promise<UploadBundleResult> {
  return runWithUploadReporter(reporter, () => uploadBundleInternalWithReporter(preAppid, options, silent))
}

async function uploadBundleInternalWithReporter(preAppid: string, options: OptionsUpload, silent: boolean): Promise<UploadBundleResult> {
  if (!silent)
    getUploadReporter().intro(`Uploading with CLI version ${pack.version}`)
  let sessionKey: Buffer | undefined
  const pm = getPMAndCommand()
  await checkAlerts(getUploadReporter())

  const { s3Region, s3Apikey, s3Apisecret, s3BucketName, s3Endpoint, s3Port, s3SSL } = options

  if (options.verbose) {
    log.info(`[Verbose] Starting upload process with options:`)
    log.info(`  - API key: ${options.apikey ? 'provided' : 'from saved key'}`)
    log.info(`  - Path: ${options.path || 'from capacitor config'}`)
    log.info(`  - Channel: ${options.channel || 'from default upload channel'}`)
    log.info(`  - Bundle: ${options.bundle || 'auto-detected'}`)
    log.info(`  - External: ${options.external || 'false'}`)
    log.info(`  - Encryption: ${options.keyV2 || options.keyDataV2 ? 'v2' : options.key === false ? 'disabled' : 'auto'}`)
    log.info(`  - Upload method: ${options.tus ? 'TUS' : options.zip ? 'ZIP' : 'auto'}`)
    log.info(`  - Delta updates: ${options.delta || options.partial ? 'enabled' : 'disabled'}`)
  }

  const apikey = getApikey(options)
  if (options.verbose)
    log.info(`[Verbose] API key retrieved successfully`)

  const extConfig = await getConfig()
  if (options.verbose)
    log.info(`[Verbose] Capacitor config loaded successfully`)

  // Record whether the user explicitly asked for a delta/partial upload BEFORE
  // any mutation of `options.delta`. The instant-update auto-enable below and
  // the flag fold later both set `options.delta = true`, so reading it back
  // afterwards cannot tell an auto-enabled delta from an explicit `--delta`.
  options.userRequestedDelta = !!(options.partial || options.delta || options.partialOnly || options.deltaOnly)

  // Check if instant updates are enabled and auto-enable delta updates.
  const instantUpdateEnabled = usesAlwaysDirectUpdate(extConfig?.config?.plugins?.CapacitorUpdater)
  const interactive = canPromptInteractively({ silent })
  if (instantUpdateEnabled && options.delta === undefined) {
    if (interactive) {
      log.info('💡 Instant updates are enabled in your config')
      log.info('   Delta updates send only changed files instead of the full bundle')
      const enableDelta = await pConfirm({
        message: 'Enable delta updates for this upload? (Recommended with instant updates)',
        initialValue: true,
      })
      if (!pIsCancel(enableDelta) && enableDelta) {
        options.delta = true
        if (options.verbose)
          log.info(`[Verbose] Delta updates auto-enabled due to instant update configuration`)
      }
    }
    else if (!silent) {
      // Non-interactive mode (CI/CD): auto-enable unless explicitly disabled
      if (options.delta !== false) {
        options.delta = true
        if (options.verbose)
          log.info(`[Verbose] Delta updates auto-enabled in CI/CD mode due to instant update configuration`)
      }
    }
  }

  const fileConfig = await getRemoteFileConfig()
  if (options.verbose) {
    log.info(`[Verbose] Remote file config retrieved:`)
    log.info(`  - Max upload length: ${Math.floor(fileConfig.maxUploadLength / 1024 / 1024)} MB`)
    log.info(`  - Alert upload size: ${Math.floor(fileConfig.alertUploadSize / 1024 / 1024)} MB`)
    log.info(`  - TUS upload: ${fileConfig.TUSUpload ? 'enabled' : 'disabled'}`)
    log.info(`  - TUS upload forced: ${fileConfig.TUSUploadForced ? 'yes' : 'no'}`)
    log.info(`  - Partial upload: ${fileConfig.partialUpload ? 'enabled' : 'disabled'}`)
    log.info(`  - Max chunk size: ${Math.floor(fileConfig.maxChunkSize / 1024 / 1024)} MB`)
  }

  const { appid, path } = getAppIdAndPath(preAppid, options, extConfig.config)
  if (options.verbose)
    log.info(`[Verbose] App ID: ${appid}, Build path: ${path}`)

  if (normalizeAutoBumpInput(options.autoBump) && options.bundle)
    uploadFail('Cannot use --bundle (-b) and --auto-bump together. Omit --bundle to auto-increment from the latest remote version.')

  let bundle = await getBundle(extConfig.config, options)
  if (options.verbose)
    log.info(`[Verbose] Bundle version: ${bundle}`)

  const defaultStorageProvider: Exclude<UploadBundleResult['storageProvider'], undefined> = options.external ? 'external' : 'r2-direct'
  let encryptionMethod: UploadBundleResult['encryptionMethod'] = 'none'

  checkNotifyAppReady(options, path)
  if (options.verbose)
    log.info(`[Verbose] Code check passed (notifyAppReady found and index.html present)`)

  const localConfig = await getLocalConfig()
  if (options.verbose)
    log.info(`[Verbose] Local config loaded: host=${localConfig.hostWeb}`)

  if (options.supaHost && options.supaAnon) {
    log.info('Using custom supabase instance from provided options')
    localConfig.supaHost = options.supaHost
    localConfig.supaKey = options.supaAnon
    if (options.verbose)
      log.info(`[Verbose] Custom Supabase host: ${options.supaHost}`)
  }

  const supabase = await createSupabaseClient(apikey, options.supaHost, options.supaAnon)
  if (options.verbose)
    log.info(`[Verbose] Supabase client created successfully`)

  // Check 2FA compliance early to give a clear error message
  await check2FAComplianceForApp(supabase, appid, silent)

  // Fail fast if the app does not exist (or we lack upload permission) BEFORE sending any
  // bundle bytes. Otherwise the whole bundle uploads first and the files backend rejects the
  // TUS request with a raw `app_not_found` 404, hiding the actionable `app add` guidance.
  // 2FA was already checked just above, so skip the redundant check here.
  await checkAppExistsAndHasPermissionOrgErr(supabase, apikey, appid, 'app.upload_bundle', silent, true)
  if (options.verbose)
    log.info(`[Verbose] App exists and API key has app.upload_bundle permission`)

  const userId = await resolveUserIdFromApiKey(supabase, apikey)
  if (options.verbose)
    log.info(`[Verbose] User verified successfully, user_id: ${userId}`)

  const requestedChannels = parseUploadChannels(options.channel)
  if (options.channel !== undefined && requestedChannels.length === 0)
    uploadFail('Missing channel name, pass one channel or a comma-separated list with --channel')

  const defaultUploadChannel = requestedChannels.length > 0 ? null : await getDefaultUploadChannel(appid, supabase, localConfig.hostWeb)
  const channels = requestedChannels.length > 0 ? requestedChannels : parseUploadChannels(defaultUploadChannel || 'production')
  if (channels.length === 0)
    uploadFail('Cannot resolve target channel')

  const channelLabel = formatUploadChannels(channels)
  let channelsToAssign = channels
  const rolloutPercentageBps = getUploadRolloutPercentageBps(options)
  if (options.verbose)
    log.info(`[Verbose] Target channel${channels.length > 1 ? 's' : ''}: ${channelLabel}`)

  // App existence/permission already checked above; fetch org id for analytics and plan checks.
  const orgId = await getOrganizationId(apikey, appid, { supaHost: options.supaHost, supaAnon: options.supaAnon })
  if (options.verbose)
    log.info(`[Verbose] Organization ID: ${orgId}`)

  await checkRemoteCliMessages(supabase, orgId, pack.version)
  if (options.verbose)
    log.info(`[Verbose] Remote CLI messages checked`)

  await checkPlanValidUpload(supabase, orgId, appid, true)
  if (options.verbose)
    log.info(`[Verbose] Plan validation passed`)
  if (options.verbose)
    log.info(`[Verbose] Trial check completed`)

  const autoBumpInput = normalizeAutoBumpInput(options.autoBump)
  if (autoBumpInput) {
    let level: AutoBumpLevel
    if (autoBumpInput === 'ai') {
      const decision = await resolveAutoBumpLevelFromAi({
        supabase,
        appid,
        channels,
        path,
        apikey,
        options: {
          supaHost: options.supaHost,
          supaAnon: options.supaAnon,
        },
      })
      log.info(`🤖 AI auto-bump chose ${decision.level}: ${decision.reason}`)
      level = decision.level
    }
    else {
      level = autoBumpInput
    }
    if (options.verbose)
      log.info(`[Verbose] Resolving auto-bump (${level}) version from channel/app remote versions...`)
    bundle = await resolveAutoBumpVersion(supabase, appid, channels, bundle, level)
    if (options.verbose)
      log.info(`[Verbose] Bundle version after auto-bump: ${bundle}`)
  }

  if (options.autoSetBundle) {
    await updateConfigUpdater({ version: bundle })
    if (options.verbose)
      log.info(`[Verbose] Auto-set bundle version in ${extConfig.path}`)
  }

  log.info(`Upload ${appid}@${bundle} started from path "${path}" to Capgo cloud`)

  if (options.verbose)
    log.info(`[Verbose] Checking if version ${bundle} already exists...`)

  // Enable interactive mode only when TTY is available
  const versionExistsResult = await checkVersionExists(supabase, appid, bundle, options.versionExistsOk, interactive)

  if (options.verbose)
    log.info(`[Verbose] Version exists check: ${versionExistsResult ? (typeof versionExistsResult === 'string' ? `retry with ${versionExistsResult}` : 'yes (skipping)') : 'no (continuing)'}`)

  // If version exists and we got a boolean true, skip
  if (versionExistsResult === true) {
    return {
      success: true,
      appId: appid,
      skipped: true,
      reason: 'VERSION_EXISTS',
      bundle,
      checksum: null,
      encryptionMethod,
      storageProvider: defaultStorageProvider,
    }
  }

  // If we got a new version string, retry with that version
  if (typeof versionExistsResult === 'string') {
    log.info(`Retrying upload with new version: ${versionExistsResult}`)
    // Clear autoBump: retry already chose an explicit bundle; keeping autoBump
    // would trip the user-facing --bundle + --auto-bump guard.
    return uploadBundleInternal(preAppid, { ...options, bundle: versionExistsResult, autoBump: undefined }, silent)
  }

  if (options.external && !options.external.startsWith('https://')) {
    uploadFail(`External link should should start with "https://" current is "${options.external}"`)
  }

  let zipped: Buffer | null = null
  let finalKeyData = ''
  let preparedBundle: Awaited<ReturnType<typeof prepareBundleFile>> | undefined
  if (!options.external) {
    if (options.verbose)
      log.info(`[Verbose] Preparing bundle file from path: ${path}`)

    const publicKeyFromConfig = extConfig.config?.plugins?.CapacitorUpdater?.publicKey
    preparedBundle = await prepareBundleFile(path, options, apikey, orgId, appid, fileConfig.maxUploadLength, fileConfig.alertUploadSize, publicKeyFromConfig)
    sessionKey = preparedBundle.sessionKey
    zipped = preparedBundle.zipped
    encryptionMethod = preparedBundle.encryptionMethod
    finalKeyData = preparedBundle.finalKeyData

    if (options.verbose) {
      log.info(`[Verbose] Bundle prepared:`)
      log.info(`  - Size: ${Math.floor((preparedBundle.zipped?.byteLength ?? 0) / 1024)} KB`)
      log.info(`  - Checksum: ${preparedBundle.checksum}`)
      log.info(`  - Encryption: ${preparedBundle.encryptionMethod}`)
      log.info(`  - IV Session Key: ${preparedBundle.ivSessionKey ? 'present' : 'none'}`)
      log.info(`  - Key ID: ${preparedBundle.keyId || 'none'}`)
    }
    const shouldCheckChecksum = !options.ignoreChecksumCheck && rolloutPercentageBps == null
    if (shouldCheckChecksum) {
      if (options.verbose)
        log.info(`[Verbose] Checking for duplicate checksum...`)
      channelsToAssign = await getChannelsToAssignAfterChecksumCheck(supabase, appid, channels, preparedBundle.checksum)
      if (options.verbose)
        log.info(`[Verbose] Checksum is unique or already satisfied across target channels`)
    }
  }

  const assignmentChannelLabel = formatUploadChannels(channelsToAssign)
  if (options.verbose)
    log.info(`[Verbose] Checking compatibility with channel${channelsToAssign.length > 1 ? 's' : ''} ${assignmentChannelLabel}...`)

  const compatibilityResults = [] as Array<Awaited<ReturnType<typeof verifyCompatibility>> & { channel: string }>
  for (const targetChannel of channelsToAssign) {
    const compatibilityResult = await verifyCompatibility(supabase, pm, options, targetChannel, appid, bundle, orgId)
    compatibilityResults.push({ channel: targetChannel, ...compatibilityResult })
  }

  const nativePackages = compatibilityResults.find(result => result.nativePackages)?.nativePackages
  const minUpdateVersion = pickHighestMinUpdateVersion(compatibilityResults)
  const incompatibleResults = compatibilityResults.filter(result => result.compatibility.result === 'incompatible')
  const incompatible = incompatibleResults.length > 0
  const incompatibleCount = incompatibleResults.reduce((count, result) => Math.max(count, result.incompatibleCount), 0)
  const incompatibleChannelLabel = formatUploadChannels(incompatibleResults.map(result => result.channel))

  // `--fail-on-incompatible`: abort the upload (exit non-zero) instead of shipping
  // an OTA update that cannot take effect without a native build. Emits a single
  // fire-and-forget telemetry event, then throws a dedicated error so the retry
  // prompt in `uploadBundle` is skipped. Closes over the upload context.
  const uploadFailIncompatible = (): never => {
    const blockedChannelLabel = incompatibleChannelLabel || assignmentChannelLabel
    void trackEvent({
      channel: 'bundle',
      event: 'Bundle Upload Blocked',
      icon: '⛔',
      apikey: options.apikey,
      appId: appid,
      orgId,
      tags: { reason: 'incompatible', channel: blockedChannelLabel, channel_name: blockedChannelLabel, channel_names: blockedChannelLabel, channel_count: incompatibleResults.length || channelsToAssign.length, incompatible_count: incompatibleCount, interactive },
    })
    const channelText = incompatibleResults.length === 1 ? 'channel' : 'channels'
    const message = `Upload aborted: bundle is incompatible with ${channelText} "${blockedChannelLabel}" (${incompatibleCount} native package(s) changed). A native build / app-store update is required. Run a native build with Capgo Builder (https://capgo.app/docs/cli/cloud-build/), or remove --fail-on-incompatible to upload anyway.`
    log.error(message)
    throw new IncompatibleBundleError(message)
  }

  // Incompatible bundle => a native build is required. Offer Capgo Builder:
  // onboarding if the app has no build credentials, otherwise a native build.
  // Accepting skips this OTA upload (a native build supersedes it). Skipped
  // entirely for the programmatic SDK path (silent), which must not prompt,
  // print, or emit CTA telemetry.
  if (incompatible && !silent) {
    // CI / non-interactive with the flag: hard fail now, before the promotional
    // Builder ad prints (there is no escape-hatch prompt to offer).
    if (options.failOnIncompatible && !interactive)
      uploadFailIncompatible()

    const hasCredentials = (await loadSavedCredentials(appid)) !== null
    const builderAction = await maybePromptBuilderCta({ incompatible, interactive, hasCredentials, appId: appid, orgId, apikey, incompatibleCount })
    if (builderAction === 'abort')
      uploadCancel()

    if (builderAction !== 'continue') {
      // Skip the OTA upload and hand the launch back to the CLI entry point, which
      // runs the Ink-based build commands. Doing it here would pull `ink` into the
      // programmatic SDK bundle (which also imports this module).
      return {
        success: true,
        appId: appid,
        skipped: true,
        reason: 'NATIVE_BUILD',
        builderAction,
        bundle,
        checksum: null,
        encryptionMethod,
        storageProvider: defaultStorageProvider,
      }
    }

    // Interactive and the user declined the native-build escape hatch.
    if (shouldBlockIncompatibleUpload({ incompatible, failOnIncompatible: !!options.failOnIncompatible, interactive, builderAction }))
      uploadFailIncompatible()
  }
  if (options.verbose) {
    log.info(`[Verbose] Compatibility check completed:`)
    log.info(`  - Native packages: ${nativePackages ? nativePackages.length : 0}`)
    log.info(`  - Min update version: ${minUpdateVersion || 'none'}`)
  }

  if (options.deleteLinkedBundleOnUpload) {
    log.warn(`Deleting linked bundle on upload is destructive, it will delete the currently linked bundle in the target channel${channelsToAssign.length > 1 ? 's' : ''}: ${assignmentChannelLabel}.`)
    log.warn('Please make sure you want to do this, if you are not sure, please do not use this option.')
  }
  const channelAssignmentRequired = channelsToAssign.length > 0
  const uploadTargetChannels = channelAssignmentRequired
    ? await preflightRequiredChannelAssignments(supabase, apikey, appid, channelsToAssign, !!options.selfAssign, rolloutPercentageBps)
    : new Map<string, UploadTargetChannel | null>()
  const versionData = {
    name: bundle,
    app_id: appid,
    session_key: options.external ? options.ivSessionKey : preparedBundle?.ivSessionKey,
    external_url: options.external,
    storage_provider: defaultStorageProvider,
    min_update_version: minUpdateVersion,
    native_packages: nativePackages,
    owner_org: orgId,
    user_id: userId,
    checksum: options.external ? options.encryptedChecksum : preparedBundle?.checksum,
    link: options.link || null,
    comment: options.comment || null,
    key_id: preparedBundle?.keyId || undefined,
    cli_version: pack.version,
  } as Database['public']['Tables']['app_versions']['Insert']

  if (options.external) {
    if (options.verbose)
      log.info(`[Verbose] Using external URL: ${options.external}`)

    await sendEvent(apikey, {
      channel: 'app',
      event: 'App external',
      icon: '📤',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appid,
      },
      notify: false,
    }, options.verbose)

    if (options.verbose) {
      log.info(`[Verbose] External bundle configured:`)
      log.info(`  - URL: ${options.external}`)
      log.info(`  - IV Session Key: ${options.ivSessionKey ? 'provided' : 'none'}`)
      log.info(`  - Encrypted Checksum: ${options.encryptedChecksum ? 'provided' : 'none'}`)
    }
  }

  if (options.zip) {
    options.tus = false
    if (options.verbose)
      log.info(`[Verbose] Upload method: ZIP (explicitly set via --zip)`)
  }
  // ALLOW TO OVERRIDE THE FILE CONFIG WITH THE OPTIONS IF THE FILE CONFIG IS FORCED
  else if (!fileConfig.TUSUpload || options.external) {
    options.tus = false
    if (options.verbose)
      log.info(`[Verbose] Upload method: Standard (TUS not available or external URL)`)
  }
  else {
    options.tus = options.tus || fileConfig.TUSUploadForced
    if (options.verbose)
      log.info(`[Verbose] Upload method: ${options.tus ? 'TUS (resumable)' : 'Standard'}`)
  }
  if (!fileConfig.partialUpload || options.external) {
    options.delta = false
    if (options.verbose && options.external)
      log.info(`[Verbose] Delta updates disabled (not available with external URLs)`)
  }
  else {
    options.delta = options.delta || options.partial || options.deltaOnly || options.partialOnly || fileConfig.partialUploadForced
    if (options.verbose)
      log.info(`[Verbose] Delta updates: ${options.delta ? 'enabled' : 'disabled'}`)
  }

  if (options.encryptPartial && encryptionMethod === 'v1')
    uploadFail('You cannot encrypt the partial update if you are not using the v2 encryption method')

  // Minimum versions that support hex checksum format
  const HEX_CHECKSUM_MIN_VERSION_V5 = '5.30.0'
  const HEX_CHECKSUM_MIN_VERSION_V6 = '6.30.0'
  const HEX_CHECKSUM_MIN_VERSION_V7 = '7.30.0'

  // Check if updater supports hex checksum format
  let supportsHexChecksum = false

  // Auto-encrypt partial updates for updater versions > 6.14.5 if encryption method is v2
  if (options.delta && encryptionMethod === 'v2' && !options.encryptPartial) {
    // Check updater version
    const root = findRoot(cwd())
    const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
    let coerced
    try {
      coerced = updaterVersion ? parse(updaterVersion) : undefined
    }
    catch {
      coerced = undefined
    }

    if (updaterVersion && coerced && greaterOrEqual(coerced, parse('6.14.4'))) {
      log.info(`Auto-enabling partial update encryption for updater version ${coerced} (> 6.14.4)`)
      if (options.verbose)
        log.info(`[Verbose] Partial encryption auto-enabled for updater >= 6.14.4`)
      options.encryptPartial = true
    }
  }

  // Check if updater supports hex checksum format (for delta updates with encryption)
  if (options.delta && (options.encryptPartial || encryptionMethod === 'v2')) {
    const root = findRoot(cwd())
    const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)
    let coerced
    try {
      coerced = updaterVersion ? parse(updaterVersion) : undefined
    }
    catch {
      coerced = undefined
    }

    if (updaterVersion && coerced) {
      // Hex checksum is supported in versions >= 5.30.0, 6.30.0, 7.30.0
      supportsHexChecksum = !isDeprecatedPluginVersion(coerced, HEX_CHECKSUM_MIN_VERSION_V5, HEX_CHECKSUM_MIN_VERSION_V6, HEX_CHECKSUM_MIN_VERSION_V7)

      if (options.verbose && supportsHexChecksum)
        log.info(`[Verbose] Using hex checksum format for updater version ${coerced}`)
    }
  }

  if (options.verbose && options.delta)
    log.info(`[Verbose] Preparing delta/partial update manifest...`)

  const manifest: manifestType = options.delta ? await prepareBundlePartialFiles(path, apikey, orgId, appid, options.encryptPartial ? encryptionMethod : 'none', finalKeyData, supportsHexChecksum) : []

  if (options.verbose && options.delta)
    log.info(`[Verbose] Delta manifest prepared with ${manifest.length} files`)

  // Refuse before creating a version row or uploading files (matches set_manifest cap).
  if (options.delta && manifest.length > MAX_MANIFEST_ENTRIES)
    uploadFail(deltaManifestTooLargeMessage(manifest.length))

  if (options.verbose)
    log.info(`[Verbose] Creating version record in database...`)

  await persistVersionData(supabase, versionData, 'add')

  if (options.verbose)
    log.info(`[Verbose] Version record created successfully`)

  if (options.dryUpload) {
    if (options.verbose)
      log.info(`[Verbose] Dry upload mode: skipping bundle publishing and channel assignment`)
    if (!silent)
      getUploadReporter().outro('Dry upload saved bundle metadata without uploading files or updating channels')
    return {
      success: true,
      appId: appid,
      bundle,
      checksum: versionData.checksum ?? null,
      encryptionMethod,
      sessionKey: sessionKey ? sessionKey.toString('base64') : undefined,
      ivSessionKey: typeof versionData.session_key === 'string' ? versionData.session_key : undefined,
      storageProvider: versionData.storage_provider,
      reason: 'DRY_UPLOAD',
    }
  }
  if (options.tusChunkSize && options.tusChunkSize > fileConfig.maxChunkSize) {
    log.error(`Chunk size ${options.tusChunkSize} is greater than the maximum chunk size ${fileConfig.maxChunkSize}, using the maximum chunk size`)
    options.tusChunkSize = fileConfig.maxChunkSize
  }
  else if (!options.tusChunkSize) {
    options.tusChunkSize = fileConfig.maxChunkSize
  }

  if (options.verbose)
    log.info(`[Verbose] TUS chunk size: ${Math.floor(options.tusChunkSize / 1024 / 1024)} MB`)

  if (zipped && (s3BucketName || s3Endpoint || s3Region || s3Apikey || s3Apisecret || s3Port || s3SSL)) {
    if (!s3BucketName || !s3Endpoint || !s3Region || !s3Apikey || !s3Apisecret || !s3Port)
      uploadFail('Missing argument, for S3 upload you need to provide a bucket name, endpoint, region, port, API key, and API secret')

    log.info('Uploading to S3')
    if (options.verbose) {
      log.info(`[Verbose] S3 configuration:`)
      log.info(`  - Endpoint: ${s3Endpoint}`)
      log.info(`  - Region: ${s3Region}`)
      log.info(`  - Bucket: ${s3BucketName}`)
      log.info(`  - Port: ${s3Port}`)
      log.info(`  - SSL: ${s3SSL ? 'enabled' : 'disabled'}`)
    }

    const endPoint = `${s3SSL ? 'https' : 'http'}://${s3Endpoint}${s3Port ? `:${s3Port}` : ''}`
    const s3Client = new S3Client({
      endPoint: s3Endpoint,
      region: s3Region,
      port: s3Port,
      pathStyle: true,
      bucket: s3BucketName,
      accessKey: s3Apikey,
      secretKey: s3Apisecret,
    })
    const fileName = `${appid}-${bundle}`
    const encodeFileName = encodeURIComponent(fileName)

    if (options.verbose)
      log.info(`[Verbose] Uploading to S3 as: ${fileName}`)

    try {
      await s3Client.putObject(fileName, Uint8Array.from(zipped))
      versionData.external_url = `${endPoint}/${encodeFileName}`
      versionData.storage_provider = 'external'
      await persistVersionData(supabase, versionData, 'update')
    }
    catch (error) {
      try {
        await deletedFailedVersion(apikey, appid, bundle, options)
      }
      catch (cleanupError) {
        uploadFail(`Cannot upload bundle to S3 ${formatError(error)}. Cleanup of the incomplete version also failed (${formatError(cleanupError)}); delete bundle ${bundle} manually before retrying.`)
      }
      uploadFail(`Cannot upload bundle to S3 ${formatError(error)}`)
    }

    if (options.verbose)
      log.info(`[Verbose] S3 upload complete, external URL: ${versionData.external_url}`)
  }
  else if (zipped) {
    if (!options.partialOnly && !options.deltaOnly) {
      if (options.verbose)
        log.info(`[Verbose] Starting full bundle upload to Capgo Cloud...`)
      await uploadBundleToCapgoCloud(apikey, supabase, appid, bundle, orgId, zipped, options, options.tusChunkSize)
    }
    else if (options.verbose) {
      log.info(`[Verbose] Skipping full bundle upload (delta-only mode)`)
    }

    let finalManifest: Awaited<ReturnType<typeof uploadPartial>> | null = null
    try {
      if (options.dryUpload) {
        options.delta = false
        if (options.verbose)
          log.info(`[Verbose] Dry upload mode: skipping delta upload`)
      }
      const encryptionData = versionData.session_key && options.encryptPartial && sessionKey
        ? {
            sessionKey,
            ivSessionKey: versionData.session_key,
          }
        : undefined

      if (options.verbose && options.delta) {
        log.info(`[Verbose] Starting delta/partial file upload...`)
        log.info(`  - Manifest entries: ${manifest.length}`)
        log.info(`  - Encryption: ${encryptionData ? 'enabled' : 'disabled'}`)
      }

      finalManifest = options.delta
        ? await uploadPartial(
            apikey,
            manifest,
            path,
            appid,
            orgId,
            encryptionData,
            options,
          )
        : null

      if (options.verbose && finalManifest)
        log.info(`[Verbose] Delta upload complete with ${finalManifest.length} files`)
    }
    catch (err) {
      // If user explicitly requested delta, the error was already thrown by uploadPartial
      // and we should propagate it. Read the explicit-request flag captured before
      // `options.delta` was mutated, so an auto-enabled delta degrades gracefully.
      if (options.userRequestedDelta) {
        // Error already logged in uploadPartial, just re-throw
        throw err
      }

      // Auto-enabled delta that failed - not critical
      log.info(`Failed to upload partial files to capgo cloud. Error: ${formatError(err)}. This is not a critical error, the bundle has been uploaded without the partial files`)
      if (options.verbose)
        log.info(`[Verbose] Delta upload error details: ${formatError(err)}`)
    }

    if (finalManifest?.length) {
      if (options.verbose)
        log.info(`[Verbose] Writing ${finalManifest.length} manifest rows via set_manifest...`)

      try {
        await setVersionManifest(apikey, appid, bundle, finalManifest, options)
      }
      catch (error) {
        try {
          await deletedFailedVersion(apikey, appid, bundle, options)
        }
        catch (cleanupError) {
          uploadFail(`Cannot set bundle manifest ${formatError(error)}. Cleanup of the incomplete version also failed (${formatError(cleanupError)}); delete bundle ${bundle} manually before retrying.`)
        }
        uploadFail(`Cannot set bundle manifest ${formatError(error)}`)
      }

      if (options.verbose)
        log.info(`[Verbose] Manifest rows written (sizes filled by backend from R2)`)
    }

    // Keep jsonb null — legacy CLIs still upload via app_versions.manifest.
    versionData.storage_provider = 'r2'
    versionData.manifest = null

    if (options.verbose)
      log.info(`[Verbose] Updating version record with storage provider...`)

    await persistVersionData(supabase, versionData, 'update')

    if (options.verbose)
      log.info(`[Verbose] Version record updated successfully`)
  }

  // App existence and app.upload_bundle permission were already verified up front (before any
  // upload). Here we only need the extra bundle.delete permission for linked-bundle cleanup.
  const canDeleteBundle = await hasCliPermission(supabase, apikey, 'bundle.delete', { appId: appid })

  if (options.verbose) {
    log.info(`[Verbose] Permissions:`)
    log.info(`  - app.upload_bundle: yes`)
    log.info(`  - bundle.delete: ${canDeleteBundle ? 'yes' : 'no'}`)
    log.info(`  - channel permissions: checked per target channel`)
  }

  const shouldDeleteLinkedBundle = options.deleteLinkedBundleOnUpload && canDeleteBundle
  const linkedBundlesToDelete = shouldDeleteLinkedBundle
    ? await Promise.all(channelsToAssign.map(async targetChannel => ({
        channel: targetChannel,
        version: await getLinkedBundleOnChannel(supabase, appid, targetChannel),
      })))
    : []
  if (options.deleteLinkedBundleOnUpload && !shouldDeleteLinkedBundle) {
    log.warn('Cannot delete linked bundle on upload because this API key lacks bundle.delete')
  }

  const expectedChannelAssignments = new Set(channelsToAssign).size
  const channelVersionSet = new Set<string>()
  for (const targetChannel of channelsToAssign) {
    if (options.verbose)
      log.info(`[Verbose] Setting bundle ${bundle} to channel ${targetChannel}...`)

    const uploadTargetChannel = uploadTargetChannels.has(targetChannel)
      ? uploadTargetChannels.get(targetChannel) ?? null
      : await findUploadTargetChannel(supabase, appid, targetChannel)
    const targetChannelVersionSet = rolloutPercentageBps != null
      ? await setRolloutVersionInChannel(supabase, apikey, !!options.bundleUrl, bundle, targetChannel, appid, localConfig, uploadTargetChannel, rolloutPercentageBps, options.rolloutCacheTtlSeconds, options.selfAssign, options)
      : await setVersionInChannel(supabase, apikey, !!options.bundleUrl, bundle, targetChannel, userId, orgId, appid, localConfig, uploadTargetChannel, channelAssignmentRequired, options.selfAssign, options)
    if (targetChannelVersionSet)
      channelVersionSet.add(targetChannel)
    if (options.verbose)
      log.info(`[Verbose] Channel ${targetChannel} ${targetChannelVersionSet ? 'updated successfully' : 'was not updated'}`)
  }

  if (shouldDeleteLinkedBundle) {
    const deletedVersionIds = new Set<number>()
    for (const linkedBundle of linkedBundlesToDelete) {
      if (!channelVersionSet.has(linkedBundle.channel))
        continue
      if (!linkedBundle.version || deletedVersionIds.has(linkedBundle.version.id))
        continue
      if (options.verbose)
        log.info(`[Verbose] Deleting previously linked bundle in channel ${linkedBundle.channel}...`)
      await deleteLinkedBundleOnUpload(supabase, linkedBundle.version)
      deletedVersionIds.add(linkedBundle.version.id)
    }
  }

  if (channelVersionSet.size === 0)
    log.warn('Cannot set channel because this API key lacks the required RBAC permission')
  if (channelAssignmentRequired && channelVersionSet.size !== expectedChannelAssignments)
    uploadFail('Cannot complete upload because one or more target channels were not updated')
  if (options.verbose)
    log.info(`[Verbose] Sending upload event...`)

  await sendEvent(apikey, {
    channel: 'app',
    event: 'App Uploaded',
    icon: '⏫',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appid,
      'bundle': bundle,
    },
    notify: false,
  }, options.verbose)

  await sendEvent(apikey, {
    channel: 'app',
    event: 'Bundle Uploaded',
    icon: '⏫',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appid,
      'bundle': bundle,
    },
    notify: false,
    notifyConsole: true,
  }).catch(() => {})

  // Record every incompatible upload in PostHog (`Bundle Incompatible`). The
  // channel_overwritten flag lets the backend gate the org-member email to
  // uploads that actually went live (i.e. overwrote the channel's version).
  for (const compatibilityResult of compatibilityResults) {
    if (compatibilityResult.compatibility.result !== 'incompatible')
      continue

    void trackEvent({
      channel: 'bundle',
      event: 'Bundle Incompatible',
      icon: '🚫',
      apikey,
      appId: appid,
      orgId,
      tags: {
        source: 'upload',
        // `channel` is overwritten by the event category ('bundle') in PostHog
        // (the backend still reads tags.channel); channel_name keeps it queryable.
        channel: compatibilityResult.channel,
        channel_name: compatibilityResult.channel,
        channel_overwritten: channelVersionSet.has(compatibilityResult.channel),
        version_new_name: bundle,
        ...(compatibilityResult.compatibility.versionOldId ? { version_old_id: compatibilityResult.compatibility.versionOldId } : {}),
        ...(compatibilityResult.compatibility.versionOldName ? { version_old_name: compatibilityResult.compatibility.versionOldName } : {}),
      },
    })
  }

  const result: UploadBundleResult = {
    success: true,
    appId: appid,
    bundle,
    updatedChannels: Array.from(channelVersionSet),
    checksum: versionData.checksum ?? null,
    encryptionMethod,
    sessionKey: sessionKey ? sessionKey.toString('base64') : undefined,
    ivSessionKey: typeof versionData.session_key === 'string' ? versionData.session_key : undefined,
    storageProvider: versionData.storage_provider,
  }

  if (options.verbose) {
    log.info(`[Verbose] Upload completed successfully:`)
    log.info(`  - Bundle: ${result.bundle}`)
    log.info(`  - Checksum: ${result.checksum}`)
    log.info(`  - Encryption: ${result.encryptionMethod}`)
    log.info(`  - Storage: ${result.storageProvider}`)
  }

  if (interactive && !result.skipped) {
    let shouldShowReplicationProgress = options.showReplicationProgress
    if (shouldShowReplicationProgress === undefined) {
      shouldShowReplicationProgress = await confirmWithRememberedChoice({
        preferenceKey: 'uploadShowReplicationProgress',
        message: 'Show Capgo global replication progress for this upload so you can confirm rollout in all regions?',
        initialValue: false,
        rememberMessage: 'Remember this replication progress preference for future uploads on this machine?',
      })
    }

    if (shouldShowReplicationProgress) {
      await showReplicationProgress({
        title: 'Replicating your bundle in all regions to guarantee fast updates.',
        completeMessage: 'Replication complete. Your update is now globally available.',
        interactive,
      })
    }
  }

  if (!silent && !result.skipped)
    getUploadReporter().outro('Time to share your update to the world 🌍')

  return result
}

/**
 * Validate mutually-exclusive and dependent upload options, failing fast (via
 * `uploadFail`) before any network call. Exported so the option-conflict guards
 * (e.g. `--fail-on-incompatible` + `--ignore-metadata-check`) can be unit-tested
 * directly.
 */
export function checkValidOptions(options: OptionsUpload) {
  const noKey = options.key === false
  const hasUploadRollout = options.rollout != null || options.rolloutPercentageBps != null
  const forceCrc32 = options.forceCrc32Checksum === true
  const hasEncryptionKey = (options.keyV2 || options.keyDataV2 || existsSync(baseKeyV2))

  if (options.ivSessionKey && !options.external) {
    uploadFail('You need to provide an external url if you want to use the --iv-session-key option')
  }
  if (options.encryptedChecksum && !options.external) {
    uploadFail('You need to provide an external url if you want to use the --encrypted-checksum option')
  }
  if ((options.partial || options.delta || options.partialOnly || options.deltaOnly) && options.external) {
    uploadFail('You cannot use the --partial/--delta/--partial-only/--delta-only option with an external url')
  }
  if (options.tus && options.external) {
    uploadFail('You cannot use the --tus option with an external url')
  }
  if (options.dryUpload && options.external) {
    uploadFail('You cannot use the --dry-upload option with an external url')
  }
  if (options.multipart && options.external) {
    uploadFail('You cannot use the --multipart option with an external url')
  }
  // cannot set key if external
  if (options.external && (options.keyV2 || options.keyDataV2)) {
    uploadFail('You cannot set a key if you are uploading to an external url')
  }
  // cannot set key-v2 and key-data-v2
  if (options.keyV2 && options.keyDataV2) {
    uploadFail('You cannot set both key-v2 and key-data-v2')
  }
  // cannot set s3 and external
  if (options.external && (options.s3Region || options.s3Apikey || options.s3Apisecret || options.s3Endpoint || options.s3BucketName || options.s3Port || options.s3SSL)) {
    uploadFail('You cannot set S3 options if you are uploading to an external url, it\'s automatically handled')
  }
  // cannot set --encrypted-checksum if not external
  if (options.encryptedChecksum && !options.external) {
    uploadFail('You cannot set the --encrypted-checksum option if you are not uploading to an external url')
  }
  // cannot set min-update-version and auto-min-update-version
  if (options.minUpdateVersion && options.autoMinUpdateVersion) {
    uploadFail('You cannot set both min-update-version and auto-min-update-version, use only one of them')
  }
  if (options.rollout != null && (!Number.isFinite(options.rollout) || options.rollout < 0 || options.rollout > 100)) {
    uploadFail('Rollout percentage must be between 0 and 100')
  }
  if (options.rolloutPercentageBps != null && (!Number.isInteger(options.rolloutPercentageBps) || options.rolloutPercentageBps < 0 || options.rolloutPercentageBps > 10000)) {
    uploadFail('Rollout percentage basis points must be between 0 and 10000')
  }
  if (options.rolloutCacheTtlSeconds != null && (!Number.isInteger(options.rolloutCacheTtlSeconds) || options.rolloutCacheTtlSeconds < 60 || options.rolloutCacheTtlSeconds > 31536000)) {
    uploadFail('Rollout cache TTL seconds must be between 60 and 31536000')
  }
  if (hasUploadRollout && options.dryUpload) {
    uploadFail('You cannot use --rollout with --dry-upload because dry upload does not update channels')
  }
  if (hasUploadRollout && options.deleteLinkedBundleOnUpload) {
    uploadFail('You cannot use --rollout with --delete-linked-bundle-on-upload because rollout needs the stable channel bundle as fallback')
  }
  if (forceCrc32 && hasEncryptionKey && !noKey) {
    uploadFail('You cannot use --force-crc32-checksum when encryption is enabled. Remove the flag or disable encryption.')
  }
  if (options.failOnIncompatible && options.ignoreMetadataCheck) {
    uploadFail('You cannot use --fail-on-incompatible together with --ignore-metadata-check — the metadata check is exactly what --fail-on-incompatible enforces. Remove one of them.')
  }
}

async function maybePromptStarCapgoRepo() {
  if (!canPromptInteractively())
    return

  const status = getRepoStarStatus()
  if (isRepoStarredInSession(status.repository) || !status.ghInstalled || !status.ghLoggedIn || !status.repositoryExists || status.starred)
    return

  const doStar = await confirmWithRememberedChoice({
    preferenceKey: 'uploadStarCapgoRepo',
    message: `Would you like to star ${status.repository} on GitHub to support Capgo?`,
    rememberMessage: 'Remember this GitHub support preference for future uploads on this machine?',
  })
  if (!doStar) {
    return
  }

  try {
    const result = starRepository(status.repository)
    if (result.alreadyStarred) {
      log.info(`🫶 ${result.repository} is already starred`)
    }
    else {
      log.success(`🙏 Thanks for starring ${result.repository} 🎉`)
    }
  }
  catch (error) {
    log.warn(`Cannot star ${status.repository} right now: ${formatError(error)}`)
  }
}

export async function uploadBundle(appid: string, options: OptionsUpload): Promise<UploadBundleResult> {
  return runWithUploadReporter(clackUploadReporter, () => uploadBundleWithReporter(appid, options))
}

async function uploadBundleWithReporter(appid: string, options: OptionsUpload): Promise<UploadBundleResult> {
  try {
    checkValidOptions(options)
    const result = await uploadBundleInternal(appid, options)
    if (!result.skipped)
      await maybePromptStarCapgoRepo()
    return result
  }
  catch (error) {
    // Show simple message by default, full error details only with --verbose
    const simpleMessage = error instanceof Error ? error.message : String(error)
    const verboseMessage = formatError(error)

    if (simpleMessage === UPLOAD_CANCELLED_BY_USER)
      throw error instanceof Error ? error : new Error(String(error))

    if (options.verbose) {
      log.error(`uploadBundle failed:${verboseMessage}`)
    }
    else {
      log.error(`uploadBundle failed: ${simpleMessage}`)
    }

    // An incompatible-bundle failure (`--fail-on-incompatible`) is intentional and
    // not retryable — retrying the same bundle would just fail again. Re-throw
    // before the generic retry prompt, mirroring the isChecksumError special-case.
    if (error instanceof IncompatibleBundleError)
      throw error

    // Check if this is a checksum error - offer specific retry option
    const isChecksumError = simpleMessage.includes('Cannot upload the same bundle content')

    const interactive = canPromptInteractively()
    // Interactive retry for errors when running in an interactive environment
    if (!options.versionExistsOk && interactive) {
      try {
        if (isChecksumError) {
          // For checksum errors, offer to retry with --ignore-checksum-check
          const retryChoice = await pSelect({
            message: 'Would you like to retry the upload?',
            options: [
              { value: 'ignore', label: 'Retry with --ignore-checksum-check (force upload same content)' },
              { value: 'cancel', label: 'Cancel upload' },
            ],
          })

          if (pIsCancel(retryChoice) || retryChoice === 'cancel') {
            throw error instanceof Error ? error : new Error(String(error))
          }

          if (retryChoice === 'ignore') {
            log.info(`🔄 Retrying upload with --ignore-checksum-check...`)
            return uploadBundle(appid, { ...options, ignoreChecksumCheck: true })
          }
        }
        else {
          const retry = await pConfirm({ message: 'Would you like to retry the upload?' })

          if (pIsCancel(retry)) {
            throw error instanceof Error ? error : new Error(String(error))
          }

          if (retry) {
            log.info(`🔄 Retrying upload...`)
            return uploadBundle(appid, options)
          }
        }
      }
      catch {
        // If prompts fail (e.g., not a TTY), just throw the original error
        throw error instanceof Error ? error : new Error(String(error))
      }
    }

    throw error instanceof Error ? error : new Error(String(error))
  }
}
