import type { ReadOnlyContext } from '../../contracts.ts'
import type { Product } from './evidence.ts'

// References are fixed SQL expressions from this module's callers, never input.
export function higherPrioritySiblingSql(org: string, product: string, priority: string): string {
  return `SELECT 1 FROM public.bento_lifecycle_journeys sibling
    LEFT JOIN public.bento_event_dispatches sibling_target ON sibling_target.flow_key = 'lifecycle:v2:org'
      AND sibling_target.context_key = sibling.org_id::text AND sibling_target.recipient_key = 'org:' || sibling.org_id::text
      AND sibling_target.tag = sibling.candidate->>'purpose'
    WHERE sibling.org_id = ${org} AND sibling.product <> ${product} AND sibling.candidate IS NOT NULL
      AND (sibling.candidate->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP
      AND sibling_target.status IS DISTINCT FROM 'accepted' AND COALESCE(sibling_target.attempt_count, 0) < 5
      AND ((sibling.candidate->>'priority')::int > ${priority}
        OR ((sibling.candidate->>'priority')::int = ${priority} AND sibling.product = 'ota'))`
}

export async function hasHigherPrioritySibling(read: ReadOnlyContext, orgId: string, product: Product, priority: number): Promise<boolean> {
  const rows = await read.query(`/* lifecycle sibling priority */ ${higherPrioritySiblingSql('$1::uuid', '$2::text', '$3::int')} LIMIT 1`, [orgId, product, priority])
  return rows.length > 0
}
