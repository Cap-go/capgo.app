/*
 * Migrate legacy root-level image object keys (no `/`) to ownership-bearing paths.
 *
 * Targets:
 *   apps.icon_url  → org/{owner_org}/{app_id}/icon
 *   orgs.logo      → org/{id}/logo/{originalBareName}
 *   users.image_url → {user_id}/{originalBareName}
 *
 * Known placeholder bare names (capgo.png, …) are cleared to '' (no storage copy).
 *
 * Dry run:
 *   bun run admin:migrate-legacy-bare-image-paths
 *
 * Apply:
 *   bun run admin:migrate-legacy-bare-image-paths --apply
 *
 * Optional:
 *   bun run admin:migrate-legacy-bare-image-paths --apply --limit=100
 *   bun run admin:migrate-legacy-bare-image-paths --apply --delete-source
 *   bun run admin:migrate-legacy-bare-image-paths --apply --env-file=./internal/cloudflare/.env.preprod
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  asyncPool,
  createSupabaseServiceClient,
  DEFAULT_ENV_FILE,
  getArgValue,
  loadEnv,
  parsePositiveInteger,
} from './admin_stripe_backfill_utils.ts'

const DEFAULT_CONCURRENCY = 4
const DEFAULT_PAGE_SIZE = 1000
const FAILURE_OUTPUT = './tmp/legacy_bare_image_path_failures.json'
const RESULT_OUTPUT = './tmp/legacy_bare_image_path_results.json'

/** Shared default icons historically stored as bare names — clear, do not copy. */
const PLACEHOLDER_BARE_NAMES = new Set([
  'capgo.png',
  '/capgo.png',
])

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>

type Kind = 'app_icon' | 'org_logo' | 'user_avatar'

interface LegacyRow {
  kind: Kind
  id: string
  ownerKey: string
  sourcePath: string
  targetPath: string | null
  action: 'copy' | 'clear'
}

interface MigrateResult {
  kind: Kind
  id: string
  sourcePath: string
  targetPath: string | null
  status: 'dry_run' | 'updated' | 'cleared' | 'already_migrated'
  deletedSource: boolean
}

interface MigrateFailure {
  kind: Kind
  id: string
  sourcePath: string
  error: string
}

function printHelp() {
  console.log(`Migrate legacy bare image paths to ownership-bearing keys.

Usage:
  bun run admin:migrate-legacy-bare-image-paths [options]

Options:
  --apply             Copy objects / update DB. Without this, dry-run only.
  --delete-source     After a successful copy+update, remove the bare object
                      when no remaining DB row still references it.
  --limit=N           Process at most N legacy rows (apps+orgs+users combined).
  --concurrency=N     Copy/update concurrency. Default: ${DEFAULT_CONCURRENCY}.
  --env-file=PATH     Env file to load. Default: ${DEFAULT_ENV_FILE}.
  --help              Show this help.

Required env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
`)
}

function normalizeStoredPath(raw: string | null | undefined) {
  if (!raw)
    return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('://'))
    return ''
  return trimmed.replace(/^images\//, '').replace(/^\/+/, '')
}

/** Root-level object key with no folder segment. */
function isLegacyBarePath(normalized: string) {
  return !!normalized && !normalized.includes('/')
}

function targetForApp(ownerOrg: string, appId: string) {
  return `org/${ownerOrg}/${appId}/icon`
}

function targetForOrgLogo(orgId: string, bareName: string) {
  const safe = bareName.replace(/[^\w.\-]+/g, '_')
  return `org/${orgId}/logo/${safe || 'logo'}`
}

function targetForUser(userId: string, bareName: string) {
  const safe = bareName.replace(/[^\w.\-]+/g, '_')
  return `${userId}/${safe || 'avatar'}`
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function listLegacyApps(supabase: SupabaseClient, limit: number | null) {
  const rows: LegacyRow[] = []
  let from = 0
  while (limit === null || rows.length < limit) {
    const pageSize = limit === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, limit - rows.length)
    // Bare keys only: no `/`, not absolute URLs.
    const { data, error } = await supabase
      .from('apps')
      .select('app_id, owner_org, icon_url')
      .not('icon_url', 'is', null)
      .neq('icon_url', '')
      .not('icon_url', 'like', '%/%')
      .not('icon_url', 'like', '%://%')
      .range(from, from + pageSize - 1)
      .order('app_id', { ascending: true })

    if (error)
      throw error
    if (!data?.length)
      break

    for (const app of data) {
      const sourcePath = normalizeStoredPath(app.icon_url)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = PLACEHOLDER_BARE_NAMES.has(sourcePath) || PLACEHOLDER_BARE_NAMES.has(app.icon_url?.trim() ?? '')
      rows.push({
        kind: 'app_icon',
        id: app.app_id,
        ownerKey: app.owner_org,
        sourcePath,
        targetPath: clear ? null : targetForApp(app.owner_org, app.app_id),
        action: clear ? 'clear' : 'copy',
      })
      if (limit !== null && rows.length >= limit)
        break
    }

    if (data.length < pageSize)
      break
    from += pageSize
  }
  return rows
}

