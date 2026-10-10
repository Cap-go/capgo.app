import type { CapgoClient } from '../utils'
import { log } from '@clack/prompts'
import { CliUserError } from '../shared/cli-user-error'
import { isTransientNetworkError } from '../shared/network-error'
import {
  callTwoFactorComplianceRpcWithRetry,
  throwTwoFactorComplianceRpcError,
  warnAndContinueTwoFactorPreflightNetworkFailure,
} from '../shared/two-factor-compliance'
import {
  appAddHintMessage,
  formatCapgoCliInvokeError,
  getCapgoCliHttpStatus,
  getRemoteConfig,
  invokeCliHttpFromClient,
  openExternalUrl,
  readCapgoCliApiErrorPayload,
  show2FADeniedError,
} from '../utils'

/** What a command needs checked before it acts. The backend owns every rule. */
export interface CliPreflightRequest {
  appId?: string
  orgId?: string
  channelId?: number | null
  /** RBAC permission the command needs, scoped to channel, app or org. */
  permission?: string
  /** Enforce the org 2FA policy (default true). */
  check2fa?: boolean
  /** Metered plan gate: `all` for usage commands, `upload` for storage-only. */
  plan?: 'all' | 'upload'
  /** Show org CLI warnings targeted at this CLI version. */
  cliVersion?: string
}

export interface CliPreflightResult {
  userId: string | null
  orgId: string | null
  appId: string | null
  trialDaysLeft: number | null
  warnings: Array<{ message: string, fatal: boolean }>
}

export interface CliPreflightOptions {
  silent?: boolean
  /** Print the unpaid-trial reminder (default true). */
  warnTrial?: boolean
  /** Message for `app_not_found`; defaults to the `app add` hint. */
  appNotFoundMessage?: string
  /** Logged message for `permission_denied`; defaults to the missing permission key. */
  permissionDeniedMessage?: string
  /** Thrown error message for `permission_denied` (stable for telemetry); defaults to the logged one. */
  permissionDeniedErrorMessage?: string
  /** Organization name for the 2FA denial banner. */
  organizationName?: string
  telemetryFunctionName?: string
}

interface PreflightResponse {
  user_id?: string | null
  org_id?: string | null
  app_id?: string | null
  trial_days_left?: number | null
  warnings?: unknown[]
}

function isCliWarning(value: unknown): value is { message: string, fatal: boolean } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { message?: unknown }).message === 'string'
    && typeof (value as { fatal?: unknown }).fatal === 'boolean'
}

async function plansUrl() {
  const config = await getRemoteConfig()
  return `${config.hostWeb}/settings/organization/plans`
}

function printWarnings(warnings: unknown[]) {
  if (warnings.length === 0)
    return
  log.warn(`Found ${warnings.length} cli warnings for your organization.`)
  let fatalError: Error | null = null
  for (const warning of warnings) {
    if (!isCliWarning(warning)) {
      log.error(`Invalid cli warning: ${JSON.stringify(warning)}`)
      continue
    }
    const text = warning.message.replaceAll('\\n', '\n')
    if (warning.fatal) {
      log.error(text)
      fatalError = new Error(warning.message)
    }
    else {
      log.warn(text)
    }
  }
  if (fatalError) {
    log.error('Please fix the warnings and try again.')
    throw fatalError
  }
  log.info('End of cli warnings.')
}

