import type { BundleZipOptions, ZipResult } from '../schemas/bundle'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { intro, log, outro, spinner } from '@clack/prompts'
import { parse } from '@std/semver'
import { trackEvent } from '../analytics/track'
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
import { parsePackageJsonOptionPaths, resolveAppIdWithRecovery } from '../recovery/app-id'
import { checkIndexPosition, searchInDirectory } from './check'

export type { ZipResult } from '../schemas/bundle'

const alertMb = 20

function emitJson(value: unknown) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2))
}

function emitJsonError(error: unknown) {
  console.error(formatError(error))
}

export async function zipBundleInternal(appId: string, options: BundleZipOptions, silent = false): Promise<ZipResult> {
  const { json } = options
  let { bundle, path } = options

  const shouldShowPrompts = !json && !silent

  try {
    if (shouldShowPrompts)
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
    bundle = bundle || packVersion || resolveLocalSemverFallback(uuid)

    if (shouldShowPrompts)
      intro(`Zipping ${resolvedAppId ?? 'app'}@${bundle}`)

    // Expected setup failures use plain Error (not CliUserError) so PostHog still captures
    // real user aborts after declined recovery. notifyAppReady stays a bare Error too.
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

    if (shouldShowPrompts)
      log.info(`Started from path "${path}"`)

    const shouldCheckNotifyAppReady = options.codeCheck !== false && !options.ignoreNotifyAppReady

    if (shouldCheckNotifyAppReady) {
      if (!searchInDirectory(path, 'notifyAppReady')) {
        const recovery = await ensureNotifyAppReadyInBuildFolder({
          webDir: path,
          interactive,
          json,
        })
        if (recovery !== 'skipped' && !searchInDirectory(path, 'notifyAppReady')) {
          throw new Error(buildCiNotifyAppReadyMessage(path))
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

    const zipped = await zipFile(path)

    if (shouldShowPrompts)
      log.info(`Zipped ${zipped.byteLength} bytes`)

    const checksumSpinner = shouldShowPrompts ? spinner() : null
    if (checksumSpinner)
      checksumSpinner.start('Calculating checksum')

    const root = findRoot(cwd())
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

    let updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, options.packageJson)

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

    const checksum = await getChecksum(
      zipped,
      options.keyV2 || existsSync(baseKeyV2) || useSha256 ? 'sha256' : 'crc32',
    )

    if (checksumSpinner)
      checksumSpinner.stop(`Checksum ${useSha256 ? 'SHA256' : 'CRC32'}: ${checksum}`)

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

    void trackEvent({ channel: 'bundle', event: 'Bundle Zipped', tags: { zip_size_bytes: zipped.byteLength } })

    if (shouldShowPrompts)
      outro('Done ✅')

    if (!silent && json) {
      emitJson({
        bundle,
        filename,
        checksum,
      })
    }

    return {
      bundle,
      filename,
      checksum,
    }
  }
  catch (error) {
    if (!silent) {
      if (json)
        emitJsonError(error)
      else
        log.error(formatError(error))
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function zipBundle(appId: string, options: BundleZipOptions) {
  await zipBundleInternal(appId, options, false)
}