async function listLegacyOrgs(supabase: SupabaseClient, remaining: number | null) {
  const rows: LegacyRow[] = []
  if (remaining !== null && remaining <= 0)
    return rows

  let from = 0
  while (remaining === null || rows.length < remaining) {
    const pageSize = remaining === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, remaining - rows.length)
    const { data, error } = await supabase
      .from('orgs')
      .select('id, logo')
      .not('logo', 'is', null)
      .neq('logo', '')
      .not('logo', 'like', '%/%')
      .not('logo', 'like', '%://%')
      .range(from, from + pageSize - 1)
      .order('id', { ascending: true })

    if (error)
      throw error
    if (!data?.length)
      break

    for (const org of data) {
      const sourcePath = normalizeStoredPath(org.logo)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = PLACEHOLDER_BARE_NAMES.has(sourcePath)
      rows.push({
        kind: 'org_logo',
        id: org.id,
        ownerKey: org.id,
        sourcePath,
        targetPath: clear ? null : targetForOrgLogo(org.id, sourcePath),
        action: clear ? 'clear' : 'copy',
      })
      if (remaining !== null && rows.length >= remaining)
        break
    }

    if (data.length < pageSize)
      break
    from += pageSize
  }
  return rows
}

async function listLegacyUsers(supabase: SupabaseClient, remaining: number | null) {
  const rows: LegacyRow[] = []
  if (remaining !== null && remaining <= 0)
    return rows

  let from = 0
  while (remaining === null || rows.length < remaining) {
    const pageSize = remaining === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, remaining - rows.length)
    const { data, error } = await supabase
      .from('users')
      .select('id, image_url')
      .not('image_url', 'is', null)
      .neq('image_url', '')
      .not('image_url', 'like', '%/%')
      .not('image_url', 'like', '%://%')
      .range(from, from + pageSize - 1)
      .order('id', { ascending: true })

    if (error)
      throw error
    if (!data?.length)
      break

    for (const user of data) {
      const sourcePath = normalizeStoredPath(user.image_url)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = PLACEHOLDER_BARE_NAMES.has(sourcePath)
      rows.push({
        kind: 'user_avatar',
        id: user.id,
        ownerKey: user.id,
        sourcePath,
        targetPath: clear ? null : targetForUser(user.id, sourcePath),
        action: clear ? 'clear' : 'copy',
      })
      if (remaining !== null && rows.length >= remaining)
        break
    }

    if (data.length < pageSize)
      break
    from += pageSize
  }
  return rows
}

async function storageObjectExists(supabase: SupabaseClient, path: string) {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const { data, error } = await supabase.storage.from('images').list(parent, {
    limit: 100,
    search: name,
  })
  if (error)
    throw error
  return (data ?? []).some(entry => entry.name === name)
}

async function copyObject(supabase: SupabaseClient, fromPath: string, toPath: string) {
  if (fromPath === toPath)
    return
  const existsTarget = await storageObjectExists(supabase, toPath)
  if (existsTarget)
    return

  const { error } = await supabase.storage.from('images').copy(fromPath, toPath)
  if (error) {
    // Race / already exists
    if (/already exists|duplicate|409/i.test(error.message))
      return
    throw error
  }
}

async function countBareReferences(supabase: SupabaseClient, barePath: string) {
  const [apps, orgs, users] = await Promise.all([
    supabase.from('apps').select('app_id', { count: 'exact', head: true }).eq('icon_url', barePath),
    supabase.from('orgs').select('id', { count: 'exact', head: true }).eq('logo', barePath),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('image_url', barePath),
  ])
  if (apps.error)
    throw apps.error
  if (orgs.error)
    throw orgs.error
  if (users.error)
    throw users.error
  return (apps.count ?? 0) + (orgs.count ?? 0) + (users.count ?? 0)
}

async function updateRow(supabase: SupabaseClient, row: LegacyRow, newValue: string) {
  if (row.kind === 'app_icon') {
    const { data, error } = await supabase
      .from('apps')
      .update({ icon_url: newValue })
      .eq('app_id', row.id)
      .eq('icon_url', row.sourcePath)
      .select('app_id')
    if (error)
      throw error
    return (data?.length ?? 0) > 0
  }
  if (row.kind === 'org_logo') {
    const { data, error } = await supabase
      .from('orgs')
      .update({ logo: newValue })
      .eq('id', row.id)
      .eq('logo', row.sourcePath)
      .select('id')
    if (error)
      throw error
    return (data?.length ?? 0) > 0
  }
  const { data, error } = await supabase
    .from('users')
    .update({ image_url: newValue })
    .eq('id', row.id)
    .eq('image_url', row.sourcePath)
    .select('id')
  if (error)
    throw error
  return (data?.length ?? 0) > 0
}

