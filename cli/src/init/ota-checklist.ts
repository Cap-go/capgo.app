import { log } from '@clack/prompts'
import { formatCapgoCliInvokeError, formatError, invokeCapgoCliApi } from '../utils'

export async function enableInitOtaChecklist(
  appId: string,
  options: { apikey: string, apiHost?: string },
  request = invokeCapgoCliApi,
  warn: (message: string) => void = log.warn,
): Promise<void> {
  try {
    const { error } = await request(`app/${encodeURIComponent(appId)}/onboarding/ota`, {
      apikey: options.apikey,
      apiHost: options.apiHost,
      method: 'POST',
      body: {},
      signal: AbortSignal.timeout(10_000),
    })
    if (error)
      throw new Error(await formatCapgoCliInvokeError(error))
  }
  catch (error) {
    // A checklist failure must not prevent OTA setup on older or unavailable servers.
    warn(`Could not enable the OTA checklist. Setup will continue: ${formatError(error)}`)
  }
}
