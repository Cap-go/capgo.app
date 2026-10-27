import type { BuildZipOptions, BuildZipResult } from '../schemas/build'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import pack from '../../package.json'
import { withStdoutOnStderr } from '../shared/json-stdout'
import { formatError, getConfig } from '../utils'
import { getBuilderAppId } from './app-id'
import { detectIosDependencyManager, nativeProjectDirCredentials, PROJECT_DERIVED_BUILD_OPTION_KEYS, syncLocalNativeVersion, zipDirectory } from './archive'
import { withCwd } from './cwd'
import { getPlatformDirFromCapacitorConfig } from './platform-paths'
import { resolveBuildPlatform, splitPayload } from './request'

export type { BuildZipOptions, BuildZipResult } from '../schemas/build'

/**
 * Offline `build zip`: write the exact native project archive `build request`
 * uploads (same file filter, path rewriting, version sync and config
 * resolution), plus the non-secret build_options derived from the project, so
 * an agent can upload it through a signed URL. No API key, no network.
 */
export async function zipBuildInternal(appId: string | undefined, options: BuildZipOptions, silent = false): Promise<BuildZipResult> {
  const json = !!options.json
  const quiet = silent || json
  const run = async (): Promise<BuildZipResult> => {
    const projectDir = resolve(options.path || cwd())

    // @capacitor/cli loadConfig() is cwd-based; honor --path like `build request`.
    const config = await withCwd(projectDir, () => getConfig())
    const resolvedAppId = getBuilderAppId(appId, config?.config, 'native') || ''
    if (!resolvedAppId)
      throw new Error('Missing argument, you need to provide a appId, or be in a capacitor project')

    const platform = await resolveBuildPlatform(options.platform, { silent: quiet })
    if (!quiet)
      intro(`Zipping ${platform} native project for ${resolvedAppId}`)

    syncLocalNativeVersion(platform, projectDir, options, (message) => {
      if (!quiet)
        log.info(message)
    })

    const nativeProjectDir = getPlatformDirFromCapacitorConfig(config?.config, platform)
    const { buildOptions } = splitPayload(nativeProjectDirCredentials(platform, nativeProjectDir), platform, 'release', pack.version)
    const projectBuildOptions: BuildZipResult['build_options'] = { platform }
    for (const key of PROJECT_DERIVED_BUILD_OPTION_KEYS) {
      if (buildOptions[key] !== undefined)
        projectBuildOptions[key] = buildOptions[key]
    }

    const iosDependencyManager = platform === 'ios'
      ? detectIosDependencyManager(projectDir, nativeProjectDir)
      : undefined

    const filename = resolve(options.output || `${resolvedAppId}_${platform}_native.zip`)
    if (!quiet)
      log.info(`Zipping ${platform} project from ${projectDir}...`)
    await zipDirectory(projectDir, filename, platform, config?.config, {
      nodeModules: options.nodeModules,
    })

    const data = await readFile(filename)
    const result: BuildZipResult = {
      app_id: resolvedAppId,
      platform,
      filename,
      size_bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      ...(iosDependencyManager ? { ios_dependency_manager: iosDependencyManager } : {}),
      build_options: projectBuildOptions,
    }

    if (!quiet) {
      log.success(`Created zip: ${filename} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB)`)
      outro('Done ✅')
    }
    return result
  }

  try {
    const result = json && !silent ? await withStdoutOnStderr(run) : await run()
    if (json && !silent) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2))
    }
    return result
  }
  catch (error) {
    if (!silent) {
      if (json)
        console.error(formatError(error))
      else
        log.error(formatError(error))
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function zipBuildCommand(appId: string | undefined, options: BuildZipOptions): Promise<void> {
  await zipBuildInternal(appId, options, false)
}
