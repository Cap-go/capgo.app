import type { PostHogQueueMessage } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import type { EligibleUser } from './contracts.ts'
import { flowAudit, safeFlowMetadata } from '../../supabase/functions/_backend/utils/bento_flow_audit.ts'
import { messageBytes, parsePostHogMessage, POSTHOG_MESSAGE_MAX_BYTES } from '../../supabase/functions/_backend/utils/posthog_queue.ts'

type AuditFactory = (properties: Record<string, unknown>) => PostHogQueueMessage

function isNativeCandidate(empty: PostHogQueueMessage, user: EligibleUser) {
  const probe = {
    ...empty,
    payload: { ...empty.payload, nonPersonTags: { ...empty.payload.nonPersonTags, eligible_users: [user] } },
  }
  return !!parsePostHogMessage(probe)
}

function fragmentLength(make: AuditFactory, serialized: string, offset: number, fragmentId: string) {
  let lo = 1
  let hi = serialized.length - offset
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const probe = make({ encoding: 'json-fragment', fragment_id: fragmentId, fragment_offset: offset, eligible_user_json: '' })
    probe.payload.nonPersonTags!.eligible_user_json = serialized.slice(offset, offset + mid)
    if (messageBytes(probe) <= POSTHOG_MESSAGE_MAX_BYTES)
      lo = mid
    else
      hi = mid - 1
  }
  // Keep a surrogate pair together across independently serialized messages.
  if (lo > 1 && /[\uD800-\uDBFF]/.test(serialized[offset + lo - 1]) && /[\uDC00-\uDFFF]/.test(serialized[offset + lo]))
    lo--
  return lo
}

function buildUserFragments(make: AuditFactory, serialized: string): PostHogQueueMessage[] {
  const fragmentId = crypto.randomUUID()
  const events: PostHogQueueMessage[] = []
  let offset = 0
  while (offset < serialized.length) {
    const length = fragmentLength(make, serialized, offset, fragmentId)
    events.push(make({ encoding: 'json-fragment', fragment_id: fragmentId, fragment_offset: offset, eligible_user_json: serialized.slice(offset, offset + length) }))
    offset += length
  }
  return events
}

export function buildEligibilityAudit(runId: string, evaluationKey: string, users: EligibleUser[]): PostHogQueueMessage[] {
  const safe = safeFlowMetadata(users) as EligibleUser[]
  const make: AuditFactory = properties => flowAudit('bento:evaluation_eligible', runId, { evaluation_key: evaluationKey, eligible_count: users.length, part: 999999999, parts: 999999999, ...properties })
  const events: PostHogQueueMessage[] = []
  const empty = make({ eligible_users: [] })
  const emptyBytes = messageBytes(empty)
  const encoder = new TextEncoder()
  let group: EligibleUser[] = []
  let groupBytes = emptyBytes
  for (const user of safe) {
    const serialized = JSON.stringify(user)
    const userBytes = encoder.encode(serialized).byteLength
    const native = isNativeCandidate(empty, user)
    const separatorBytes = group.length ? 1 : 0
    // The empty envelope already includes brackets. Add each serialized user
    // and its comma once; schema validity is independent of other recipients.
    if (native && groupBytes + separatorBytes + userBytes <= POSTHOG_MESSAGE_MAX_BYTES) {
      group.push(user)
      groupBytes += separatorBytes + userBytes
      continue
    }
    if (group.length) {
      events.push(make({ eligible_users: group }))
      group = []
      groupBytes = emptyBytes
    }
    if (native) {
      group.push(user)
      groupBytes += userBytes
      continue
    }
    // Preserve one recipient that is too large or too deep for native arrays.
    events.push(...buildUserFragments(make, serialized))
  }
  if (group.length || events.length === 0)
    events.push(make({ eligible_users: group }))
  for (const [index, event] of events.entries()) {
    event.payload.nonPersonTags!.part = index + 1
    event.payload.nonPersonTags!.parts = events.length
  }
  return events
}