async function processRow(
  supabase: SupabaseClient,
  row: LegacyRow,
  apply: boolean,
  deleteSource: boolean,
): Promise<MigrateResult> {
  if (row.action === 'clear') {
    if (!apply) {
      return {
        kind: row.kind,
        id: row.id,
        sourcePath: row.sourcePath,
        targetPath: null,
        status: 'dry_run',
        deletedSource: false,
      }
    }
    const updated = await updateRow(supabase, row, '')
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: null,
      status: updated ? 'cleared' : 'already_migrated',
      deletedSource: false,
    }
  }

  const targetPath = row.targetPath
  if (!targetPath)
    throw new Error('Missing target path for copy action')

  if (!apply) {
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath,
      status: 'dry_run',
      deletedSource: false,
    }
  }

  const sourceExists = await storageObjectExists(supabase, row.sourcePath)
  if (!sourceExists) {
    // Object already gone — clear broken pointer so it is not a bare legacy ref.
    const updated = await updateRow(supabase, row, '')
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: null,
      status: updated ? 'cleared' : 'already_migrated',
      deletedSource: false,
    }
  }

  await copyObject(supabase, row.sourcePath, targetPath)
  const updated = await updateRow(supabase, row, targetPath)
  if (!updated) {
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath,
      status: 'already_migrated',
      deletedSource: false,
    }
  }

  let deletedSource = false
  if (deleteSource) {
    const refs = await countBareReferences(supabase, row.sourcePath)
    if (refs === 0) {
      const { error } = await supabase.storage.from('images').remove([row.sourcePath])
      if (error)
        throw error
      deletedSource = true
    }
  }

  return {
    kind: row.kind,
    id: row.id,
    sourcePath: row.sourcePath,
    targetPath,
    status: 'updated',
    deletedSource,
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const apply = args.includes('--apply')
  const deleteSource = args.includes('--delete-source')
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE
  const concurrency = parsePositiveInteger(getArgValue(args, '--concurrency'), 'concurrency', DEFAULT_CONCURRENCY)
  const limitRaw = getArgValue(args, '--limit')
  const limit = limitRaw ? parsePositiveInteger(limitRaw, 'limit', 0) : null
  if (limit === 0)
    throw new Error('--limit must be > 0')

  const fileEnv = await loadEnv(envFile)
  const env = { ...fileEnv, ...process.env }
  const supabase = createSupabaseServiceClient(env)

  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN')
  console.log(`Env file: ${envFile}`)
  console.log(`Concurrency: ${concurrency}`)
  if (limit !== null)
    console.log(`Limit: ${limit}`)
  if (deleteSource)
    console.log('Delete source: yes (when unreferenced)')

  const appRows = await listLegacyApps(supabase, limit)
  const remainingAfterApps = limit === null ? null : Math.max(0, limit - appRows.length)
  const orgRows = await listLegacyOrgs(supabase, remainingAfterApps)
  const remainingAfterOrgs = remainingAfterApps === null
    ? null
    : Math.max(0, remainingAfterApps - orgRows.length)
  const userRows = await listLegacyUsers(supabase, remainingAfterOrgs)

  const allRows = [...appRows, ...orgRows, ...userRows]
  console.log(`Found legacy bare paths: apps=${appRows.length} orgs=${orgRows.length} users=${userRows.length} total=${allRows.length}`)

  const results: MigrateResult[] = []
  const failures: MigrateFailure[] = []

  await asyncPool(concurrency, allRows, async (row) => {
    try {
      const result = await processRow(supabase, row, apply, deleteSource)
      results.push(result)
      console.log(`[${result.status}] ${row.kind} ${row.id}: ${row.sourcePath} → ${result.targetPath ?? '(cleared)'}`)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({
        kind: row.kind,
        id: row.id,
        sourcePath: row.sourcePath,
        error: message,
      })
      console.error(`[fail] ${row.kind} ${row.id}: ${message}`)
    }
  })

  await writeJson(RESULT_OUTPUT, results)
  await writeJson(FAILURE_OUTPUT, failures)

  console.log(`Done. results=${results.length} failures=${failures.length}`)
  console.log(`Wrote ${RESULT_OUTPUT}`)
  console.log(`Wrote ${FAILURE_OUTPUT}`)

  if (failures.length > 0)
    process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
