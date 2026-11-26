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
import type pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import type { ImageStore } from './admin_image_storage.ts'
import { dirname } from 'node:path'
import { createImageStore } from './admin_image_storage.ts'
import {
  asyncPool,
  connectAdminDb,
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

// Images are stored in R2 (S3_* env vars), not Supabase Storage.
let images: ImageStore

type Kind = 'app_icon' | 'org_logo' | 'user_avatar'

interface LegacyRow {
  kind: Kind
  id: string
  ownerKey: string
  /** Exact DB column value for compare-and-set updates. */
  rawValue: string
  /** Normalized storage object key (no leading slash / images/ prefix). */
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
  MAIN_SUPABASE_DB_URL (or DATABASE_URL, SUPABASE_DB_URL, SUPABASE_DB_DIRECT_URL)
`)
}

function normalizeStoredPath(raw: string | null | undefined) {
  if (!raw)
    return ''
  const trimmed = raw.trim()
  if (!trimmed)
    return ''
  if (trimmed.includes('://')) {
    // Absolute storage URLs may still point at a bare object key.
    try {
      const url = new URL(trimmed)
      const match = url.pathname.match(/\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/([^/?#]+)$/i)
      if (match?.[1] && !match[1].includes('%2F') && !decodeURIComponent(match[1]).includes('/'))
        return decodeURIComponent(match[1])
    }
    catch {
      // ignore
    }
    return ''
  }
  // Strip leading slashes before images/ so `/images/foo` → `foo`.
  return trimmed.replace(/^\/+/, '').replace(/^images\//, '').replace(/^\/+/, '')
}

/** Root-level object key with no folder segment. */
function isLegacyBarePath(normalized: string) {
  return !!normalized && !normalized.includes('/')
}

function isPlaceholderBare(rawValue: string, sourcePath: string) {
  const trimmed = rawValue.trim()
  return PLACEHOLDER_BARE_NAMES.has(sourcePath)
    || PLACEHOLDER_BARE_NAMES.has(trimmed)
    || PLACEHOLDER_BARE_NAMES.has(`/${sourcePath}`)
}

/**
 * SQL prefilter: bare names, leading-slash bare names, or images/<bare>.
 * Client still applies normalizeStoredPath + isLegacyBarePath.
 * `column` is one of this file's constant column names, never user input.
 */
function legacyImageColumnFilter(column: string) {
  return `${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE '%://%'
    AND (${column} NOT LIKE '%/%'
      OR (${column} LIKE '/%' AND ${column} NOT LIKE '/%/%')
      OR (${column} LIKE 'images/%' AND ${column} NOT LIKE 'images/%/%')
      OR (${column} LIKE '/images/%' AND ${column} NOT LIKE '/images/%/%'))`
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

async function listLegacyApps(db: pg.Pool, limit: number | null) {
  const rows: LegacyRow[] = []
  let from = 0
  while (limit === null || rows.length < limit) {
    const pageSize = limit === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, limit - rows.length)
    const { rows: data } = await db.query(
      `SELECT app_id, owner_org, icon_url FROM public.apps
       WHERE ${legacyImageColumnFilter('icon_url')}
       ORDER BY app_id ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, from],
    )
    if (!data.length)
      break

    for (const app of data) {
      const rawValue = app.icon_url ?? ''
      const sourcePath = normalizeStoredPath(rawValue)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = isPlaceholderBare(rawValue, sourcePath)
      rows.push({
        kind: 'app_icon',
        id: app.app_id,
        ownerKey: app.owner_org,
        rawValue,
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

async function listLegacyOrgs(db: pg.Pool, remaining: number | null) {
  const rows: LegacyRow[] = []
  if (remaining !== null && remaining <= 0)
    return rows

  let from = 0
  while (remaining === null || rows.length < remaining) {
    const pageSize = remaining === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, remaining - rows.length)
    const { rows: data } = await db.query(
      `SELECT id, logo FROM public.orgs
       WHERE ${legacyImageColumnFilter('logo')}
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, from],
    )
    if (!data.length)
      break

    for (const org of data) {
      const rawValue = org.logo ?? ''
      const sourcePath = normalizeStoredPath(rawValue)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = isPlaceholderBare(rawValue, sourcePath)
      rows.push({
        kind: 'org_logo',
        id: org.id,
        ownerKey: org.id,
        rawValue,
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

async function listLegacyUsers(db: pg.Pool, remaining: number | null) {
  const rows: LegacyRow[] = []
  if (remaining !== null && remaining <= 0)
    return rows

  let from = 0
  while (remaining === null || rows.length < remaining) {
    const pageSize = remaining === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, remaining - rows.length)
    const { rows: data } = await db.query(
      `SELECT id, image_url FROM public.users
       WHERE ${legacyImageColumnFilter('image_url')}
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, from],
    )
    if (!data.length)
      break

    for (const user of data) {
      const rawValue = user.image_url ?? ''
      const sourcePath = normalizeStoredPath(rawValue)
      if (!isLegacyBarePath(sourcePath))
        continue
      const clear = isPlaceholderBare(rawValue, sourcePath)
      rows.push({
        kind: 'user_avatar',
        id: user.id,
        ownerKey: user.id,
        rawValue,
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

async function storageObjectExists(db: pg.Pool, path: string) {
  if (await images.exists(path))
    return true
  // Images live in R2 now. One still only in Supabase was not migrated yet:
  // fail the row instead of letting the caller clear its database pointer.
  const { rowCount } = await db.query(
    `SELECT 1 FROM storage.objects WHERE bucket_id = 'images' AND name = $1`,
    [path],
  )
  if (rowCount)
    throw new Error(`"${path}" exists only in Supabase Storage. Run admin:migrate-supabase-images-to-r2 first.`)
  return false
}

async function copyObject(
  _db: pg.Pool,
  fromPath: string,
  toPath: string,
  options?: { force?: boolean },
) {
  if (fromPath === toPath)
    return
  const existsTarget = await images.exists(toPath)
  if (existsTarget && !options?.force)
    return
  // Copy overwrites the target in place; never remove-then-copy so a failed copy cannot destroy it.
  await images.copy(fromPath, toPath)
}

/**
 * One-shot scan: normalized bare path → how many DB rows still reference it.
 * Keyset pagination (ordered by PK) so concurrent writes cannot skip pages.
 * Includes padded/alias spellings and absolute storage URLs that normalize to a bare key.
 */
async function buildBareReferenceIndex(db: pg.Pool): Promise<Map<string, number>> {
  const counts = new Map<string, number>()

  async function scanTable(
    table: 'apps' | 'orgs' | 'users',
    column: string,
    idColumn: string,
  ) {
    let lastId: string | null = null
    while (true) {
      const { rows: data } = await db.query(
        `SELECT ${idColumn}, ${column} FROM public.${table}
         WHERE ${legacyImageColumnFilter(column)}${lastId ? ` AND ${idColumn} > $2` : ''}
         ORDER BY ${idColumn} ASC
         LIMIT $1`,
        lastId ? [DEFAULT_PAGE_SIZE, lastId] : [DEFAULT_PAGE_SIZE],
      )
      if (!data.length)
        break

      for (const row of data as Record<string, unknown>[]) {
        lastId = String(row[idColumn] ?? '')
        const path = normalizeStoredPath(String(row[column] ?? ''))
        if (!isLegacyBarePath(path))
          continue
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }

      if (data.length < DEFAULT_PAGE_SIZE)
        break
    }
  }

  // Absolute storage URLs are excluded by the legacy filter; scan them separately.
  async function scanStorageUrlBareRefs(
    table: 'apps' | 'orgs' | 'users',
    column: string,
    idColumn: string,
  ) {
    let lastId: string | null = null
    while (true) {
      const { rows: data } = await db.query(
        `SELECT ${idColumn}, ${column} FROM public.${table}
         WHERE ${column} IS NOT NULL AND ${column} LIKE '%://%' AND ${column} LIKE '%/images/%'${lastId ? ` AND ${idColumn} > $2` : ''}
         ORDER BY ${idColumn} ASC
         LIMIT $1`,
        lastId ? [DEFAULT_PAGE_SIZE, lastId] : [DEFAULT_PAGE_SIZE],
      )
      if (!data.length)
        break

      for (const row of data as Record<string, unknown>[]) {
        lastId = String(row[idColumn] ?? '')
        const path = normalizeStoredPath(String(row[column] ?? ''))
        if (!isLegacyBarePath(path))
          continue
        counts.set(path, (counts.get(path) ?? 0) + 1)
      }

      if (data.length < DEFAULT_PAGE_SIZE)
        break
    }
  }

  await scanTable('apps', 'icon_url', 'app_id')
  await scanTable('orgs', 'logo', 'id')
  await scanTable('users', 'image_url', 'id')
  await scanStorageUrlBareRefs('apps', 'icon_url', 'app_id')
  await scanStorageUrlBareRefs('orgs', 'logo', 'id')
  await scanStorageUrlBareRefs('users', 'image_url', 'id')
  return counts
}

/** Synchronously consume one DB reference after a successful migrate/clear. */
function consumeBareReference(index: Map<string, number>, normalizedBarePath: string) {
  const next = Math.max(0, (index.get(normalizedBarePath) ?? 0) - 1)
  index.set(normalizedBarePath, next)
  return next
}

async function updateRow(db: pg.Pool, row: LegacyRow, newValue: string) {
  if (row.kind === 'app_icon') {
    const { rowCount } = await db.query(
      'UPDATE public.apps SET icon_url = $1 WHERE app_id = $2 AND owner_org = $3 AND icon_url = $4',
      [newValue, row.id, row.ownerKey, row.rawValue],
    )
    return (rowCount ?? 0) > 0
  }
  if (row.kind === 'org_logo') {
    const { rowCount } = await db.query(
      'UPDATE public.orgs SET logo = $1 WHERE id = $2 AND logo = $3',
      [newValue, row.id, row.rawValue],
    )
    return (rowCount ?? 0) > 0
  }
  const { rowCount } = await db.query(
    'UPDATE public.users SET image_url = $1 WHERE id = $2 AND image_url = $3',
    [newValue, row.id, row.rawValue],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Refresh destination from the current bare source before CAS retry.
 * Missing source → clear the DB pointer instead of writing a broken path.
 */
async function refreshOwnedPathFromBareSource(
  db: pg.Pool,
  currentPath: string,
  retryTarget: string,
  clear: boolean,
): Promise<{ action: 'clear' | 'copy', target: string }> {
  if (clear)
    return { action: 'clear', target: '' }

  const sourceExists = await storageObjectExists(db, currentPath)
  if (!sourceExists)
    return { action: 'clear', target: '' }

  // Always force-refresh so a same-owner icon_url change doesn't keep stale bytes.
  await copyObject(db, currentPath, retryTarget, { force: true })
  return { action: 'copy', target: retryTarget }
}

/**
 * When CAS misses (org transfer / raw value drift), re-read and retry once
 * with the current owner + exact DB value.
 */
async function updateRowWithRetry(
  db: pg.Pool,
  row: LegacyRow,
  newValue: string,
): Promise<{ updated: boolean, targetPath: string | null }> {
  if (await updateRow(db, row, newValue))
    return { updated: true, targetPath: newValue || null }

  if (row.kind === 'app_icon') {
    const { rows: [current] } = await db.query(
      'SELECT app_id, owner_org, icon_url FROM public.apps WHERE app_id = $1',
      [row.id],
    )
    if (!current)
      return { updated: false, targetPath: newValue || null }

    const currentRaw = current.icon_url ?? ''
    const currentPath = normalizeStoredPath(currentRaw)
    if (!isLegacyBarePath(currentPath))
      return { updated: false, targetPath: newValue || null }

    const clear = isPlaceholderBare(currentRaw, currentPath)
    const ownedTarget = clear ? '' : targetForApp(current.owner_org, row.id)
    const refreshed = await refreshOwnedPathFromBareSource(
      db,
      currentPath,
      ownedTarget,
      clear,
    )

    const retryRow: LegacyRow = {
      ...row,
      ownerKey: current.owner_org,
      rawValue: currentRaw,
      sourcePath: currentPath,
      targetPath: refreshed.action === 'clear' ? null : refreshed.target,
      action: refreshed.action === 'clear' ? 'clear' : 'copy',
    }
    const updated = await updateRow(db, retryRow, refreshed.target)
    return {
      updated,
      targetPath: refreshed.action === 'clear' ? null : refreshed.target,
    }
  }

  if (row.kind === 'org_logo') {
    const { rows: [current] } = await db.query(
      'SELECT id, logo FROM public.orgs WHERE id = $1',
      [row.id],
    )
    if (!current)
      return { updated: false, targetPath: newValue || null }

    const currentRaw = current.logo ?? ''
    const currentPath = normalizeStoredPath(currentRaw)
    if (!isLegacyBarePath(currentPath))
      return { updated: false, targetPath: newValue || null }

    const clear = isPlaceholderBare(currentRaw, currentPath)
    const ownedTarget = clear ? '' : targetForOrgLogo(row.id, currentPath)
    const refreshed = await refreshOwnedPathFromBareSource(
      db,
      currentPath,
      ownedTarget,
      clear,
    )

    const retryRow: LegacyRow = {
      ...row,
      rawValue: currentRaw,
      sourcePath: currentPath,
      targetPath: refreshed.action === 'clear' ? null : refreshed.target,
      action: refreshed.action === 'clear' ? 'clear' : 'copy',
    }
    const updated = await updateRow(db, retryRow, refreshed.target)
    return {
      updated,
      targetPath: refreshed.action === 'clear' ? null : refreshed.target,
    }
  }

  const { rows: [current] } = await db.query(
    'SELECT id, image_url FROM public.users WHERE id = $1',
    [row.id],
  )
  if (!current)
    return { updated: false, targetPath: newValue || null }

  const currentRaw = current.image_url ?? ''
  const currentPath = normalizeStoredPath(currentRaw)
  if (!isLegacyBarePath(currentPath))
    return { updated: false, targetPath: newValue || null }

  const clear = isPlaceholderBare(currentRaw, currentPath)
  const ownedTarget = clear ? '' : targetForUser(row.id, currentPath)
  const refreshed = await refreshOwnedPathFromBareSource(
    db,
    currentPath,
    ownedTarget,
    clear,
  )

  const retryRow: LegacyRow = {
    ...row,
    rawValue: currentRaw,
    sourcePath: currentPath,
    targetPath: refreshed.action === 'clear' ? null : refreshed.target,
    action: refreshed.action === 'clear' ? 'clear' : 'copy',
  }
  const updated = await updateRow(db, retryRow, refreshed.target)
  return {
    updated,
    targetPath: refreshed.action === 'clear' ? null : refreshed.target,
  }
}

async function processRow(
  db: pg.Pool,
  row: LegacyRow,
  apply: boolean,
  deleteSource: boolean,
  bareRefIndex: Map<string, number> | null,
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
    const { updated, targetPath } = await updateRowWithRetry(db, row, '')
    let deletedSource = false
    if (updated && deleteSource && bareRefIndex) {
      const remaining = consumeBareReference(bareRefIndex, row.sourcePath)
      if (remaining === 0 && !isPlaceholderBare(row.rawValue, row.sourcePath)) {
        await images.remove([row.sourcePath])
        deletedSource = true
      }
    }
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath,
      status: updated ? 'cleared' : 'already_migrated',
      deletedSource,
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

  const sourceExists = await storageObjectExists(db, row.sourcePath)
  if (!sourceExists) {
    // Object already gone — clear broken pointer so it is not a bare legacy ref.
    const { updated, targetPath: clearedTarget } = await updateRowWithRetry(db, row, '')
    if (updated && bareRefIndex)
      consumeBareReference(bareRefIndex, row.sourcePath)
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: clearedTarget,
      status: updated ? 'cleared' : 'already_migrated',
      deletedSource: false,
    }
  }

  await copyObject(db, row.sourcePath, targetPath)
  const { updated, targetPath: finalTarget } = await updateRowWithRetry(db, row, targetPath)
  if (!updated) {
    return {
      kind: row.kind,
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: finalTarget ?? targetPath,
      status: 'already_migrated',
      deletedSource: false,
    }
  }

  let deletedSource = false
  if (deleteSource && bareRefIndex) {
    const remaining = consumeBareReference(bareRefIndex, row.sourcePath)
    if (remaining === 0) {
      await images.remove([row.sourcePath])
      deletedSource = true
    }
  }

  return {
    kind: row.kind,
    id: row.id,
    sourcePath: row.sourcePath,
    targetPath: finalTarget ?? targetPath,
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
  images = createImageStore(env)
  const db = await connectAdminDb(env)
  try {
    await migrate(db, { apply, concurrency, deleteSource, envFile, limit })
  }
  finally {
    await db.end()
  }
}

async function migrate(db: pg.Pool, { apply, concurrency, deleteSource, envFile, limit }: {
  apply: boolean
  concurrency: number
  deleteSource: boolean
  envFile: string
  limit: number | null
}) {

  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN')
  console.log(`Env file: ${envFile}`)
  console.log(`Concurrency: ${concurrency}`)
  if (limit !== null)
    console.log(`Limit: ${limit}`)
  if (deleteSource)
    console.log('Delete source: yes (when unreferenced)')

  const appRows = await listLegacyApps(db, limit)
  const remainingAfterApps = limit === null ? null : Math.max(0, limit - appRows.length)
  const orgRows = await listLegacyOrgs(db, remainingAfterApps)
  const remainingAfterOrgs = remainingAfterApps === null
    ? null
    : Math.max(0, remainingAfterApps - orgRows.length)
  const userRows = await listLegacyUsers(db, remainingAfterOrgs)

  const allRows = [...appRows, ...orgRows, ...userRows]
  console.log(`Found legacy bare paths: apps=${appRows.length} orgs=${orgRows.length} users=${userRows.length} total=${allRows.length}`)

  let bareRefIndex: Map<string, number> | null = null
  if (apply && deleteSource) {
    console.log('Building bare-path reference index (one scan)…')
    bareRefIndex = await buildBareReferenceIndex(db)
    console.log(`Indexed ${bareRefIndex.size} distinct bare object keys`)
  }

  const results: MigrateResult[] = []
  const failures: MigrateFailure[] = []

  await asyncPool(concurrency, allRows, async (row) => {
    try {
      const result = await processRow(db, row, apply, deleteSource, bareRefIndex)
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
