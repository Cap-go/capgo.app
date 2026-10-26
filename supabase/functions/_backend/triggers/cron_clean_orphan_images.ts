import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import type { ImageFolderEntry } from '../utils/image_storage.ts'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { listImageFolder, removeImageFolder, removeImages } from '../utils/image_storage.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

// The queue consumer aborts the HTTP call after 15s. Stop starting new folders
// well before that and let the next daily run continue with the rest.
const CLEANUP_BUDGET_MS = 10_000
const CLEANUP_CONCURRENCY = 8
// Keeps PostgREST `in.(...)` filters well under URL length limits.
const LOOKUP_CHUNK_SIZE = 100
// Folders listed per run, as before; shuffling spreads work across runs.
const LIST_LIMIT = 1000
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeImageStoragePath(path?: string | null) {
  if (!path)
    return ''

  const pathWithoutQuery = path.split('?')[0]
  const signedUrlRegex = /\/storage\/v1\/object\/(?:public\/|sign\/)?images\/(.+)$/
  const signedUrlMatch = signedUrlRegex.exec(pathWithoutQuery)
  if (signedUrlMatch?.[1])
    return decodePathSegment(signedUrlMatch[1]).replace(/^\/+/, '')

  return decodePathSegment(pathWithoutQuery).replace(/^\/+/, '').replace(/^images\//, '')
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

export function getStaleOrgLogoPaths(orgId: string, files: ImageFolderEntry[], linkedLogoPath?: string | null) {
  const normalizedLinkedLogoPath = normalizeImageStoragePath(linkedLogoPath)

  return files
    .filter(file => !file.isFolder)
    .map(file => `org/${orgId}/logo/${file.name}`)
    .filter(path => path !== normalizedLinkedLogoPath)
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size))
  return chunks
}

// Random order so a run cut short by the budget does not always revisit the
// same folders. Not security sensitive; crypto source only keeps scanners quiet.
function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  const random = new Uint32Array(result.length)
  crypto.getRandomValues(random)
  for (let i = result.length - 1; i > 0; i--) {
    const j = random[i] % (i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Runs `worker` over `items` with bounded concurrency and stops starting new
 * items once `deadline` (epoch ms) has passed. Returns how many items started.
 */
export async function runWithDeadline<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  options: { concurrency: number, deadline: number, now?: () => number },
) {
  const now = options.now ?? Date.now
  let next = 0
  const runners = Array.from({ length: Math.min(options.concurrency, items.length) }, async () => {
    while (next < items.length && now() < options.deadline) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(runners)
  return next
}

type SupabaseAdmin = ReturnType<typeof supabaseAdmin>

interface CleanupStats {
  deletedUserImages: number
  deletedOrgImages: number
  errors: number
  userFolders: number
  userFoldersProcessed: number
  orgFolders: number
  orgFoldersProcessed: number
}

async function fetchExisting<Row>(
  ids: string[],
  query: (ids: string[]) => PromiseLike<{ data: Row[] | null, error: unknown }>,
) {
  const rows: Row[] = []
  for (const idsChunk of chunk(ids, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await query(idsChunk)
    if (error)
      throw error
    rows.push(...(data ?? []))
  }
  return rows
}

async function cleanUserFolder(
  c: Context<MiddlewareKeyVariables>,
  stats: CleanupStats,
  userId: string,
  user: { image_url: string | null } | undefined,
) {
  try {
    // Deleted user: remove everything. Existing user: remove avatar files not
    // referenced by users.image_url.
    if (!user) {
      const deleted = await removeImageFolder(c, userId)
      if (deleted > 0) {
        stats.deletedUserImages += deleted
        cloudlog({ requestId: c.get('requestId'), message: 'deleted orphaned user images', count: deleted, userId })
      }
      return
    }

    const files = await listImageFolder(c, userId)
    const linkedImagePath = normalizeImageStoragePath(user.image_url)
    const filePaths = files
      .filter(file => !file.isFolder)
      .map(file => `${userId}/${file.name}`)
      .filter(path => path !== linkedImagePath)

    if (filePaths.length === 0)
      return

    await removeImages(c, filePaths)
    stats.deletedUserImages += filePaths.length
    cloudlog({
      requestId: c.get('requestId'),
      message: 'deleted stale user images not linked in profile',
      count: filePaths.length,
      userId,
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'error cleaning user images', error, userId })
    stats.errors++
  }
}

async function cleanOrgFolder(
  c: Context<MiddlewareKeyVariables>,
  supabase: SupabaseAdmin,
  stats: CleanupStats,
  orgId: string,
  org: { logo: string | null } | undefined,
  deadline: number,
) {
  try {
    // If org doesn't exist, delete all its images
    if (!org) {
      const deleted = await removeImageFolder(c, `org/${orgId}`)
      if (deleted > 0) {
        stats.deletedOrgImages += deleted
        cloudlog({ requestId: c.get('requestId'), message: 'deleted orphaned org images', orgId, count: deleted })
      }
      return
    }

    const entries = await listImageFolder(c, `org/${orgId}`)
    const subFolders = entries.filter(entry => entry.isFolder).map(entry => entry.name)

    // The logo folder is organization-scoped, not app-scoped. Keep the current
    // org logo referenced in public.orgs.logo and only remove stale files.
    if (subFolders.includes('logo')) {
      try {
        const files = await listImageFolder(c, `org/${orgId}/logo`)
        const staleLogoPaths = getStaleOrgLogoPaths(orgId, files, org.logo)
        if (staleLogoPaths.length > 0) {
          await removeImages(c, staleLogoPaths)
          stats.deletedOrgImages += staleLogoPaths.length
          cloudlog({
            requestId: c.get('requestId'),
            message: 'deleted stale org logo images not linked in org',
            count: staleLogoPaths.length,
            orgId,
          })
        }
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'error cleaning stale org logo images', error, orgId })
        stats.errors++
      }
    }

    // Org exists, but check if individual apps still exist
    const appIds = subFolders.filter(name => name !== 'logo')
    if (appIds.length === 0)
      return

    const existingApps = await fetchExisting<{ app_id: string }>(appIds, ids => supabase
      .from('apps')
      .select('app_id')
      .in('app_id', ids))
    const existingAppIds = new Set(existingApps.map(row => row.app_id))

    for (const appId of appIds) {
      if (Date.now() >= deadline)
        break
      if (existingAppIds.has(appId))
        continue
      try {
        const deleted = await removeImageFolder(c, `org/${orgId}/${appId}`)
        if (deleted > 0) {
          stats.deletedOrgImages += deleted
          cloudlog({ requestId: c.get('requestId'), message: 'deleted orphaned app images', appId, orgId })
        }
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'error deleting orphaned app images', error, appId, orgId })
        stats.errors++
      }
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'error processing org folder', error, orgId })
    stats.errors++
  }
}

