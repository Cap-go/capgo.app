import type { OrganizationMemberOptions, OrganizationMemberRole } from '../schemas/organization'
import { intro, isCancel, log, outro, select, text } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { checkAlerts } from '../api/update'
import { organizationMemberRoleSchema } from '../schemas/organization'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'

type MemberAction = 'invite' | 'remove' | 'role'

const ACTION_TITLES: Record<MemberAction, string> = {
  invite: 'Invite organization member',
  remove: 'Remove organization member',
  role: 'Change organization member role',
}

const ROLE_HINTS: Record<OrganizationMemberRole, string> = {
  org_member: 'Read access to the organization apps',
  org_billing_admin: 'Billing management only',
  org_admin: 'Manage apps, channels and members',
  org_super_admin: 'Full control, including security settings and deletion',
}

function parseRole(role: string | undefined): OrganizationMemberRole | undefined {
  if (role === undefined)
    return undefined
  const parsed = organizationMemberRoleSchema.safeParse(role)
  if (!parsed.success)
    throw new CliUserError(`Invalid role "${role}". Allowed: ${organizationMemberRoleSchema.options.join(', ')}`)
  return parsed.data
}

async function resolveEmail(email: string | undefined, silent: boolean): Promise<string> {
  if (email)
    return email
  if (silent)
    throw new CliUserError('Missing member email, pass --email')
  const input = await text({ message: 'Member email:', placeholder: 'teammate@example.com' })
  if (isCancel(input) || !input)
    throw new CliUserError('Organization member update cancelled')
  return input as string
}

async function resolveRole(role: string | undefined, silent: boolean): Promise<OrganizationMemberRole> {
  const parsed = parseRole(role)
  if (parsed)
    return parsed
  if (silent)
    throw new CliUserError(`Missing role, pass --role (${organizationMemberRoleSchema.options.join(', ')})`)
  const input = await select({
    message: 'Role:',
    options: organizationMemberRoleSchema.options.map(value => ({ value, label: value, hint: ROLE_HINTS[value] })),
  })
  if (isCancel(input))
    throw new CliUserError('Organization member update cancelled')
  return input as OrganizationMemberRole
}

async function manageMemberInternal(action: MemberAction, orgId: string, options: OrganizationMemberOptions, silent: boolean) {
  if (!silent)
    intro(ACTION_TITLES[action])

  await checkAlerts()

  const apikey = options.apikey || findSavedKey()
  if (!orgId) {
    if (!silent)
      log.error('Missing argument, you need to provide an organization ID')
    throw new CliUserError('Missing organization id')
  }

  const email = await resolveEmail(options.email, silent)
  const role = action === 'remove' ? undefined : await resolveRole(options.role, silent)

  const request = {
    invite: { method: 'POST', body: { orgId, email, invite_type: role } },
    remove: { method: 'DELETE', body: { orgId, email } },
    role: { method: 'PUT', body: { orgId, email, role } },
  }[action]

  const { data, error } = await invokeCapgoCliApi<Record<string, unknown>>('organization/members', {
    apikey,
    method: request.method,
    body: request.body,
    apiHost: options.apiHost,
  })

  if (error) {
    const message = await formatCapgoCliInvokeError(error)
    if (!silent)
      log.error(`Could not ${action === 'role' ? 'change the role of' : action} member ${email}: ${message}`)
    throw new Error(`Could not ${action === 'role' ? 'change the role of' : action} member: ${message}`)
  }

  void trackEvent({ channel: 'organization', orgId, event: `Org Member ${action === 'invite' ? 'Invited' : action === 'remove' ? 'Removed' : 'Role Changed'}`, apikey, tags: { ...(role ? { role } : {}) } })

  if (!silent) {
    if (action === 'invite')
      log.success(`Invitation sent to ${email} as ${role}`)
    else if (action === 'remove')
      log.success(`Removed ${email} from the organization`)
    else
      log.success(`${email} is now ${role}`)
    outro('Done ✅')
  }

  return { orgId, email, role, data }
}

export function inviteMemberInternal(orgId: string, options: OrganizationMemberOptions, silent = false) {
  return manageMemberInternal('invite', orgId, options, silent)
}

export function removeMemberInternal(orgId: string, options: OrganizationMemberOptions, silent = false) {
  return manageMemberInternal('remove', orgId, options, silent)
}

export function setMemberRoleInternal(orgId: string, options: OrganizationMemberOptions, silent = false) {
  return manageMemberInternal('role', orgId, options, silent)
}

export async function inviteMember(orgId: string, options: OrganizationMemberOptions) {
  await inviteMemberInternal(orgId, options)
}

export async function removeMember(orgId: string, options: OrganizationMemberOptions) {
  await removeMemberInternal(orgId, options)
}

export async function setMemberRole(orgId: string, options: OrganizationMemberOptions) {
  await setMemberRoleInternal(orgId, options)
}
