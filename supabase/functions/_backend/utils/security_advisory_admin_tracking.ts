import type { Context } from 'hono'
import type { Advisory, AdvisoryAffected } from '../../shared/security_advisory.ts'
import { loadAppReportedPackages } from './app_native_packages.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'
import { loadSecurityAdvisoryBentoEmailStats } from './security_advisory_bento_stats.ts'
import { loadSecurityAdvisoryFeed, SecurityAdvisoryFeedUnavailableError } from './security_advisory_feed.ts'
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
const ADOPTION_CONCURRENCY = 20

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

async function loadOptInSummary(c: Context): Promise<SecurityUpdatesOptInSummary> {
  const pg = await getPgClient(c)
  try {
    const row = await queryJsonOne<SecurityUpdatesOptInSummary>(
      pg,
      `WITH opted_users AS (
        SELECT u.id
        FROM public.users u
        WHERE COALESCE((u.email_preferences ->> 'security_updates')::boolean, false) = true
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
          WHERE COALESCE(a.deleted, false) = false
            AND a.owner_org IN (SELECT org_id FROM opted_orgs)
        ) AS apps_in_opted_in_orgs`,
    )
    return row ?? { users_opted_in: 0, orgs_opted_in: 0, apps_in_opted_in_orgs: 0 }
  }
  finally {
    closeClient(c, pg)
  }
}

async function loadAdoptionAppIds(c: Context): Promise<string[]> {
  const pg = await getPgClient(c)
  try {
    const rows = await queryJson<{ app_id: string }>(
      pg,
      `SELECT a.app_id
       FROM public.apps a
       WHERE COALESCE(a.deleted, false) = false
       ORDER BY a.stats_updated_at DESC NULLS LAST, a.app_id
       LIMIT $1`,
      [MAX_ADOPTION_APPS],
    )
    return rows.map(row => row.app_id)
  }
  finally {
    closeClient(c, pg)
  }
}

function summarizeAdoptionForAdvisory(
  advisory: Advisory,
  appIds: string[],
  perAppPackages: Map<string, Awaited<ReturnType<typeof loadAppReportedPackages>>>,
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await worker(items[current]!)
    }
  })
  await Promise.all(runners)
  return results
}

export async function buildAdminSecurityUpdatesTracking(
  c: Context,
): Promise<AdminSecurityUpdatesTrackingResponse> {
  let feed
  try {
    feed = await loadSecurityAdvisoryFeed(c)
  }
  catch (error) {
    if (error instanceof SecurityAdvisoryFeedUnavailableError)
      throw error
    throw error
  }

  const [optIn, appIds] = await Promise.all([
    loadOptInSummary(c),
    loadAdoptionAppIds(c),
  ])

  const perAppPackages = new Map<string, Awaited<ReturnType<typeof loadAppReportedPackages>>>()
  await mapWithConcurrency(appIds, ADOPTION_CONCURRENCY, async (appId) => {
    perAppPackages.set(appId, await loadAppReportedPackages(c, appId))
  })

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
