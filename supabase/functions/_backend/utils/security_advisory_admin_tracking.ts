import type { Context } from 'hono'
import type { Advisory, AdvisoryAffected } from '../../shared/security_advisory.ts'
import type { PgClient } from './pg.ts'
import { loadAppReportedPackagesOnClient } from './app_native_packages.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'
import { loadSecurityAdvisoryBentoEmailStats } from './security_advisory_bento_stats.ts'
import { loadSecurityAdvisoryFeed } from './security_advisory_feed.ts'
import { matchAppPackagesToAdvisories, resolveAdvisoryStatus } from './security_advisory_matching.ts'

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
  apps_considered: number
}

export interface AdminSecurityUpdatesTrackingResponse {
  generated_at: string
  feed_generated_at: string
  patches: SecurityUpdatePatchRow[]
  advisories: SecurityAdvisoryAdminRow[]
  opt_in: SecurityUpdatesOptInSummary
  adoption_by_advisory: Record<string, AdvisoryAdoptionSummary>
}

const MAX_ADOPTION_APPS = 500

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

function flattenPatches(advisories: readonly Advisory[]): SecurityUpdatePatchRow[] {
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

async function loadOptInSummaryAndAppIds(client: PgClient): Promise<{
  optIn: SecurityUpdatesOptInSummary
  appIds: string[]
}> {
  const optInRow = await queryJsonOne<SecurityUpdatesOptInSummary>(client, OPT_IN_SUMMARY_SQL)
  const optIn = optInRow ?? { users_opted_in: 0, orgs_opted_in: 0, apps_in_opted_in_orgs: 0 }
  const appRows = await queryJson<{ app_id: string }>(
    client,
    `SELECT a.app_id
       FROM public.apps a
       ORDER BY a.updated_at DESC NULLS LAST, a.app_id
       LIMIT $1`,
    [MAX_ADOPTION_APPS],
  )
  return { optIn, appIds: appRows.map(row => row.app_id) }
}

async function loadReportedPackagesForApps(
  client: PgClient,
  appIds: string[],
): Promise<Map<string, Awaited<ReturnType<typeof loadAppReportedPackagesOnClient>>>> {
  const perAppPackages = new Map<string, Awaited<ReturnType<typeof loadAppReportedPackagesOnClient>>>()
  for (const appId of appIds) {
    try {
      perAppPackages.set(appId, await loadAppReportedPackagesOnClient(client, appId))
    }
    catch {
      perAppPackages.set(appId, new Map())
    }
  }
  return perAppPackages
}

function summarizeAdoptionForAdvisory(
  advisory: Advisory,
  appIds: string[],
  perAppPackages: Map<string, Awaited<ReturnType<typeof loadAppReportedPackagesOnClient>>>,
): AdvisoryAdoptionSummary {
  let appsPatched = 0
  let appsVulnerable = 0
  let appsUnknown = 0

  for (const appId of appIds) {
    const packages = perAppPackages.get(appId)
    if (!packages)
      continue

    const matches = matchAppPackagesToAdvisories(packages, [advisory])
    if (matches.length === 0)
      continue

    let worst: 'patched' | 'affected' | 'unknown' = 'patched'
    for (const match of matches) {
      const status = resolveAdvisoryStatus(match.current_version, match.affected)
      if (status === 'affected') {
        worst = 'affected'
        break
      }
      if (status === 'unknown' && worst === 'patched')
        worst = 'unknown'
    }

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
    apps_considered: appIds.length,
  }
}

export async function buildAdminSecurityUpdatesTracking(
  c: Context,
): Promise<AdminSecurityUpdatesTrackingResponse> {
  const feed = await loadSecurityAdvisoryFeed(c)

  const pg = await getPgClient(c)
  let optIn: SecurityUpdatesOptInSummary
  let appIds: string[]
  let perAppPackages: Map<string, Awaited<ReturnType<typeof loadAppReportedPackagesOnClient>>>
  try {
    const loaded = await loadOptInSummaryAndAppIds(pg)
    optIn = loaded.optIn
    appIds = loaded.appIds
    perAppPackages = await loadReportedPackagesForApps(pg, appIds)
  }
  finally {
    closeClient(c, pg)
  }

  const adoptionByAdvisory: Record<string, AdvisoryAdoptionSummary> = {}
  const advisories: SecurityAdvisoryAdminRow[] = []

  for (const advisory of feed.advisories) {
    const [email, adoption] = await Promise.all([
      loadSecurityAdvisoryBentoEmailStats(c, advisory.ghsa_id),
      Promise.resolve(summarizeAdoptionForAdvisory(advisory, appIds, perAppPackages)),
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
  }
}
