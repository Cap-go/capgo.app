import type { Context } from 'hono'
import type { Advisory, AdvisoryAffected } from '../../shared/security_advisory.ts'
import { loadAllAppsReportedPackages } from './app_native_packages.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJsonOne } from './pg_rls.ts'
import { loadSecurityAdvisoryBentoEmailStats } from './security_advisory_bento_stats.ts'
import { loadSecurityAdvisoryFeed } from './security_advisory_feed.ts'
import type { AppAdvisoryMatch } from './security_advisory_matching.ts'
import { matchAppPackagesToAdvisories } from './security_advisory_matching.ts'

export interface SecurityUpdatePatchRow {
  ghsa_id: string
  advisory_title: string
  severity: Advisory['severity']
  package: string
  affected_range: string
  patched_version: string | null
  created_at: string
}

export interface SecurityAdvisoryAdminRow {
  ghsa_id: string
  title: string
  severity: Advisory['severity']
  published_at: string
  packages: AdvisoryAffected[]
  email: Awaited<ReturnType<typeof loadSecurityAdvisoryBentoEmailStats>>
  adoption: AdvisoryAdoptionSummary
}

export interface SecurityUpdatesOptInSummary {
  users_opted_in: number
  orgs_opted_in: number
  apps_in_opted_in_orgs: number
}

export interface AdvisoryAdoptionSummary {
  apps_patched: number
  apps_vulnerable: number
  apps_unknown: number
  /** Apps with at least one in-scope package match for this advisory. */
  apps_relevant: number
}

export interface AdoptionScope {
  method: 'bundle_reported_packages'
  apps_total: number
  note: string
}

export interface AdminSecurityUpdatesTrackingResponse {
  generated_at: string
  feed_generated_at: string
  patches: SecurityUpdatePatchRow[]
  advisories: SecurityAdvisoryAdminRow[]
  opt_in: SecurityUpdatesOptInSummary
  adoption_by_advisory: Record<string, AdvisoryAdoptionSummary>
  adoption_scope: AdoptionScope
}

const OPT_IN_SUMMARY_SQL = `WITH opted_users AS (
        SELECT u.id
        FROM public.users u
        WHERE u.email_preferences @> '{"security_updates": true}'::jsonb
      ),
      opted_orgs AS (
        SELECT DISTINCT ou.org_id
        FROM public.org_users ou
        INNER JOIN opted_users oui ON oui.id = ou.user_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM opted_users) AS users_opted_in,
        (SELECT COUNT(*)::int FROM opted_orgs) AS orgs_opted_in,
        (
          SELECT COUNT(*)::int
          FROM public.apps a
          WHERE a.owner_org IN (SELECT org_id FROM opted_orgs)
        ) AS apps_in_opted_in_orgs`

export function flattenPatches(advisories: readonly Advisory[]): SecurityUpdatePatchRow[] {
  const rows: SecurityUpdatePatchRow[] = []
  for (const advisory of advisories) {
    for (const affected of advisory.affected) {
      rows.push({
        ghsa_id: advisory.ghsa_id,
        advisory_title: advisory.title,
        severity: advisory.severity,
        package: affected.package,
        affected_range: affected.affected_range,
        patched_version: affected.patched_version,
        created_at: advisory.published_at,
      })
    }
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

async function loadOptInSummary(c: Context) {
  const pg = await getPgClient(c)
  try {
    const row = await queryJsonOne<SecurityUpdatesOptInSummary>(pg, OPT_IN_SUMMARY_SQL)
    return row ?? { users_opted_in: 0, orgs_opted_in: 0, apps_in_opted_in_orgs: 0 }
  }
  finally {
    closeClient(c, pg)
  }
}

function worstAdoptionStatus(matches: readonly AppAdvisoryMatch[]): 'patched' | 'affected' | 'unknown' {
  if (matches.some(m => m.status === 'affected'))
    return 'affected'
  return matches.some(m => m.status === 'unknown') ? 'unknown' : 'patched'
}

export function summarizeAdoptionForAdvisory(
  advisory: Advisory,
  perAppPackages: Map<string, Map<string, string>>,
): AdvisoryAdoptionSummary {
  let appsPatched = 0
  let appsVulnerable = 0
  let appsUnknown = 0
  let appsRelevant = 0

  for (const packages of perAppPackages.values()) {
    const matches = matchAppPackagesToAdvisories(packages, [advisory])
    if (matches.length === 0)
      continue

    appsRelevant++

    const worst = worstAdoptionStatus(matches)

    if (worst === 'affected')
      appsVulnerable++
    else if (worst === 'patched')
      appsPatched++
    else
      appsUnknown++
  }

  return {
    apps_patched: appsPatched,
    apps_vulnerable: appsVulnerable,
    apps_unknown: appsUnknown,
    apps_relevant: appsRelevant,
  }
}

export async function buildAdminSecurityUpdatesTracking(
  c: Context,
): Promise<AdminSecurityUpdatesTrackingResponse> {
  const feed = await loadSecurityAdvisoryFeed(c)

  const pg = await getPgClient(c)
  let perAppPackages: Map<string, Map<string, string>>
  try {
    perAppPackages = await loadAllAppsReportedPackages(pg)
  }
  finally {
    closeClient(c, pg)
  }

  const optIn = await loadOptInSummary(c)

  const adoptionScope: AdoptionScope = {
    method: 'bundle_reported_packages',
    apps_total: perAppPackages.size,
    note: 'Adoption uses production channel bundle native_packages when set, else the latest upload, for every app. GHSA range checks run in the API, not in SQL.',
  }

  const adoptionByAdvisory: Record<string, AdvisoryAdoptionSummary> = {}
  const advisories: SecurityAdvisoryAdminRow[] = []

  for (const advisory of feed.advisories) {
    const [email, adoption] = await Promise.all([
      loadSecurityAdvisoryBentoEmailStats(c, advisory.ghsa_id),
      Promise.resolve(summarizeAdoptionForAdvisory(advisory, perAppPackages)),
    ])
    adoptionByAdvisory[advisory.ghsa_id] = adoption
    advisories.push({
      ghsa_id: advisory.ghsa_id,
      title: advisory.title,
      severity: advisory.severity,
      published_at: advisory.published_at,
      packages: advisory.affected,
      email,
      adoption,
    })
  }

  return {
    generated_at: new Date().toISOString(),
    feed_generated_at: feed.generated_at,
    patches: flattenPatches(feed.advisories),
    advisories,
    opt_in: optIn,
    adoption_by_advisory: adoptionByAdvisory,
    adoption_scope: adoptionScope,
  }
}
