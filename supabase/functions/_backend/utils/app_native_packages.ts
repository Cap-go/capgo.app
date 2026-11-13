import type { Context } from 'hono'
import type { NativePackage } from './bundle_compatibility.ts'
import { CAPACITOR_CORE_PACKAGE, CAPGO_CLI_PACKAGE, filterInScopePackages, normalizePackageName } from './security_advisory_packages.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'

interface ReportedVersionsRow {
  native_packages: unknown
  cli_version: string | null
}

/** Build a package-to-version map from stored bundle metadata (blank versions become empty strings). */
export function toNativePackageMap(packages: NativePackage[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!packages?.length)
    return map
  for (const pkg of packages) {
    if (typeof pkg?.name !== 'string')
      continue
    const name = normalizePackageName(pkg.name)
    if (!name)
      continue
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
    const existing = map.get(name)
    if (existing !== undefined && existing !== '' && version === '')
      continue
    map.set(name, version)
  }
  return map
}

/** Surface core advisories as unknown when platform packages are reported without core (no version guess). */
export function ensureCapacitorCorePlaceholder(map: Map<string, string>): void {
  const coreKey = normalizePackageName(CAPACITOR_CORE_PACKAGE)
  if (map.has(coreKey))
    return
  const iosKey = normalizePackageName('@capacitor/ios')
  const androidKey = normalizePackageName('@capacitor/android')
  if (map.has(iosKey) || map.has(androidKey))
    map.set(coreKey, '')
}

function withCliVersion(map: Map<string, string>, cliVersion: string | null | undefined): Map<string, string> {
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  const trimmed = typeof cliVersion === 'string' ? cliVersion.trim() : ''
  map.set(cliKey, trimmed)
  return map
}

type ReportedVersionsClient = { query: (queryText: string, values?: unknown[]) => Promise<unknown> }

async function loadProductionChannelReportedOnClient(client: ReportedVersionsClient, appId: string): Promise<ReportedVersionsRow | null> {
  return await queryJsonOne<ReportedVersionsRow>(
    client,
    `SELECT av.native_packages, av.cli_version
       FROM public.channels ch
       INNER JOIN public.app_versions av ON av.id = ch.version
       WHERE ch.app_id = $1
         AND ch.name = 'production'
         AND ch.version IS NOT NULL
         AND COALESCE(av.deleted, false) = false
       LIMIT 1`,
    [appId],
  )
}

async function loadProductionChannelReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    return await loadProductionChannelReportedOnClient(pg, appId)
  }
  finally {
    closeClient(c, pg)
  }
}

async function loadLatestUploadReportedOnClient(client: ReportedVersionsClient, appId: string): Promise<ReportedVersionsRow | null> {
  const rows = await queryJson<ReportedVersionsRow>(
    client,
    `SELECT av.native_packages, av.cli_version
       FROM public.app_versions av
       WHERE av.app_id = $1
         AND COALESCE(av.deleted, false) = false
       ORDER BY av.id DESC
       LIMIT 1`,
    [appId],
  )
  return rows[0] ?? null
}

async function loadLatestUploadReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    return await loadLatestUploadReportedOnClient(pg, appId)
  }
  finally {
    closeClient(c, pg)
  }
}

export function buildReportedPackageMap(nativeRow: ReportedVersionsRow | null, latestRow: ReportedVersionsRow | null): Map<string, string> {
  const latest = latestRow
  const map = filterInScopePackages(
    toNativePackageMap(nativeRow?.native_packages as NativePackage[] | null | undefined),
  )
  const cliVersion = latest?.cli_version ?? nativeRow?.cli_version
  withCliVersion(map, cliVersion)
  ensureCapacitorCorePlaceholder(map)
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  if (!map.has(cliKey))
    map.set(cliKey, '')
  return map
}

export interface AppReportedPackagesRow {
  app_id: string
  has_production_channel: boolean
  production_native_packages: unknown
  production_cli_version: string | null
  has_latest_upload: boolean
  latest_native_packages: unknown
  latest_cli_version: string | null
}

const ALL_APPS_REPORTED_PACKAGES_SQL = `WITH production AS (
  SELECT DISTINCT ON (ch.app_id)
    ch.app_id,
    av.native_packages AS production_native_packages,
    av.cli_version AS production_cli_version
  FROM public.channels ch
  INNER JOIN public.app_versions av ON av.id = ch.version
  WHERE ch.name = 'production'
    AND ch.version IS NOT NULL
    AND COALESCE(av.deleted, false) = false
  ORDER BY ch.app_id, ch.id
),
latest AS (
  SELECT DISTINCT ON (av.app_id)
    av.app_id,
    av.native_packages AS latest_native_packages,
    av.cli_version AS latest_cli_version
  FROM public.app_versions av
  WHERE COALESCE(av.deleted, false) = false
  ORDER BY av.app_id, av.id DESC
)
SELECT
  a.app_id,
  (p.app_id IS NOT NULL) AS has_production_channel,
  p.production_native_packages,
  p.production_cli_version,
  (l.app_id IS NOT NULL) AS has_latest_upload,
  l.latest_native_packages,
  l.latest_cli_version
FROM public.apps a
LEFT JOIN production p ON p.app_id = a.app_id
LEFT JOIN latest l ON l.app_id = a.app_id`

/** Same production/latest row rules as loadAppReportedPackages, for one catalog SQL row. */
export function reportedPackageMapFromCatalogRow(row: AppReportedPackagesRow): Map<string, string> {
  const productionRow = row.has_production_channel
    ? { native_packages: row.production_native_packages, cli_version: row.production_cli_version }
    : null
  const latestRow = row.has_latest_upload
    ? { native_packages: row.latest_native_packages, cli_version: row.latest_cli_version }
    : null
  const nativeRow = productionRow ?? latestRow
  return buildReportedPackageMap(nativeRow, latestRow)
}

/** Reported in-scope packages for every app (one catalog query, same rules as loadAppReportedPackages). */
export async function loadAllAppsReportedPackages(client: ReportedVersionsClient): Promise<Map<string, Map<string, string>>> {
  const rows = await queryJson<AppReportedPackagesRow>(client, ALL_APPS_REPORTED_PACKAGES_SQL)
  const result = new Map<string, Map<string, string>>()
  for (const row of rows)
    result.set(row.app_id, reportedPackageMapFromCatalogRow(row))
  return result
}

/** Native and CLI versions already reported on bundles for this app (no new SDK fields). */
export async function loadAppReportedPackages(c: Context, appId: string): Promise<Map<string, string>> {
  const production = await loadProductionChannelReported(c, appId)
  const latest = await loadLatestUploadReported(c, appId)
  const nativeRow = production ?? latest
  return buildReportedPackageMap(nativeRow, latest)
}
