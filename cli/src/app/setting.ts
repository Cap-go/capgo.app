import type { AppSettingOptions } from '../schemas/app'
import { intro, log, outro } from '@clack/prompts'
import { writeConfigUpdater } from '../config'
import { formatError, getConfigForWrite } from '../utils'

export async function setSettingInternal(setting: string, options: AppSettingOptions, silent = false) {
  if (!silent)
    intro('Set a specific setting in capacitor config')

  if (options.bool && options.string) {
    if (!silent)
      log.error('Bool and string CANNOT be set at the same time')
    throw new Error('Bool and string cannot both be provided')
  }

  if (!options.bool && !options.string) {
    if (!silent)
      log.error('You MUST provide either bool or string as the value')
    throw new Error('Either bool or string value is required')
  }

  if (options.bool && options.bool !== 'true' && options.bool !== 'false') {
    if (!silent)
      log.error('Invalid bool')
    throw new Error('Invalid bool value; expected true or false')
  }

  try {
    const config = await getConfigForWrite()
    let baseObj = config.config as any
    const pathElements = setting.split('.')

    if (pathElements.length === 0) {
      if (!silent)
        log.error('Invalid path')
      throw new Error('Invalid config path')
    }

    for (const path of pathElements.slice(0, -1)) {
      if (!Object.hasOwn(baseObj, path))
        baseObj[path] = {}
      baseObj = baseObj[path]
    }

    const finalValue: boolean | string = options.bool ? options.bool === 'true' : options.string!

    baseObj[pathElements.at(-1)!] = finalValue
    await writeConfigUpdater(config, true)

    if (!silent)
      log.success(`Set "${setting}" to "${finalValue}"`)
  }
  catch (error) {
    if (!silent)
      log.error(`Cannot set config in capacitor settings ${formatError(error)}`)
    throw new Error(`Cannot set capacitor config: ${formatError(error)}`)
  }

  if (!silent)
    outro('Done ✅')
}

export async function setSetting(setting: string, options: AppSettingOptions) {
  return setSettingInternal(setting, options)
}
