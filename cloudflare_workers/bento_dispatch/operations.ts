import type { DispatchJob, InvitationDetails } from './contracts.ts'

import { escapeHtml } from '../api/email_templates/render.ts'

export const INVITATION_OPERATIONS = [
  'org:invite_new_user_reminder_1',
  'org:invite_new_user_reminder_2',
  'org:invite_existing_user_reminder_1',
  'org:invite_existing_user_reminder_2',
] as const

export function parseDispatchJob(body: unknown, registry: Readonly<Record<string, unknown>> = Object.fromEntries(INVITATION_OPERATIONS.map(key => [key, true]))): DispatchJob {
  const value = body as Partial<DispatchJob> | null
  if (!value || Array.isArray(value) || Object.keys(value).sort((left, right) => left.localeCompare(right)).join(',') !== 'evaluationKey,runId,version'
    || value.version !== 1 || typeof value.evaluationKey !== 'string' || !Object.hasOwn(registry, value.evaluationKey)
    || typeof value.runId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.runId)) {
    throw new Error('Invalid dispatch job')
  }
  return value as DispatchJob
}

export function buildInvitationEvent(record: { id: string, tag: string }, invitation: InvitationDetails, webappUrl: string) {
  let url: URL
  try {
    url = new URL(webappUrl)
  }
  catch {
    throw new Error('Invalid webapp URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Invalid webapp URL')
  if (invitation.is_new_user && !invitation.invite_magic_string)
    throw new Error('Missing invitation token')
  const inviteLink = invitation.is_new_user
    ? `${url.origin}/invitation?invite_magic_string=${encodeURIComponent(invitation.invite_magic_string!)}`
    : `${url.origin}/dashboard?invite_org=${encodeURIComponent(invitation.org_id)}`

  return {
    email: invitation.email,
    event: record.tag,
    data: {
      dispatch_id: record.id,
      unique: { key: record.id },
      org_id: invitation.org_id,
      org_name: escapeHtml(invitation.org_name),
      org_name_subject: invitation.org_name.replace(/[\r\n]+/g, ' '),
      org_admin_name: escapeHtml(invitation.org_admin_name),
      invited_first_name: escapeHtml(invitation.first_name?.trim() || invitation.email.split('@')[0]),
      invited_last_name: escapeHtml(invitation.last_name?.trim() || ''),
      invite_link: inviteLink,
    },
  }
}
