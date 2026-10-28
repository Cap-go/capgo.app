/**
 * Every hosted MCP error must leave the agent a way out: what to change and retry, which tool reads
 * the missing data, what to ask the user, or, when the failure is not expected, how to reach support.
 * An agent reading a bare `{ status: 400, error: 'invalid_body' }` has nowhere to go.
 */

export const SUPPORT_EMAIL = 'support@capgo.app'
const CONSOLE = 'https://console.capgo.app'

export type ErrorKind
  = | 'fix_input'
    | 'not_found'
    | 'conflict'
    | 'authentication'
    | 'permission'
    | 'security_policy'
    | 'plan_limit'
    | 'rate_limited'
    | 'expired'
    | 'unexpected'

export interface ErrorGuidance {
  /** Whether the error is a normal outcome the agent can fix, or something support must look at. */
  kind: ErrorKind
  next_steps: string[]
}

export interface ErrorGuidanceInput {
  status?: number
  code?: string
  message?: string
  tool?: string
  requestId?: string
}

function supportStep(input: ErrorGuidanceInput): string {
  const details = [
    input.tool ? `the tool (${input.tool})` : 'the tool name',
    input.requestId ? `request id ${input.requestId}` : undefined,
    'the time',
    'this error',
  ].filter(Boolean).join(', ')
  return `If you cannot solve it with these steps, stop retrying and tell the user to contact ${SUPPORT_EMAIL} with ${details}. Do not include API keys or secrets.`
}

const docsStep = (code: string | undefined) => code
  ? `Search the docs with capgo_search_docs for "${code.replaceAll('_', ' ')}" to learn more.`
  : 'Search the docs with capgo_search_docs for the feature you are using.'

function matches(code: string, message: string, fragments: string[]) {
  return fragments.some(fragment => code.includes(fragment) || message.includes(fragment))
}

/** Classify an API or tool error and say what the agent should do next. */
export function guidanceForError(input: ErrorGuidanceInput): ErrorGuidance {
  const status = input.status ?? 0
  const code = (input.code ?? '').toLowerCase()
  const message = (input.message ?? '').toLowerCase()
  const withEscape = (kind: ErrorKind, steps: string[]): ErrorGuidance => ({
    kind,
    next_steps: [...steps, docsStep(input.code), supportStep(input)],
  })

  if (matches(code, message, ['requires_expiring_key', 'expiration_required', 'expiration_exceeds_max', '2fa', 'password_policy', 'password_does_not_meet_policy', 'security_policy', 'sso'])) {
    return withEscape('security_policy', [
      'The organization enforces a security policy (API key expiration, 2FA or password rules) that this connection does not meet. This is not something to retry.',
      `Ask the user to comply in the console: 2FA and password at ${CONSOLE}/settings/account, a new API key with an expiration date at ${CONSOLE}/apikeys, policies at ${CONSOLE}/settings/organization/security.`,
      'Then reconnect the Capgo MCP (OAuth) or update the API key it uses, and call the tool again.',
    ])
  }

  if (status === 429 || matches(code, message, ['rate_limit', 'rate_limited', 'too_many', 'concurrency_limit'])) {
    return withEscape('rate_limited', [
      'Too many requests or concurrent jobs. Wait before retrying (about a minute for request limits, or until running builds finish), and do not retry in a tight loop.',
      'Batch your reads (use pagination and filters) instead of calling a tool once per item.',
    ])
  }

  if (status === 402 || matches(code, message, ['need_plan', 'plan_upgrade', 'plan_permission', 'trial_plan', 'missing_payment_method', 'over_limit', 'quota', 'on_premise'])) {
    return withEscape('plan_limit', [
      'The organization\'s plan or billing state does not allow this action. Retrying will not help.',
      `Read the current plan and usage with capgo_get_organization and capgo_get_organization_statistics, then ask the user whether to upgrade or fix billing at ${CONSOLE}/settings/organization/plans.`,
    ])
  }

  if (status === 401 || matches(code, message, ['invalid_apikey', 'invalid_jwt', 'not_authenticated', 'unauthorized', 'apikey_expired', 'invalid_subkey'])) {
    return withEscape('authentication', [
      'The API key behind this MCP connection is missing, invalid, expired or revoked. Call capgo_whoami to confirm.',
      `Ask the user to reconnect the Capgo MCP (sign in again through OAuth) or create a new API key at ${CONSOLE}/apikeys and update the connection.`,
    ])
  }

  if (status === 403 || matches(code, message, ['not_authorized', 'no_permission', 'permission_denied', 'access_denied', 'cannot_access', 'forbidden', 'not_allowed'])) {
    return withEscape('permission', [
      'This API key or its user does not have the role needed for this organization or app. Retrying will not help.',
      'Check which organizations and apps this connection can use with capgo_whoami, capgo_list_organizations and capgo_list_apps, and make sure the IDs you passed belong to them.',
      `If the user needs more rights, an organization admin can change their role (capgo_update_organization_member_role or ${CONSOLE}/settings/organization/members). A key limited to some apps or orgs must be replaced by one with access at ${CONSOLE}/apikeys.`,
    ])
  }

  if (matches(code, message, ['expired', 'upload_missing', 'upload_session_invalid'])) {
    return withEscape('expired', [
      'A signed URL, upload token or temporary request expired or was already used. Restart that step from the beginning (for example call capgo_prepare_bundle_upload or capgo_get_build_upload_url again) and finish it promptly.',
    ])
  }

  if (status === 404 || matches(code, message, ['not_found', 'cannot_find', 'missing_app', 'does_not_exist'])) {
    return withEscape('not_found', [
      'The ID you passed does not exist or this connection cannot see it. Do not guess IDs.',
      'List the real ones and call the tool again with an exact ID: capgo_list_organizations, capgo_list_apps, capgo_list_channels, capgo_list_bundles, capgo_list_devices or capgo_list_webhooks.',
      'If the user expects it to exist, it may be in an organization this connection cannot access: ask them which account or organization owns it.',
    ])
  }

  if (status === 409 || matches(code, message, ['already_exists', 'already_invited', 'already_subscribed', 'duplicate', 'conflict'])) {
    return withEscape('conflict', [
      'The resource already exists. Read it with the matching get or list tool and use or update it instead of creating it again.',
      'If the user really needs a new one, ask them for a different name or ID.',
    ])
  }

  if (status === 413) {
    return withEscape('fix_input', [
      'The payload is too large. Send less data: paginate, narrow filters, or upload files through the signed upload URL tools instead of inline.',
    ])
  }

  if ((status >= 400 && status < 500) || matches(code, message, ['invalid', 'missing', 'required', 'malformed', 'bad_request'])) {
    return withEscape('fix_input', [
      'The request was rejected because an argument is missing, malformed or not allowed. The message above names the problem.',
      'Fix that argument (check the tool\'s inputSchema from tools/list and read current values with the matching get or list tool) and call the tool again. Ask the user for any value you do not know instead of inventing one.',
    ])
  }

  return {
    kind: 'unexpected',
    next_steps: [
      'This is not an expected error. Retry the same call once after a few seconds.',
      `If it fails again, stop and tell the user Capgo hit an unexpected error, and ask them to contact ${SUPPORT_EMAIL} with ${input.tool ? `the tool (${input.tool})` : 'the tool name'}${input.requestId ? `, request id ${input.requestId}` : ''}, the time and this error. Do not include API keys or secrets.`,
      'Meanwhile, check https://status.capgo.app for an ongoing incident.',
    ],
  }
}

/** Marker so the protocol layer can tell whether a tool already explained its error. */
export const GUIDANCE_KEY = 'how_to_fix'