async function cleanUserImages(c: Context<MiddlewareKeyVariables>, supabase: SupabaseAdmin, stats: CleanupStats, deadline: number) {
  // Top-level folders in image storage are user IDs, plus `org` (logos and icons)
  // and `public` (shared assets).
  const topLevelFolders = await listImageFolder(c, '', { limit: LIST_LIMIT })
  // Only UUID folders are avatars; anything else (`org`, `public`, strays) is left alone.
  const userIds = shuffle(topLevelFolders.filter(f => f.isFolder && UUID_REGEX.test(f.name)).map(f => f.name))
  stats.userFolders = userIds.length
  if (userIds.length === 0)
    return

  const users = await fetchExisting<{ id: string, image_url: string | null }>(userIds, ids => supabase
    .from('users')
    .select('id, image_url')
    .in('id', ids))
  const usersById = new Map(users.map(user => [user.id, user]))

  stats.userFoldersProcessed = await runWithDeadline(
    userIds,
    userId => cleanUserFolder(c, stats, userId, usersById.get(userId)),
    { concurrency: CLEANUP_CONCURRENCY, deadline },
  )
}

async function cleanOrgImages(c: Context<MiddlewareKeyVariables>, supabase: SupabaseAdmin, stats: CleanupStats, deadline: number) {
  // List all folders under images/org/ (one per organization)
  const orgFolders = await listImageFolder(c, 'org', { limit: LIST_LIMIT })
  const orgIds = shuffle(orgFolders.filter(f => f.isFolder && UUID_REGEX.test(f.name)).map(f => f.name))
  stats.orgFolders = orgIds.length
  if (orgIds.length === 0)
    return

  const orgs = await fetchExisting<{ id: string, logo: string | null }>(orgIds, ids => supabase
    .from('orgs')
    .select('id, logo')
    .in('id', ids))
  const orgsById = new Map(orgs.map(org => [org.id, org]))

  stats.orgFoldersProcessed = await runWithDeadline(
    orgIds,
    orgId => cleanOrgFolder(c, supabase, stats, orgId, orgsById.get(orgId), deadline),
    { concurrency: CLEANUP_CONCURRENCY, deadline },
  )
}

// This CRON job cleans up orphaned images from image storage (R2)
// - User avatars stored at: images/{user_id}/*
// - App icons stored at: images/org/{org_id}/{app_id}/icon
// Images become orphaned when their associated user, org, or app is deleted
// but the image cleanup failed or was not implemented at deletion time.
// It also removes stale user avatar files not linked by users.image_url.
// Work is time-boxed; folders not reached are handled by the next run.
app.post('/', middlewareAPISecret, async (c) => {
  cloudlog({ requestId: c.get('requestId'), message: 'starting cron_clean_orphan_images' })

  const startTime = Date.now()
  const deadline = startTime + CLEANUP_BUDGET_MS
  const stats: CleanupStats = {
    deletedUserImages: 0,
    deletedOrgImages: 0,
    errors: 0,
    userFolders: 0,
    userFoldersProcessed: 0,
    orgFolders: 0,
    orgFoldersProcessed: 0,
  }

  const supabase = supabaseAdmin(c)

  await Promise.all([
    cleanUserImages(c, supabase, stats, deadline).catch((error) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'error in user cleanup phase', error })
      stats.errors++
    }),
    cleanOrgImages(c, supabase, stats, deadline).catch((error) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'error in org cleanup phase', error })
      stats.errors++
    }),
  ])

  cloudlog({
    requestId: c.get('requestId'),
    context: 'orphan image cleanup completed',
    duration_ms: Date.now() - startTime,
    deleted_user_images: stats.deletedUserImages,
    deleted_org_images: stats.deletedOrgImages,
    user_folders: stats.userFolders,
    user_folders_processed: stats.userFoldersProcessed,
    org_folders: stats.orgFolders,
    org_folders_processed: stats.orgFoldersProcessed,
    errors: stats.errors,
  })

  return c.json(BRES)
})
