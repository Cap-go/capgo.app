import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { importBentoSubscriberProfile } from './bento.ts'
import { deliverPosthogEvent } from './posthog.ts'

type UserRow = Database['public']['Tables']['users']['Row']

export function userDisplayNameChanged(
  oldRecord: Pick<UserRow, 'first_name' | 'last_name'> | undefined,
  record: Pick<UserRow, 'first_name' | 'last_name'>,
) {
  if (!oldRecord)
    return false
  return oldRecord.first_name !== record.first_name || oldRecord.last_name !== record.last_name
}

function buildDisplayName(firstName: string | null, lastName: string | null) {
  return [firstName, lastName].map(part => part?.trim()).filter(Boolean).join(' ')
}

export async function syncUserDisplayNameIntegrations(
  c: Context,
  record: Pick<UserRow, 'id' | 'email' | 'first_name' | 'last_name'>,
) {
  const email = record.email?.trim()
  if (!email)
    return true

  const firstName = record.first_name?.trim() ?? ''
  const lastName = record.last_name?.trim() ?? ''
  const displayName = buildDisplayName(record.first_name, record.last_name)

  const posthogDelivery = await deliverPosthogEvent(c, {
    channel: 'user-profile',
    event: '$identify',
    personProperties: {
      ...(firstName ? { first_name: firstName } : {}),
      ...(lastName ? { last_name: lastName } : {}),
      ...(displayName ? { name: displayName } : {}),
      email,
    },
    user_id: record.id,
  })

  if (posthogDelivery.outcome === 'permanent_failure' && posthogDelivery.reason === 'not_configured')
    return true

  if (posthogDelivery.outcome !== 'delivered' && posthogDelivery.outcome !== 'quota_limited')
    return false

  const bentoOk = await importBentoSubscriberProfile(c, {
    email,
    first_name: firstName,
    last_name: lastName,
  })
  return bentoOk
}
