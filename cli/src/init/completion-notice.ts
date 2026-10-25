import type { NoticeOutputOptions } from '../onboarding/setup-notice-policy'
import type { CapgoClient } from '../utils'
import { renderSetupNotice } from '../onboarding/background-shutdown'
import { setupDebug, setupError } from '../onboarding/setup-diagnostics'
import { readSetupProgress } from '../onboarding/setup-notice-evaluation'
import { ONBOARDING_CHECK_GRACE_MS, shouldPrintNotice } from '../onboarding/setup-notice-policy'
import { getSetupNotice } from '../onboarding/setup-notices'
import { isAgentInvocation } from '../shared/agent-notices'

export async function printInitCompletionNotice(
  appId: string,
  client: Pick<CapgoClient, 'apiHost' | 'apikey'>,
  webHost: string,
  options: NoticeOutputOptions,
): Promise<void> {
  if (!isAgentInvocation() || !shouldPrintNotice(options))
    return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ONBOARDING_CHECK_GRACE_MS)
  try {
    const progress = await readSetupProgress({ ...client, project: { appId } }, controller.signal)
    const notice = progress && getSetupNotice(appId, progress, webHost)
    // Earlier trial warnings can disappear during TUI redraws. This is the
    // persistent footer, so it must not inherit their display suppression.
    if (notice)
      renderSetupNotice(notice, true)
  }
  catch (error) {
    setupDebug('init completion notice failed', { error: setupError(error) })
  }
  finally {
    clearTimeout(timer)
  }
}
