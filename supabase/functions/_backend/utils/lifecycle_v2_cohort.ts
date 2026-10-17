import rawConfig from './ab_tests.json' with { type: 'json' }

interface Assignment { branch?: unknown, assigned_at?: unknown }
interface Enrollment { intent?: unknown, abtests?: Record<string, Assignment>, abtests_enrolled?: unknown }

export function validLifecycleTreatment(value: unknown): value is { branch: 'A', assigned_at: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const assignment = value as Assignment
  return assignment.branch === 'A' && typeof assignment.assigned_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(assignment.assigned_at)
    && Number.isFinite(Date.parse(assignment.assigned_at))
}

// PR1 owns allocation and protects these stored fields from user writes. This
// reader never allocates or backfills. Missing dependency configuration closes
// both lifecycle dispatch and its matching legacy suppression.
export function isLifecycleV2Creator(onboarding: unknown, createdAt: string | Date | null, createdViaInvite: unknown): boolean {
  const config = (rawConfig as Record<string, unknown>).new_emails_v2 as { audience?: unknown, enroll_new_users_after?: string } | undefined
  const cutoff = Date.parse(config?.enroll_new_users_after ?? '')
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt ?? '')
  // Signup provenance belongs to the original creator's persisted user row.
  // A stale treatment, invited membership or missing provenance cannot enroll.
  if (config?.audience !== 'self_signup' || createdViaInvite !== false
    || !Number.isFinite(cutoff) || !Number.isFinite(created) || created < cutoff
    || !onboarding || typeof onboarding !== 'object' || Array.isArray(onboarding)) {
    return false
  }
  const profile = onboarding as Enrollment
  if (!Array.isArray(profile.abtests_enrolled) || !profile.abtests_enrolled.includes('new_emails_v2')
    || (profile.intent !== 'ota' && profile.intent !== 'builder')) {
    return false
  }
  const assignment = profile.abtests?.new_emails_v2
  if (!validLifecycleTreatment(assignment) || Date.parse(assignment.assigned_at) < created)
    return false
  return profile.intent === 'ota' || validLifecycleTreatment(profile.abtests?.builder_todo_list_v4)
}
