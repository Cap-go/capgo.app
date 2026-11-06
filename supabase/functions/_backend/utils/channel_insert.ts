export interface ExistingChannel {
  id: number
  version: number | null
  rollout_version: number | null
  public: boolean
  paused_at: string | null
}

/**
 * The channel already exists: the lookup before the insert was stale (Hyperdrive
 * caches reads for up to 60s) or lost a race. Carries the real row so the caller
 * can authorize and update it without reading it again.
 */
export class ChannelAlreadyExistsError extends Error {
  constructor(readonly existing: ExistingChannel) {
    super('channel already exists')
    this.name = 'ChannelAlreadyExistsError'
  }
}

const CHANNEL_COLUMNS = 'id, version, rollout_version, public, paused_at'

/**
 * Inserts a channel, or returns the existing one with the same app_id and name.
 * The statement writes, so Hyperdrive never caches it, and it sees the real row
 * even when the existence lookup before it was served from cache.
 * `columns` must be validated identifiers; values bind as $1..$n.
 */
export function buildChannelInsertOrExistingSql(columns: string[], values: unknown[], appId: string, name: string) {
  const placeholders = values.map((_, index) => `$${index + 1}`)
  return {
    text: `WITH inserted AS (
      INSERT INTO public.channels (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT ON CONSTRAINT unique_name_app_id DO NOTHING
      RETURNING ${CHANNEL_COLUMNS}
    )
    SELECT pg_catalog.to_json(r.*) AS row FROM (
      SELECT ${CHANNEL_COLUMNS}, true AS inserted FROM inserted
      UNION ALL
      SELECT ${CHANNEL_COLUMNS}, false AS inserted FROM public.channels
      WHERE app_id = $${values.length + 1} AND name = $${values.length + 2}
        AND NOT EXISTS (SELECT 1 FROM inserted)
    ) r`,
    values: [...values, appId, name],
  }
}

/**
 * Returns the inserted channel, or throws ChannelAlreadyExistsError with the existing one.
 * No row means the conflicting row is not visible to this statement yet (committed after
 * it started, or hidden by RLS): that is reported as the unique violation it replaced.
 */
export function resolveChannelInsert(rows: { row: ExistingChannel & { inserted: boolean } }[]): ExistingChannel {
  const result = rows[0]?.row
  if (!result) {
    throw Object.assign(new Error('duplicate key value violates unique constraint "unique_name_app_id"'), {
      code: '23505',
      constraint: 'unique_name_app_id',
    })
  }
  const { inserted, ...channel } = result
  const id = Number(channel.id)
  if (!Number.isSafeInteger(id))
    throw new Error('Channel insert returned no row')
  if (!inserted)
    throw new ChannelAlreadyExistsError({ ...channel, id })
  return { ...channel, id }
}
