import { Capacitor } from '@capacitor/core'
import { getConsoleApiHost } from '~/services/console'
import { pushEvent } from '~/services/posthog'

export type AssistantOutcome = 'success' | 'error' | 'cancelled'
const errorCodes = new Set([
  'access_denied',
  'chatgpt_plan_usage_not_granted',
  'no_eligible_organization',
  'invalid_callback',
  'chatgpt_usage_limit',
  'chatgpt_not_eligible',
  'chatgpt_reconnect_required',
  'assistant_upstream_error',
  'assistant_key_invalid',
  'assistant_session_required',
])

/** Only explicit scalar metadata crosses this boundary; never pass chat, errors or auth objects. */
export function createAssistantAnalytics(
  capture: (event: string, properties: Record<string, string | number | boolean>) => void,
  platform: string,
  now = () => performance.now(),
) {
  function emit(event: string, properties: Record<string, string | number | boolean> = {}) {
    try {
      capture(event, { ...properties, platform: ['ios', 'android'].includes(platform) ? platform : 'web', schema_version: 1, deployment: getConsoleApiHost()?.replace(/\/$/, '') === 'https://api.capgo.app' ? 'production' : 'non-production' })
    }
    catch {
      // Analytics must never prevent a connection, response or tool from completing.
    }
  }
  function start(kind: 'Connection' | 'Turn', trigger: 'connect' | 'message' | 'confirmation') {
    const started = now()
    emit(`Assistant ${kind} Started`, { trigger })
    let finished = false
    return (outcome: AssistantOutcome, errorCode = '') => {
      if (finished)
        return
      finished = true
      const duration = now() - started
      const fallbackErrorCode = outcome === 'error' ? 'unknown' : 'none'
      emit(`Assistant ${kind} Finished`, {
        trigger,
        outcome,
        duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
        error_code: errorCodes.has(errorCode) ? errorCode : fallbackErrorCode,
      })
    }
  }
  return {
    opened: (connected: boolean) => emit('Assistant Opened', { connected }),
    disconnected: () => emit('Assistant Disconnected'),
    start,
    // toolName must come from the MCP catalog, never from a model's unvalidated function call.
    toolFinished: (toolName: string, success: boolean) => emit('Assistant Tool Finished', { tool_name: toolName, outcome: success ? 'success' : 'error' }),
  }
}

export const assistantAnalytics = createAssistantAnalytics(
  (event, properties) => pushEvent(event, getConsoleApiHost(), properties),
  Capacitor.getPlatform(),
)
