import type { Buffer } from 'node:buffer'
import type { BundleZipOptions, ZipResult } from '../schemas/bundle'
import type { UploadReporter } from './reporter'
import type { OptionsUpload } from './upload_interface'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { intro, log, outro, spinner } from '@clack/prompts'
import { parse } from '@std/semver'
import pack from '../../package.json'
import { checkAlerts } from '../api/update'
import { getChecksum } from '../checksum'
import {
  baseKeyV2,
  canPromptInteractively,
  findRoot,
  formatError,
  getBundleVersion,
  getConfig,
  getInstalledVersion,
  getLocalDependencies,
  isDeprecatedPluginVersion,
  regexSemver,
  zipFile,
} from '../utils'
import { getUpdaterInstallState } from '../init/updater'
import {
  recoverInvalidSemverBundle,
  recoverMissingUpdater,
  recoverMissingWebDirPath,
  resolveLocalSemverFallback,
  resolveUpdaterPackageJsonPath,
} from '../recovery/bundle-zip'
import { ensureNotifyAppReadyInBuildFolder, buildCiNotifyAppReadyMessage } from '../recovery/notify-app-ready'
import { CliUserError } from '../shared/cli-user-error'
import { parsePackageJsonOptionPaths, resolveAppIdWithRecovery } from '../recovery/app-id'
import { withStdoutOnStderr } from '../shared/json-stdout'
import { checkIndexPosition, searchInDirectory } from './check'
import { writeDeltaPack } from './delta-pack'
import { runWithUploadReporter } from './reporter'
import { checkValidOptions } from './upload'
import { buildNativePackagesPayload, prepareBundleArtifact } from './upload-artifact'

export type { ZipResult } from '../schemas/bundle'

const alertMb = 20

const noopSpinner = { start: () => {}, message: () => {}, stop: () => {}, error: () => {} }

// Silent (SDK) mode: the shared upload helpers must not print anything.
const silentReporter: UploadReporter = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  intro: () => {},
  outro: () => {},
  spinner: () => noopSpinner,
}

// --json mode: keep stdout for the JSON document, plain warnings/errors on stderr.
const jsonReporter: UploadReporter = {
  ...silentReporter,
  warn: message => console.error(message),
  error: message => console.error(message),
}

function emitJson(value: unknown) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2))
}

function emitJsonError(error: unknown) {
  console.error(formatError(error))
}

function emitCliUserJsonError(error: CliUserError) {
  if (error.context?.message)
    emitJsonError({ error: error.message, message: error.context.message })
  else
    emitJsonError({ error: error.message })
}

