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
