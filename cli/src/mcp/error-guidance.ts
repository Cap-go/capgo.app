/**
 * Every local MCP error must leave the agent a way out: what to change and retry, which tool to
 * call, what to ask the user, or, when the failure is not expected, how to reach support.
 * Mirrors the hosted MCP server's error guidance (backend mcp/error_guidance.ts), with steps that
 * use the local tools (capgo_login, capgo_set_project_dir, capgo_doctor).
 */

export const SUPPORT_EMAIL = 'support@capgo.app'
const CONSOLE = 'https://console.capgo.app'
/** Heading that marks an error text as already explained; the safety net skips those. */
export const GUIDANCE_HEADING = 'How to fix'

export type ErrorKind
  = | 'fix_input'
    | 'project'
    | 'not_found'
    | 'conflict'
    | 'authentication'
    | 'permission'
    | 'security_policy'
    | 'plan_limit'
    | 'rate_limited'
    | 'expired'
    | 'network'
    | 'unexpected'

export interface ErrorGuidance {
  kind: ErrorKind
  nextSteps: string[]
}

function has(text: string, fragments: string[]) {
  return fragments.some(fragment => text.includes(fragment))
}

function supportStep(tool: string | undefined) {
  return `If these steps do not solve it, stop retrying and tell the user to contact ${SUPPORT_EMAIL} with ${tool ? `the tool (${tool})` : 'the tool name'}, the time, this error and the output of capgo_doctor. Do not include API keys or secrets.`
}

/** Classify an error message from a local MCP tool and say what the agent should do next. */
export function guidanceForError(message: string, tool?: string): ErrorGuidance {
  const text = message.toLowerCase()
  const withEscape = (kind: ErrorKind, steps: string[]): ErrorGuidance => ({
    kind,
    nextSteps: [
      ...steps,
      'Search the docs with capgo_search_docs for the feature or error you hit to learn more.',
      supportStep(tool),
    ],
  })

  if (has(text, ['requires_expiring_key', 'expiration_required', 'expiration_exceeds_max', 'requires api keys with expiration', '2fa', 'two-factor', 'password_policy', 'security policy'])) {
    return withEscape('security_policy', [
      'The organization enforces a security policy (API key expiration, 2FA or password rules) that the saved key or user does not meet. Retrying will not help.',
      `Ask the user to comply in the console (2FA and password at ${CONSOLE}/settings/account, a new key with an expiration date at ${CONSOLE}/apikeys), then call capgo_login with the new key and retry.`,
    ])
  }

  if (has(text, ['missing api key', 'no api key', 'no capgo api key', 'api key found', 'no capgo client or api key', 'not logged in', 'login` first', 'login first', 'please login', 'invalid api key', 'invalid_apikey', 'invalid apikey', 'apikey expired', 'api key expired', 'invalid_jwt', 'unauthorized', 'not_authenticated', ' 401'])) {
    return withEscape('authentication', [
      'The Capgo CLI has no valid API key. Call capgo_whoami to see which key, if any, is in use.',
      `Ask the user for a Capgo API key (they create one at ${CONSOLE}/apikeys), then call capgo_login with it and retry the tool.`,
    ])
  }

  if (has(text, ['need_plan', 'plan_upgrade', 'upgrade your plan', 'upgrade plan', 'plan limit', 'trial', 'missing_payment_method', 'payment method', 'over limit', 'quota'])) {
    return withEscape('plan_limit', [
      'The organization\'s plan or billing state does not allow this action. Retrying will not help.',
      `Check usage with capgo_get_stats, then ask the user whether to upgrade or fix billing at ${CONSOLE}/settings/organization/plans.`,
    ])
  }

  if (has(text, ['rate limit', 'rate_limit', 'too many requests', 'too_many', ' 429', 'concurrency_limit'])) {
    return withEscape('rate_limited', [
      'Too many requests or concurrent jobs. Wait before retrying (about a minute, or until running builds finish), and do not retry in a tight loop.',
    ])
  }

  if (has(text, ['not_authorized', 'not authorized', 'no_permission', 'no permission', 'permission denied', 'permission_denied', 'access denied', 'access_denied', 'cannot_access', 'forbidden', ' 403', 'insufficient'])) {
    return withEscape('permission', [
      'The saved API key or its user does not have the role needed for this organization or app. Retrying will not help.',
      'Check what this key can reach with capgo_whoami and capgo_list_apps, and make sure the app ID belongs to it.',
      `If the user needs more rights, an organization admin can change their role at ${CONSOLE}/settings/organization/members, or the user can create a key with access at ${CONSOLE}/apikeys and call capgo_login with it.`,
    ])
  }

  if (has(text, ['capacitor config', 'capacitor.config', 'capacitor project', 'missing appid', 'does not define an app id', 'package.json', 'webdir', 'cannot find project', 'no capgo app id found', 'not a capacitor'])) {
    return withEscape('project', [
      'The MCP is not looking at the right project folder, or the project is missing Capacitor configuration.',
      'Call capgo_set_project_dir with the absolute path of the Capacitor app folder (the one with capacitor.config and package.json), then retry.',
      'If the project really has no appId, pass appId explicitly to the tool, or ask the user for the app ID and set it in capacitor.config.',
    ])
  }

  if (has(text, ['expired', 'upload_missing', 'upload session'])) {
    return withEscape('expired', [
      'A signed URL, upload or temporary token expired. Restart that step from the beginning and finish it promptly.',
    ])
  }

  if (has(text, ['not found', 'not_found', 'cannot find', 'cannot_find', 'does not exist', 'no such', ' 404', 'enoent'])) {
    return withEscape('not_found', [
      'Something you referenced does not exist or this key cannot see it. Do not guess names or IDs.',
      'List the real ones (capgo_list_apps, capgo_list_channels, capgo_list_bundles) or check the file path, then call the tool again.',
      'If the user expects it to exist, ask them which account or organization owns it.',
    ])
  }

  if (has(text, ['already exists', 'already_exists', 'duplicate', 'conflict', ' 409'])) {
    return withEscape('conflict', [
      'It already exists. Read it with the matching list tool and use or update it instead of creating it again.',
      'If the user really needs a new one, ask them for a different name or ID.',
    ])
  }

  if (has(text, ['econnrefused', 'enotfound', 'etimedout', 'econnreset', 'eai_again', 'fetch failed', 'network', 'socket hang up', 'timed out', 'timeout'])) {
    return withEscape('network', [
      'Capgo could not be reached. Retry once after a few seconds.',
      'If it keeps failing, check the network, proxy or VPN of this machine (run capgo_doctor) and https://status.capgo.app for an incident.',
    ])
  }

  if (has(text, ['invalid', 'missing', 'required', 'must be', 'expected', 'malformed', 'unsupported', ' 400'])) {
    return withEscape('fix_input', [
      'An argument is missing, malformed or not allowed. The message above names the problem.',
      'Fix that argument (check the tool\'s input schema and current values with the matching list tool) and call the tool again. Ask the user for any value you do not know instead of inventing one.',
    ])
  }

  return {
    kind: 'unexpected',
    nextSteps: [
      'This is not an expected error. Retry the same call once.',
      'Run capgo_doctor to check the local setup, and check https://status.capgo.app for an incident.',
      `If it still fails, stop and tell the user Capgo hit an unexpected error, and ask them to contact ${SUPPORT_EMAIL} with ${tool ? `the tool (${tool})` : 'the tool name'}, the time, this error and the capgo_doctor output. Do not include API keys or secrets.`,
    ],
  }
}

