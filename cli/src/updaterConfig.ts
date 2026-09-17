type AutoUpdatePolicy = boolean | 'off' | 'atBackground' | 'atInstall' | 'onLaunch' | 'always' | 'onlyDownload'
type DirectUpdatePolicy = boolean | 'atInstall' | 'always' | 'onLaunch'

export interface CapacitorUpdaterPluginConfig {
  autoUpdate?: AutoUpdatePolicy
  directUpdate?: DirectUpdatePolicy
}

export const DIRECT_UPDATE_WITHOUT_DELTA_EVENT = 'Direct Update Without Delta'

export function usesAlwaysDirectUpdate(config: CapacitorUpdaterPluginConfig | undefined): boolean {
  const autoUpdate = config?.autoUpdate

  if (autoUpdate === 'always')
    return true

  if (typeof autoUpdate === 'string' || autoUpdate === false)
    return false

  const directUpdate = config?.directUpdate
  return directUpdate === true || directUpdate === 'always'
}

/** Splash-blocking direct/instant update modes that should upload with delta. */
export function usesDirectUpdate(config: CapacitorUpdaterPluginConfig | undefined): boolean {
  const autoUpdate = config?.autoUpdate

  if (autoUpdate === 'always' || autoUpdate === 'atInstall' || autoUpdate === 'onLaunch')
    return true

  if (typeof autoUpdate === 'string' || autoUpdate === false)
    return false

  const directUpdate = config?.directUpdate
  return directUpdate === true || directUpdate === 'always' || directUpdate === 'atInstall' || directUpdate === 'onLaunch'
}

export function shouldWarnDirectUpdateWithoutDelta(input: {
  instantUpdateEnabled: boolean
  deltaEnabled: boolean
  dryUpload?: boolean
}): boolean {
  return input.instantUpdateEnabled && !input.deltaEnabled && !input.dryUpload
}