export async function zipBundleInternal(appId: string, options: BundleZipOptions, silent = false): Promise<ZipResult> {
  const { json } = options
  try {
    const reporter = silent ? silentReporter : json ? jsonReporter : undefined
    const run = () => runWithUploadReporter(reporter, () => zipBundleCore(appId, options, silent))
    // --json prints exactly one JSON document on stdout; route stray logs to stderr.
    const result = json && !silent ? await withStdoutOnStderr(run) : await run()
    if (!silent && json)
      emitJson(result)
    return result
  }
  catch (error) {
    if (!silent) {
      if (json) {
        if (error instanceof CliUserError)
          emitCliUserJsonError(error)
        else
          emitJsonError(error)
      }
      else {
        log.error(formatError(error))
      }
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * `--for-upload` (implied by `--delta-pack`): produce exactly what `bundle upload`
 * would send, using the same helpers (zip, checksum, v2 encryption, native packages,
 * delta entries). Without it, `bundle zip` keeps its historical behavior.
 */
function isForUpload(options: BundleZipOptions): boolean {
  return options.forUpload === true || !!options.deltaPack
}

function toUploadOptions(options: BundleZipOptions): OptionsUpload {
  return {
    apikey: '',
    // Bare `--key-v2` means the default key file, like `bundle upload --key-v2 .capgo_key_v2`.
    keyV2: options.keyV2 === true ? baseKeyV2 : (options.keyV2 || undefined),
    keyDataV2: options.keyDataV2,
    key: options.key,
    forceCrc32Checksum: options.forceCrc32Checksum,
    packageJson: options.packageJson,
    nodeModules: options.nodeModules,
    delta: !!options.deltaPack,
    encryptDelta: options.encryptDelta,
    encryptPartial: options.encryptPartial,
    disableBrotli: options.disableBrotli,
  }
}

async function zipBundleCore(appId: string, options: BundleZipOptions, silent: boolean): Promise<ZipResult> {
  const { json } = options
  let { bundle, path } = options

  const shouldShowPrompts = !json && !silent
  const forUpload = isForUpload(options)
  const uploadOptions = forUpload ? toUploadOptions(options) : undefined
  if (uploadOptions)
    checkValidOptions(uploadOptions)

  // The upload packer is documented as fully offline: skip the npm "new CLI version" check.
  if (shouldShowPrompts && !forUpload)
    await checkAlerts()

  const extConfig = await getConfig()
  const interactive = canPromptInteractively({ silent: json || silent })
  const resolvedAppId = await resolveAppIdWithRecovery({
    explicitAppId: appId,
    config: extConfig?.config,
    packageJsonPaths: parsePackageJsonOptionPaths(options.packageJson),
    interactive,
    json,
  })

  const uuid = randomUUID().split('-')[0]
  const packVersion = getBundleVersion('', options.packageJson)
  // Same precedence as `bundle upload` when packing for upload (capacitor config version first).
  const configVersion = forUpload ? extConfig?.config?.plugins?.CapacitorUpdater?.version : undefined
  bundle = bundle || configVersion || packVersion || resolveLocalSemverFallback(uuid)

  if (shouldShowPrompts)
    intro(`Zipping ${resolvedAppId ?? 'app'}@${bundle}`)

  // Expected setup failures use plain Error (not CliUserError) so PostHog still captures
  // real user aborts after declined recovery.
  if (bundle && !regexSemver.test(bundle)) {
    if (interactive) {
      const recoveredBundle = await recoverInvalidSemverBundle(bundle, resolveLocalSemverFallback(uuid))
      if (recoveredBundle)
        bundle = recoveredBundle
    }
    if (!regexSemver.test(bundle)) {
      const message = `Your bundle name ${bundle}, is not valid it should follow semver convention : https://semver.org/`
      if (!silent) {
        if (json)
          emitJsonError({ error: 'invalid_semver' })
        else
          log.error(message)
      }
      throw new Error('Invalid bundle version format')
    }
  }

  path = path || extConfig?.config?.webDir
  if (!path && interactive) {
    const recoveredPath = await recoverMissingWebDirPath('Enter the path to your built web assets (webDir):')
    if (recoveredPath)
      path = recoveredPath
  }

  if (!resolvedAppId || !bundle || !path) {
    const message = 'Missing argument, you need to provide a appId and a bundle and a path, or be in a capacitor project'
    if (!silent) {
      if (json)
        emitJsonError({ error: 'missing_argument' })
      else
        log.error(message)
    }
    throw new Error(message)
  }

  if (!existsSync(path)) {
    const message = `Path ${path} does not exist, build your app first, or provide a valid path`
    throw json
      ? new CliUserError('path_not_found', { message })
      : new CliUserError(message)
  }

  if (shouldShowPrompts)
    log.info(`Started from path "${path}"`)

  const shouldCheckNotifyAppReady = options.codeCheck !== false && !options.ignoreNotifyAppReady

  if (shouldCheckNotifyAppReady) {
    if (!searchInDirectory(path, 'notifyAppReady')) {
      if (interactive) {
        const recovery = await ensureNotifyAppReadyInBuildFolder({
          webDir: path,
          interactive,
          json,
        })
        if (recovery !== 'skipped' && !searchInDirectory(path, 'notifyAppReady')) {
          throw new CliUserError('notifyAppReady() is missing in build folder')
        }
      }
      else {
        throw json
          ? new CliUserError('notifyAppReady_not_in_source_code', {
              message: buildCiNotifyAppReadyMessage(path),
            })
          : new CliUserError(buildCiNotifyAppReadyMessage(path))
      }
    }

    if (!checkIndexPosition(path)) {
      if (!silent) {
        if (json)
          emitJsonError({ error: 'index_html_not_found' })
        else
          log.error(`index.html is missing in the root folder of ${path}`)
      }
      throw new Error('index.html is missing in root folder')
    }
  }

  let zipped: Buffer
  let checksum: string
  let checksumAlgorithm: 'sha256' | 'crc32'
  let updaterVersion: string | null | undefined
  let uploadMetadata: Partial<ZipResult> = {}
  let artifact: Awaited<ReturnType<typeof prepareBundleArtifact>> | undefined

  if (!uploadOptions) {
    zipped = await zipFile(path)

    if (shouldShowPrompts)
      log.info(`Zipped ${zipped.byteLength} bytes`)

    const checksumSpinner = shouldShowPrompts ? spinner() : null
    if (checksumSpinner)
      checksumSpinner.start('Calculating checksum')

    const root = findRoot(cwd())
    await ensureUpdaterInstalled(options, interactive, silent)

    updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)

    let useSha256 = false
    let coerced
    try {
      coerced = updaterVersion ? parse(updaterVersion) : undefined
    }
    catch {
      coerced = undefined
    }

    if (coerced) {
      // Use sha256 for v5.10.0+, v6.25.0+ or v7.0.0+
      useSha256 = !isDeprecatedPluginVersion(coerced, undefined, undefined, '7.0.0')
    }
    else if (updaterVersion === 'link:@capgo/capacitor-updater') {
      if (!silent)
        log.warn('Using local @capgo/capacitor-updater. Assuming v7')
      useSha256 = true
    }

    checksumAlgorithm = options.keyV2 || existsSync(baseKeyV2) || useSha256 ? 'sha256' : 'crc32'
    checksum = await getChecksum(zipped, checksumAlgorithm)

    if (checksumSpinner)
      checksumSpinner.stop(`Checksum ${useSha256 ? 'SHA256' : 'CRC32'}: ${checksum}`)
  }
  else {
    await ensureUpdaterInstalled(options, interactive, silent)
    // Same zip, checksum and v2 encryption as `bundle upload` (no analytics: offline).
    const publicKeyFromConfig = extConfig?.config?.plugins?.CapacitorUpdater?.publicKey
    artifact = await prepareBundleArtifact(path, uploadOptions, publicKeyFromConfig)
    zipped = artifact.zipped
    checksum = artifact.checksum
    checksumAlgorithm = artifact.checksumAlgorithm
    updaterVersion = artifact.updaterVersion
    const localDependencies = await getLocalDependencies(options.packageJson, options.nodeModules)
    uploadMetadata = {
      encryption_method: artifact.encryptionMethod === 'v2' ? 'v2' : 'none',
      ...(artifact.ivSessionKey ? { session_key: artifact.ivSessionKey } : {}),
      ...(artifact.keyId ? { key_id: artifact.keyId } : {}),
      native_packages: buildNativePackagesPayload(localDependencies) ?? [],
    }
  }

  const mbSize = Math.floor(zipped.byteLength / 1024 / 1024)
  if (mbSize > alertMb && shouldShowPrompts) {
    log.warn(`WARNING !!\nThe bundle size is ${mbSize} Mb, this may take a while to download for users\n`)
    log.warn('Learn how to optimize your assets https://capgo.app/blog/optimise-your-images-for-updates/\n')
  }

  const saveSpinner = shouldShowPrompts ? spinner() : null
  const filename = options.name || `${resolvedAppId}_${bundle}.zip`

  if (saveSpinner)
    saveSpinner.start(`Saving to ${filename}`)

  writeFileSync(filename, zipped)

  if (saveSpinner)
    saveSpinner.stop(`Saved to ${filename}`)

  if (uploadOptions && artifact && options.deltaPack) {
    const deltaPack = await writeDeltaPack(options.deltaPack, path, artifact, uploadOptions)
    uploadMetadata = {
      ...uploadMetadata,
      delta_pack: deltaPack.filename,
      delta_pack_entries: deltaPack.manifest.entries.length,
      delta_file_hash_format: deltaPack.manifest.file_hash_format,
      delta_encryption: deltaPack.manifest.delta_encryption,
    }
    if (shouldShowPrompts)
      log.info(`Delta pack with ${deltaPack.manifest.entries.length} files saved to ${deltaPack.filename}`)
  }

  if (shouldShowPrompts)
    outro('Done ✅')

  return {
    bundle,
    filename,
    checksum,
    app_id: resolvedAppId,
    ...(updaterVersion ? { updater_version: updaterVersion } : {}),
    ...(artifact?.updaterPackageName ? { updater_package: artifact.updaterPackageName } : {}),
    checksum_algorithm: checksumAlgorithm,
    size_bytes: zipped.byteLength,
    cli_version: pack.version,
    ...uploadMetadata,
  }
}

async function ensureUpdaterInstalled(options: BundleZipOptions, interactive: boolean, silent: boolean) {
  const resolvedPackageJson = resolveUpdaterPackageJsonPath(options.packageJson)
  let updaterInstallState = getUpdaterInstallState(resolvedPackageJson)

  if (!updaterInstallState.ready && interactive && await recoverMissingUpdater(options.packageJson))
    updaterInstallState = getUpdaterInstallState(resolvedPackageJson)

  if (!updaterInstallState.ready) {
    const warning = 'Cannot find @capgo/capacitor-updater in node_modules, please install it first with your package manager'
    if (!silent)
      log.warn(warning)
    throw new Error(warning)
  }
}

export async function zipBundle(appId: string, options: BundleZipOptions) {
  await zipBundleInternal(appId, options, false)
}
