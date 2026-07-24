/**
 * Reclaim ALL soft-deleted app_versions that still have public.manifest rows.
 *
 * Per version (not per row):
 *   1) exist → move to deleted-after-7-days/; missing → ok (R2 pooled)
 *   2) DELETE public.manifest rows + clear JSON/count
 *
 * Nulling app_versions.manifest normally runs check_encrypted_bundle_on_insert,
 * which unnests the full JSON against public.manifest and statement-timeouts on
 * large bundles. Disable that trigger only inside each short per-version
 * transaction (disable + update + enable) so concurrent writers never see a
 * globally disabled trigger.
 *
 * Usage:
 *   bun scripts/reclaim_deleted_version_manifests.ts
 */
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const R2_CONCURRENCY = 200
const LOCK_TRIGGER = 'enforce_encrypted_bundle_trigger'
const DB_URL_ENV_KEYS = [
  'MAIN_SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_DIRECT_URL',
  'DIRECT_URL',
]

async function loadEnv(filePath: string) {
  const env: Record<string, string> = {}
  const text = await Bun.file(filePath).text()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0)
      continue
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && value !== '')
      env[key] = value
  }
  return env
}

function requireDbUrl(env: Record<string, string>) {
  for (const key of DB_URL_ENV_KEYS) {
    if (env[key])
      return env[key]
  }
  throw new Error(`Missing DB URL. Set one of: ${DB_URL_ENV_KEYS.join(', ')}`)
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0)
    return
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++]
      await fn(current)
    }
  })
  await Promise.all(workers)
}

async function objectExists(s3: S3Client, bucket: string, key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  }
  catch (error: any) {
    const status = error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status
    const code = error?.name ?? error?.Code ?? error?.code
    if (status === 404 || code === 'NotFound' || code === 'NoSuchKey')
      return false
    throw error
  }
}

async function moveToTrash(s3: S3Client, bucket: string, key: string) {
  if (key.startsWith(TRASH_PREFIX))
    return

  const exists = await objectExists(s3, bucket, key)
  if (!exists)
    return

  const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/')
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodedKey}`,
    Key: `${TRASH_PREFIX}${key}`,
  }))
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

function createPgClient(databaseUrl: string) {
  const parsed = new URL(databaseUrl)
  const host = parsed.hostname
  const usesLocalDatabase = host === 'localhost' || host === '127.0.0.1' || host === '::1'

  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('sslrootcert')

  return new pg.Client({
    connectionString: parsed.toString(),
    ssl: usesLocalDatabase ? false : { rejectUnauthorized: false },
  })
}

function formatRate(count: number, startedAt: number) {
  const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001)
  return `${Math.round(count / elapsedSec)}/s`
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  const databaseUrl = requireDbUrl(env)
  const db = createPgClient(databaseUrl)
  await db.connect()
  await db.query(`SET statement_timeout = '0'`)

  const s3 = new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: `https://${env.S3_ENDPOINT}`,
    region: env.S3_REGION || 'auto',
    forcePathStyle: true,
    maxAttempts: 3,
  })
  const bucket = env.S3_BUCKET || 'capgo'

  const onSignal = () => {
    // Closing the connection aborts any in-flight transaction and rolls back a
    // temporary trigger disable that lived only inside that transaction.
    db.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  console.log('Listing soft-deleted versions with leftover manifests...')
  const versionsRes = await db.query<{ id: number, app_id: string, manifest_count: number }>(`
    SELECT av.id, av.app_id, av.manifest_count
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND av.app_id NOT LIKE 'com.capdemo%'
      AND (
        av.manifest_count > 0
        OR EXISTS (
          SELECT 1 FROM public.manifest AS m WHERE m.app_version_id = av.id
        )
      )
    ORDER BY av.deleted_at NULLS LAST, av.id
  `)
  const versions = versionsRes.rows
  console.log(`Found ${versions.length} versions`)

  let done = 0
  let totalTrashed = 0
  let totalDeleted = 0
  const startedAt = Date.now()

  try {
    for (const version of versions) {
      const trashRes = await db.query<{ s3_path: string }>(
        `SELECT DISTINCT m.s3_path
         FROM public.manifest AS m
         WHERE m.app_version_id = $1
           AND m.s3_path IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.manifest AS other
             WHERE other.file_hash = m.file_hash
               AND other.file_name = m.file_name
               AND other.app_version_id <> $1
           )`,
        [version.id],
      )
      const paths = trashRes.rows.map(row => row.s3_path)

      await mapPool(paths, R2_CONCURRENCY, async (path) => {
        await moveToTrash(s3, bucket, path)
      })

      await db.query('BEGIN')
      try {
        // ALTER TABLE takes ACCESS EXCLUSIVE; disable only for this short txn.
        await db.query(
          `ALTER TABLE public.app_versions DISABLE TRIGGER ${LOCK_TRIGGER}`,
        )

        const deletedRes = await db.query(
          `DELETE FROM public.manifest WHERE app_version_id = $1`,
          [version.id],
        )
        const deletedRows = deletedRes.rowCount ?? 0

        await db.query(
          `UPDATE public.app_versions
           SET manifest_count = 0,
               manifest = NULL
           WHERE id = $1`,
          [version.id],
        )

        if (deletedRows > 0 || (version.manifest_count ?? 0) > 0) {
          await db.query(
            `UPDATE public.apps
             SET manifest_bundle_count = GREATEST(manifest_bundle_count - 1, 0),
                 updated_at = now()
             WHERE app_id = $1`,
            [version.app_id],
          )
        }

        await db.query(
          `ALTER TABLE public.app_versions ENABLE TRIGGER ${LOCK_TRIGGER}`,
        )
        await db.query('COMMIT')
        totalDeleted += deletedRows
      }
      catch (error) {
        await db.query('ROLLBACK')
        throw error
      }

      done += 1
      totalTrashed += paths.length
      if (done % 10 === 0 || done === versions.length) {
        process.stdout.write(
          `\rCleaned ${done}/${versions.length} versions (rows=${totalDeleted} ${formatRate(totalDeleted, startedAt)}, r2_candidates=${totalTrashed})`,
        )
      }
    }
  }
  finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await db.end()
  }

  process.stdout.write('\n')
  console.log('Done.')
  console.log(`Versions cleaned: ${done}`)
  console.log(`Manifest rows deleted: ${totalDeleted}`)
  console.log(`R2 trash candidates: ${totalTrashed}`)
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${formatRate(totalDeleted, startedAt)} rows)`)
}

await main()
