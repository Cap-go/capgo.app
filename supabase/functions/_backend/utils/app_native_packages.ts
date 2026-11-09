import type { Context } from 'hono'
import type { NativePackage } from './bundle_compatibility.ts'
import { canParse, compare, parse } from '@std/semver'
import { CAPGO_CLI_PACKAGE, CAPACITOR_CORE_PACKAGE, filterInScopePackages, normalizePackageName } from './security_advisory_packages.ts'
import { normalizeVersionString } from './security_advisory_version.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'

/** Omitted from CLI native_packages (non-native); still used for advisory matching. */
const CAPACITOR_CORE_INFER_EXCLUDE = new Set([
  '@capacitor/cli',
  '@capacitor/ios',
  '@capacitor/android',
  '@capacitor/assets',
  '@capacitor/synapse',
])

interface ReportedVersionsRow {
  native_packages: unknown
  cli_version: string | null
}

function toNativePackageMap(packages: NativePackage[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!packages?.length)
    return map
  for (const pkg of packages) {
    if (typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string')
      continue
    const name = normalizePackageName(pkg.name)
    if (!name)
      continue
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
    map.set(name, version)
  }
  return map
}

function withCliVersion(map: Map<string, string>, cliVersion: string | null | undefined): Map<string, string> {
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  const trimmed = typeof cliVersion === 'string' ? cliVersion.trim() : ''
  map.set(cliKey, trimmed)
  return map
}

async function loadProductionChannelReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    return await queryJsonOne<ReportedVersionsRow>(
      pg,
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
  finally {
    closeClient(c, pg)
  }
}

async function loadLatestUploadReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    const rows = await queryJson<ReportedVersionsRow>(
      pg,
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
  finally {
    closeClient(c, pg)
  }
}

/** Infer @capacitor/core from uploaded plugin versions when CLI metadata omits it. */
export function augmentInferredCapacitorCore(map: Map<string, string>): void {
  const coreKey = normalizePackageName(CAPACITOR_CORE_PACKAGE)
  if (map.has(coreKey))
    return

  for (const platform of ['@capacitor/ios', '@capacitor/android']) {
    const version = map.get(normalizePackageName(platform))?.trim()
    if (version) {
      map.set(coreKey, version)
      return
    }
  }

  let bestVersion: string | null = null
  let bestParsed: ReturnType<typeof parse> | null = null
  for (const [name, version] of map) {
    if (!name.startsWith('@capacitor/') || CAPACITOR_CORE_INFER_EXCLUDE.has(name))
      continue
    const normalized = normalizeVersionString(version)
    if (!normalized || !canParse(normalized))
      continue
    const parsed = parse(normalized)
    if (!bestParsed || compare(parsed, bestParsed) > 0) {
      bestParsed = parsed
      bestVersion = normalized
    }
  }
  if (bestVersion)
    map.set(coreKey, bestVersion)
}

function rowToPackageMap(row: ReportedVersionsRow | null): Map<string, string> {
  const map = toNativePackageMap(row?.native_packages as NativePackage[] | null | undefined)
  return withCliVersion(map, row?.cli_version)
}

/** Native and CLI versions already reported on bundles for this app (no new SDK fields). */
export async function loadAppReportedPackages(c: Context, appId: string): Promise<Map<string, string>> {
  const production = await loadProductionChannelReported(c, appId)
  const row = production ?? await loadLatestUploadReported(c, appId)
  const map = filterInScopePackages(rowToPackageMap(row))
  augmentInferredCapacitorCore(map)
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  if (!map.has(cliKey))
    map.set(cliKey, '')
  return map
}