async function throwPreflightError(request: CliPreflightRequest, error: Error, options: CliPreflightOptions): Promise<never> {
  if (error instanceof CliUserError)
    throw error
  const payload = await readCapgoCliApiErrorPayload(error)
  const silent = options.silent === true
  switch (payload?.error) {
    case '2fa_required': {
      if (silent)
        throw new Error('2FA required for this organization')
      show2FADeniedError(options.organizationName)
      break
    }
    case 'app_not_found': {
      const message = options.appNotFoundMessage ?? appAddHintMessage(request.appId ?? '')
      if (!silent)
        log.error(message)
      throw new Error(message)
    }
    case 'permission_denied': {
      const message = options.permissionDeniedMessage ?? `Insufficient permissions for ${request.permission}`
      if (!silent)
        log.error(message)
      const context = Object.fromEntries(Object.entries({
        appId: request.appId,
        orgId: request.orgId,
        channelId: request.channelId ?? undefined,
        requiredPermissionKey: request.permission,
      }).filter(([, value]) => value !== undefined))
      throw new CliUserError(options.permissionDeniedErrorMessage ?? message, context)
    }
    case 'plan_upgrade_required': {
      const url = await plansUrl()
      log.error(`You need to upgrade your plan to continue to use capgo.\n Upgrade here: ${url}\n`)
      await openExternalUrl(url)
      throw new CliUserError(request.plan === 'upload' ? 'Plan upgrade required for upload' : 'Plan upgrade required')
    }
    case 'plan_permission_denied': {
      log.error('Cannot validate plan usage for this app. The API key may lack permission to read app billing details.')
      throw new CliUserError('Plan validation permission denied')
    }
    case 'invalid_apikey': {
      const message = 'Capgo authentication failed: invalid Capgo API key or insufficient Capgo permissions.'
      if (!silent)
        log.error(message)
      throw Object.assign(new Error(message), { status: 401 })
    }
  }
  const status = getCapgoCliHttpStatus(error)
  if (status === 401 || status === 403) {
    const message = request.appId
      ? 'Cannot access app. Check that your API key is valid and has app.read permission for this app.'
      : 'Cannot access organization. Check that your API key is valid and belongs to this organization.'
    if (!silent)
      log.error(message)
    throw new CliUserError(message, Object.fromEntries(Object.entries({ appId: request.appId, orgId: request.orgId }).filter(([, value]) => value !== undefined)))
  }
  const detail = await formatCapgoCliInvokeError(error)
  if (!silent)
    log.error(`Cannot verify access: ${detail}`)
  throw new Error(`Cannot verify access: ${detail}`, { cause: error })
}

/**
 * One backend call before a command acts: 2FA policy, app visibility, RBAC
 * permission, metered plan and org CLI warnings. Denials are rendered and thrown;
 * the result carries what the command needs next. Returns null only when Capgo is
 * unreachable after retries and 2FA was requested: the command continues and the
 * backend still enforces every rule on the real action.
 */
export async function runCliPreflight(
  client: CapgoClient,
  request: CliPreflightRequest,
  options: CliPreflightOptions = {},
): Promise<CliPreflightResult | null> {
  const { data, error } = await callTwoFactorComplianceRpcWithRetry(() => invokeCliHttpFromClient<PreflightResponse>(client, 'private/cli/preflight', {
    method: 'POST',
    body: {
      app_id: request.appId,
      org_id: request.orgId,
      channel_id: request.channelId ?? undefined,
      permission: request.permission,
      check_2fa: request.check2fa,
      plan: request.plan,
      cli_version: request.cliVersion,
    },
  }))

  if (error) {
    if (isTransientNetworkError(error)) {
      if (request.check2fa === false)
        throwTwoFactorComplianceRpcError(error)
      await warnAndContinueTwoFactorPreflightNetworkFailure({
        silent: options.silent,
        telemetryFunctionName: options.telemetryFunctionName ?? 'runCliPreflight',
      })
      return null
    }
    await throwPreflightError(request, error as Error, options)
  }

  const result: CliPreflightResult = {
    userId: data?.user_id ?? null,
    orgId: data?.org_id ?? null,
    appId: data?.app_id ?? null,
    trialDaysLeft: typeof data?.trial_days_left === 'number' ? data.trial_days_left : null,
    warnings: (data?.warnings ?? []).filter(isCliWarning),
  }

  printWarnings(data?.warnings ?? [])
  if (result.trialDaysLeft !== null && options.warnTrial !== false)
    log.warn(`WARNING !!\nTrial expires in ${result.trialDaysLeft} days, upgrade here: ${await plansUrl()}\n`)

  return result
}

/** Fail unless the org's 2FA policy lets this key act on it. */
export async function check2FAAccessForOrg(client: CapgoClient, orgId: string, silent = false): Promise<void> {
  await runCliPreflight(client, { orgId }, { silent, telemetryFunctionName: 'check2FAAccessForOrg' })
}

/** Fail unless the org plan allows usage (all metered actions); warns on unpaid trials. */
export async function checkPlanValid(client: CapgoClient, orgId: string, appId?: string, warning = true): Promise<void> {
  await runCliPreflight(client, { orgId, appId, plan: 'all', check2fa: false }, { warnTrial: warning })
}

/** Fail unless the org plan allows storage; warns on unpaid trials. */
export async function checkPlanValidUpload(client: CapgoClient, orgId: string, appId?: string, warning = true): Promise<void> {
  await runCliPreflight(client, { orgId, appId, plan: 'upload', check2fa: false }, { warnTrial: warning })
}
