import type { CapacitorConfig } from '../config'
import { CliUserError } from '../shared/cli-user-error'
import { getAppId } from '../utils'

export function getConfiguredBuilderAppId(config: CapacitorConfig | undefined): string | undefined {
  const builderConfig: unknown = config?.plugins?.CapgoBuilder
  if (builderConfig !== null && typeof builderConfig === 'object' && Object.hasOwn(builderConfig, 'capgoBuilderAppId')) {
    const value: unknown = (builderConfig as Record<string, unknown>).capgoBuilderAppId
    if (typeof value !== 'string' || !value.trim())
      throw new CliUserError('Invalid Capacitor config: plugins.CapgoBuilder.capgoBuilderAppId must be a non-empty string')
    return value.trim()
  }
  return undefined
}

/** Resolve the Capgo app key for Builder commands only. */
export function getBuilderAppId(
  explicitAppId: string | undefined,
  config: CapacitorConfig | undefined,
  legacyDefault: 'updater' | 'native' = 'updater',
  explicitMode: 'truthy' | 'defined' = 'truthy',
): string | undefined {
  const configuredAppId = getConfiguredBuilderAppId(config)

  if (explicitMode === 'defined' ? explicitAppId !== undefined : Boolean(explicitAppId))
    return explicitAppId
  if (configuredAppId)
    return configuredAppId
  return legacyDefault === 'native' ? config?.appId : getAppId(undefined, config)
}
