import type { BundleReleaseTypeOptions } from '../schemas/bundle'
import { stdout } from 'node:process'
import { log } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { formatError } from '../utils'
import { checkCompatibilityInternal } from './compatibility'

interface ReleaseTypeResult {
  releaseType: 'native' | 'OTA'
  resolvedAppId: string
  channel: string
}

/**
 * Determine whether a native build or OTA update is recommended.
 */
export async function getReleaseType(appId: string, options: BundleReleaseTypeOptions): Promise<ReleaseTypeResult> {
  const compatibility = await checkCompatibilityInternal(appId, options, true)
  const hasIncompatible = compatibility.hasIncompatible
  return {
    releaseType: hasIncompatible ? 'native' : 'OTA',
    resolvedAppId: compatibility.resolvedAppId,
    channel: compatibility.channel,
  }
}

/**
 * Print the recommended release type and the relevant CLI commands.
 */
export async function printReleaseType(appId: string, options: BundleReleaseTypeOptions) {
  try {
    const { releaseType, resolvedAppId, channel } = await getReleaseType(appId, options)
    const lines = releaseType === 'OTA'
      ? [
          'Recommendation: OTA',
          `Run: npx @capgo/cli@latest bundle upload ${resolvedAppId} --channel ${channel}`,
        ]
      : [
          'Recommendation: native',
          `Save credentials: npx @capgo/cli@latest build credentials save --appId ${resolvedAppId} --platform <ios|android>`,
          `Request build: npx @capgo/cli@latest build request ${resolvedAppId} --platform <ios|android> --path .`,
        ]
    stdout.write(`${lines.join('\n')}\n`)
    void trackEvent({ channel: 'bundle', event: 'Release Type Printed', tags: { release_type: releaseType } })
  }
  catch (error) {
    log.error(`Error checking release type ${formatError(error)}`)
    throw error
  }
}
