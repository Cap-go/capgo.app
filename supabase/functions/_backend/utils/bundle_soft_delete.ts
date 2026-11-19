import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { PgClient } from './pg.ts'
import { HTTPException } from 'hono/http-exception'
import { beginWriteTransaction, checkoutPgClient, logPgError, releasePgClient } from './pg.ts'
import { setRequestApikeyHeader } from './pg_rls.ts'

/**
 * Soft-deleting bundles from an open write transaction, shared by `DELETE /bundle` (by name)
 * and `POST /bundle/cleanup`, so the lock order and audit attribution live in one place.
 */

interface TxClient {
  query: <TRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>
}

/**
 * Takes each bundle's lifecycle lock through lock_channel_bundle_lifecycle (row FOR UPDATE,
 * then advisory lock, the protocol channel promotion uses) in id order, so callers cannot
 * deadlock with a promotion. PG evaluates volatile output expressions after ORDER BY.
 */
export async function lockBundleLifecycles(tx: TxClient, ids: number[]) {
  await tx.query(
    'SELECT public.lock_channel_bundle_lifecycle(id, NULL) FROM pg_catalog.unnest($1::bigint[]) AS t(id) ORDER BY id',
    [ids],
  )
}

/**
 * Soft-deletes the still-active `ids` of `appId`; must run after lockBundleLifecycles in the
 * same transaction. Unless `ignoreChannel`, bundles a channel targets are skipped (with it, the
 * unlink_channels_from_deleted_version trigger clears their links). Returns the deleted ids.
 *
 * The write is attributed to the caller's API key in the audit log (get_apikey_header). The
 * direct connection runs as an internal role, so the delete-permission trigger does not re-check
 * it: callers must have checked bundle.delete.
 */
export async function softDeleteLockedBundles(tx: TxClient, effectiveApikey: string, appId: string, ids: number[], ignoreChannel: boolean): Promise<number[]> {
  await setRequestApikeyHeader(tx, effectiveApikey)
  const result = await tx.query<{ id: string | number }>(
    `UPDATE public.app_versions AS v
     SET deleted = true
     WHERE v.app_id = $1
       AND v.id = ANY($2::bigint[])
       AND v.deleted = false
       AND ($3::boolean OR NOT EXISTS (
         SELECT 1
         FROM public.channels AS ch
         WHERE ch.app_id = v.app_id
           AND (ch.version = v.id OR ch.rollout_version = v.id)
       ))
     RETURNING v.id`,
    [appId, ids, ignoreChannel],
  )
  return result.rows.map(row => Number(row.id))
}

const DEADLOCK_SQLSTATE = '40P01'

/**
 * Runs `fn` again when Postgres aborts it as a deadlock victim, up to `attempts` times. Only for
 * work that is its own transaction and safe to repeat.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== DEADLOCK_SQLSTATE || attempt >= attempts)
        throw error
    }
  }
}

/** Bundles per soft-delete transaction: keeps each transaction (and its lifecycle locks) bounded. */
export const BUNDLE_DELETE_BATCH_SIZE = 200

/**
 * Runs `fn` in its own write transaction on a connection checked out of `pgClient`: COMMIT on
 * success, ROLLBACK (and a pg error log under `logLabel`) on failure.
 */
async function inBundleWriteTransaction<T>(
  c: Context<MiddlewareKeyVariables>,
  pgClient: PgClient,
  logLabel: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  let dbClient: Awaited<ReturnType<typeof checkoutPgClient>> | null = null
  let transactionStarted = false
  try {
    dbClient = await checkoutPgClient(pgClient)
    await beginWriteTransaction(dbClient)
    transactionStarted = true
    const result = await fn(dbClient)
    await dbClient.query('COMMIT')
    return result
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      try {
        await dbClient.query('ROLLBACK')
      }
      catch {
        // Preserve the original error when rollback itself fails.
      }
    }
    if (error instanceof HTTPException)
      throw error
    logPgError(c, logLabel, error)
    throw error
  }
  finally {
    releasePgClient(pgClient, dbClient)
  }
}

/**
 * Soft-deletes one batch in a single transaction. Each bundle's lifecycle lock (taken through
 * `lock_channel_bundle_lifecycle`, like channel promotion) is held while the channel links
 * are checked and the rows updated, so a concurrent promotion either commits first and keeps
 * its bundle, or waits and then sees it deleted. With `ignoreChannel`, linked bundles are
 * deleted too and the unlink_channels_from_deleted_version trigger clears their links.
 * Returns the deleted ids.
 */
export function softDeleteBundleBatch(
  c: Context<MiddlewareKeyVariables>,
  pgClient: PgClient,
  effectiveApikey: string,
  appId: string,
  ids: number[],
  ignoreChannel: boolean,
  logLabel: string,
): Promise<number[]> {
  return inBundleWriteTransaction(c, pgClient, logLabel, async (tx) => {
    await lockBundleLifecycles(tx, ids)
    return softDeleteLockedBundles(tx, effectiveApikey, appId, ids, ignoreChannel)
  })
}

/**
 * Soft-deletes the next `limit` active bundles of `appId` with an id above `afterId`, keeping
 * channel-linked ones. The candidates are selected and locked inside the write transaction (in
 * id order, like lockBundleLifecycles), never from a separate read, which the query cache could
 * serve stale. `lastId` is the highest candidate id (null when none is left): pass it as the
 * next `afterId`, since skipped linked bundles stay active.
 */
export function softDeleteNextActiveBundles(
  c: Context<MiddlewareKeyVariables>,
  pgClient: PgClient,
  effectiveApikey: string,
  appId: string,
  afterId: number,
  limit: number,
  logLabel: string,
): Promise<{ lastId: number | null, deleted: number[] }> {
  return inBundleWriteTransaction(c, pgClient, logLabel, async (tx) => {
    const locked = await tx.query<{ id: string | number }>(
      `SELECT t.id, public.lock_channel_bundle_lifecycle(t.id, NULL)
       FROM (
         SELECT id FROM public.app_versions
         WHERE app_id = $1 AND deleted = false AND id > $2
         ORDER BY id
         LIMIT $3
       ) AS t
       ORDER BY t.id`,
      [appId, afterId, limit],
    )
    const ids = locked.rows.map(row => Number(row.id))
    if (!ids.length)
      return { lastId: null, deleted: [] }
    const deleted = await softDeleteLockedBundles(tx, effectiveApikey, appId, ids, false)
    return { lastId: ids.at(-1)!, deleted }
  })
}
