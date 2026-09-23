import type { ExtConfigPairs } from '../config'
import type { OptionsUpload } from './upload_interface'
import { buildCordovaUploadConfig } from '../cordova/project'
import { isCordovaMode } from '../framework/mode'
import { CliUserError } from '../shared/cli-user-error'
import { getConfig, NO_CAPACITOR_CONFIG_MESSAGE } from '../utils'

export function buildCordovaModeUploadExample(options: Pick<OptionsUpload, 'path' | 'channel'> & { appId?: string }): string {
  const appId = options.appId?.trim() || '<appId>'
  const path = options.path?.trim() || 'www'
  const channel = options.channel?.trim() || '<channel>'
  return `npx @capgo/cli@latest bundle upload ${appId} --mode cordova --path ${path} --channel ${channel}`
}

export function buildMissingCapacitorConfigUploadMessage(options: Pick<OptionsUpload, 'path' | 'channel'> & { appId?: string }): string {
  return [
    NO_CAPACITOR_CONFIG_MESSAGE,
    'If this is a Cordova project (config.xml / plugin.xml and a www folder), retry with:',
    buildCordovaModeUploadExample(options),
  ].join('\n')
}

export function enhanceMissingCapacitorConfigUploadError(
  error: unknown,
  options: Pick<OptionsUpload, 'path' | 'channel'> & { appId?: string },
): never {
  if (error instanceof CliUserError && error.message === NO_CAPACITOR_CONFIG_MESSAGE) {
    throw new CliUserError(buildMissingCapacitorConfigUploadMessage({
      appId: options.appId,
      path: options.path,
      channel: options.channel,
    }))
  }
  throw error
}

export async function loadUploadProjectConfig(
  options: OptionsUpload,
  context: { appId?: string } = {},
): Promise<ExtConfigPairs> {
  if (isCordovaMode(options.mode))
    return buildCordovaUploadConfig({ path: options.path, appId: context.appId })

  try {
    return await getConfig()
  }
  catch (error) {
    enhanceMissingCapacitorConfigUploadError(error, {
      appId: context.appId,
      path: options.path,
      channel: options.channel,
    })
  }
}