export function formatGuidance(guidance: ErrorGuidance): string {
  return `${GUIDANCE_HEADING} (${guidance.kind}):\n${guidance.nextSteps.map(step => `- ${step}`).join('\n')}`
}

/** Append guidance to an error text unless the tool already explained the way out. */
export function explainError(message: string, tool?: string): string {
  if (message.includes(GUIDANCE_HEADING))
    return message
  return `${message.trimEnd()}\n\n${formatGuidance(guidanceForError(message, tool))}`
}

interface ToolResultLike {
  content?: Array<{ type: string, text?: string }>
  isError?: boolean
}

/** Append guidance to the first text block of an error tool result, unless it is already explained. */
function guideToolResult<R extends ToolResultLike>(result: R, tool?: string): R {
  if (!result.isError || !Array.isArray(result.content))
    return result
  if (result.content.some(part => part.type === 'text' && part.text?.includes(GUIDANCE_HEADING)))
    return result
  const firstText = result.content.findIndex(part => part.type === 'text')
  const content = firstText === -1
    ? [...result.content, { type: 'text', text: explainError('The tool failed without details.', tool) }]
    : result.content.map((part, index) => index === firstText ? { ...part, text: explainError(part.text ?? '', tool) } : part)
  return { ...result, content }
}

/**
 * Safety net for every registered tool: error results get guidance appended, and a thrown error
 * becomes an error result with guidance instead of a bare protocol error.
 */
export function withErrorGuidance<H extends (...args: any[]) => Promise<unknown>>(tool: string, handler: H): H {
  const wrapped = async (...args: Parameters<H>) => {
    try {
      const result = await handler(...args)
      return result && typeof result === 'object' ? guideToolResult(result as ToolResultLike, tool) : result
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text: explainError(`${tool} failed: ${message}`, tool) }], isError: true as const }
    }
  }
  return wrapped as H
}

/**
 * Last safety net on the transport: a JSON-RPC response carrying an error tool result that no
 * handler explained (e.g. the SDK rejected the arguments) gets guidance. Other messages pass through.
 */
export function withGuidedErrorResults<M>(message: M): M {
  const result = (message as { result?: ToolResultLike } | null)?.result
  if (!result || typeof result !== 'object')
    return message
  const guided = guideToolResult(result)
  return guided === result ? message : { ...message, result: guided }
}
