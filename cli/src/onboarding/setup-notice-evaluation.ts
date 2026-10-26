import type { AppTodoProgress } from '../app/todo'
import type { PreparedOnboardingCheck } from './background-check'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { trimTrailingSlashes } from '../utils'
import { setupDebug, setupError } from './setup-diagnostics'

export const SETUP_PROGRESS_TIMEOUT_MS = 15_000
export async function readSetupProgress(prepared: Pick<PreparedOnboardingCheck, 'apiHost' | 'apikey'> & { project: { appId: string } }, cancellation?: AbortSignal): Promise<AppTodoProgress | undefined> {
  const started = Date.now()
  setupDebug('progress request started', { budget_ms: SETUP_PROGRESS_TIMEOUT_MS, include_billing: true })
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onCancel: (() => void) | undefined
  try {
    if (cancellation?.aborted)
      return
    return await Promise.race([
      (async () => {
        const response = await fetch(`${trimTrailingSlashes(prepared.apiHost)}/private/onboarding_progress`, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: buildCliRequestHeaders({
            'Content-Type': 'application/json',
            'Authorization': prepared.apikey,
            'capgkey': prepared.apikey,
          }),
          body: JSON.stringify({ appId: prepared.project.appId, N: 0, initial: true, includeBilling: true }),
        })
        setupDebug('progress response received', { duration_ms: Date.now() - started, status: response.status })
        if (!response.ok)
          return
        const data = await response.json() as AppTodoProgress
        const valid = !!data && Object.hasOwn(data, 'onboarding')
        setupDebug('progress decoded', { valid, check_errors: data?.checkErrors?.length ?? 0 })
        return valid ? data : undefined
      })(),
      new Promise<undefined>((resolve) => {
        onCancel = () => {
          setupDebug('progress request cancelled', { duration_ms: Date.now() - started })
          controller.abort()
          resolve(undefined)
        }
        cancellation?.addEventListener('abort', onCancel, { once: true })
        if (cancellation?.aborted)
          onCancel()
        timer = setTimeout(() => {
          setupDebug('progress request timed out', { duration_ms: Date.now() - started })
          resolve(undefined)
        }, SETUP_PROGRESS_TIMEOUT_MS)
      }),
    ])
  }
  catch (error) {
    setupDebug('progress request failed', { duration_ms: Date.now() - started, error: setupError(error) })
    // Optional progress/billing cannot fail the requested command.
    return undefined
  }
  finally {
    if (onCancel)
      cancellation?.removeEventListener('abort', onCancel)
    clearTimeout(timer)
    controller.abort()
  }
}
