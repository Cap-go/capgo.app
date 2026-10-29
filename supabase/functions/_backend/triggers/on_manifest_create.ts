import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { RetryableResult } from '../utils/retry.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, quickError, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { isTransientDatabaseError } from '../utils/pg_errors.ts'
import { queryJsonOne } from '../utils/pg_rls.ts'
import { isRetryablePostgrestResult, retryWithBackoff } from '../utils/retry.ts'
import { s3 } from '../utils/s3.ts'
import { deltaFileS3PathSql, deltaSessionJoinSql } from '../utils/version_manifest_sql.ts'

const SIZE_RETRY_ATTEMPTS = 1
const SIZE_RETRY_DELAY_MS = 500
const MANIFEST_UPDATE_RETRY_ATTEMPTS = 3
const MANIFEST_UPDATE_RETRY_DELAY_MS = 300

interface QueueLogMetadata {
  queueName: string | null
  queueMsgId: string | null
  queueReadCount: string | null
  cfId: string | null
}

function getQueueLogMetadata(c: Context): QueueLogMetadata {
  return {
    queueName: c.req.header('x-capgo-queue-name') ?? null,
    queueMsgId: c.req.header('x-capgo-queue-msg-id') ?? null,
    queueReadCount: c.req.header('x-capgo-queue-read-count') ?? null,
    cfId: c.req.header('x-capgo-cf-id') ?? null,
  }
}
async function getManifestSizeWithRetry(c: Context, s3Path: string): Promise<{ diagnostics?: Awaited<ReturnType<typeof s3.getSizeDiagnostics>>, lastError?: unknown, attempts: number }> {
  const { result, lastError, attempts } = await retryWithBackoff(
    () => s3.getSizeDiagnostics(c, s3Path),
    {
      attempts: SIZE_RETRY_ATTEMPTS,
      baseDelayMs: SIZE_RETRY_DELAY_MS,
      shouldRetry: diagnostics => diagnostics.size <= 0,
    },
  )

  return { attempts, diagnostics: result, lastError }
}

async function runManifestUpdateWithRetry(
  c: Context,
  operation: () => Promise<RetryableResult>,
): Promise<void> {
  const { result, lastError, attempts } = await retryWithBackoff(async () => {
    try {
      return await operation()
    }
    catch (error) {
      return { error }
    }
  }, {
    attempts: MANIFEST_UPDATE_RETRY_ATTEMPTS,
    baseDelayMs: MANIFEST_UPDATE_RETRY_DELAY_MS,
    shouldRetry: result => isRetryablePostgrestResult(result) || isTransientDatabaseError(result?.error),
  })

  if (!result) {
    throw new Error('update_manifest_file_size returned no result')
  }

  if (attempts > 1) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'on_manifest_create update retried',
      attempts,
      hadError: Boolean(result.error || lastError),
    })
  }

  if (lastError || result.error) {
    throw result.error ?? lastError
  }

  if (typeof result.status === 'number' && result.status >= 400) {
    throw new Error(`update_manifest_file_size failed with status ${result.status}`)
  }
}

/**
 * Size lookups queued for legacy public.manifest rows before the cutover:
 * those ids no longer exist (public.manifest is now a view over delta_files),
 * and the cutover queued delta_files lookups for every unsized file instead.
 */
export function skipLegacyManifestSize(c: Context, record: { id?: number | null }, queue = getQueueLogMetadata(c)) {
  cloudlog({ requestId: c.get('requestId'), message: 'legacy manifest size lookup skipped', id: record.id, queue })
  return c.json(BRES)
}

type DeltaFileRecord = Database['public']['Tables']['delta_files']['Row']

function isDeltaFileRecord(record: object): record is DeltaFileRecord {
  return 'entry_key' in record || 'path_key' in record
}

// One R2 lookup per unique unsized delta file; versions share the row.
export async function updateDeltaFileSize(c: Context, record: DeltaFileRecord, queue = getQueueLogMetadata(c)) {
  if (!record.id)
    throw simpleError('no_s3_path', 'No s3 path', { record })

  const pg = await getPgClient(c)
  try {
    let current: { file_size: number, s3_path: string } | null
    try {
      current = await queryJsonOne<{ file_size: number, s3_path: string }>(
        pg,
        `SELECT delta_file.file_size, ${deltaFileS3PathSql('delta_file', 'delta_session')} AS s3_path
         FROM public.delta_files AS delta_file
         ${deltaSessionJoinSql('delta_file', 'delta_session')}
         WHERE delta_file.id = $1`,
        [record.id],
      )
    }
    catch (currentError) {
      throw simpleError('delta_file_read_failed', 'Failed to read delta file', { id: record.id }, currentError)
    }
    if (!current || current.file_size > 0) {
      cloudlog({ requestId: c.get('requestId'), message: 'delta file gone or already sized', id: record.id, queue })
      return c.json(BRES)
    }

    // The queued record may predate the row's compaction: read the path from the row.
    const s3Path = current.s3_path
    if (!s3Path)
      throw simpleError('no_s3_path', 'No s3 path', { record })

    const { diagnostics, lastError, attempts } = await getManifestSizeWithRetry(c, s3Path)
    const size = diagnostics?.size ?? 0
    if (size <= 0) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'delta file getSize returned 0 after retries', id: record.id, s3_path: s3Path, attempts, queue, error: lastError, storageDiagnostics: diagnostics })
      // Non-2xx keeps the message under the 5-read queue budget.
      throw quickError(503, 'manifest_size_not_found', 'Manifest file size metadata was not found', { attempts, id: record.id, queue, s3_path: s3Path, storageDiagnostics: diagnostics }, lastError, { alert: false })
    }

    await runManifestUpdateWithRetry(c, async () => {
      await pg.query('UPDATE public.delta_files SET file_size = $1 WHERE id = $2 AND file_size = 0', [size, record.id])
      return { error: null }
    })
    cloudlog({ requestId: c.get('requestId'), message: 'delta file file_size updated', id: record.id, s3_path: s3Path, size, attempts, queue })
    return c.json(BRES)
  }
  finally {
    closeClient(c, pg)
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator(['manifest', 'delta_files'], 'INSERT'), (c) => {
  const webhookRecord = c.get('webhookBody') as object
  cloudlog({ requestId: c.get('requestId'), message: 'record', record: webhookRecord })
  if (isDeltaFileRecord(webhookRecord))
    return updateDeltaFileSize(c, webhookRecord)

  return skipLegacyManifestSize(c, webhookRecord as { id?: number | null })
})

export const onManifestCreateTestUtils = {
  isRetryablePostgrestResult,
  runManifestUpdateWithRetry,
  sizeRetryAttempts: SIZE_RETRY_ATTEMPTS,
}
