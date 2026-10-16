import type { ClientBase } from 'pg'
import { inventoryTransaction } from '../../supabase/functions/_backend/utils/r2_inventory.ts'

export const ALERT_REASONS = Object.freeze({
  invalid: 'invalid messages',
  dlq: 'invalid message publication failed',
  safety: 'database or replication safety checks failed',
  referenced: 'referenced objects skipped',
  leased: 'active leases skipped',
  storage: 'storage workflows failed',
  deadline: 'unfinished jobs at deadline',
  completion: 'database completion updates failed',
  conflict: 'database completion conflicts',
})
export type AlertReason = keyof typeof ALERT_REASONS
export type AlertCounts = Partial<Record<AlertReason, number>>
export type CleanupDatabase = <T>(operation: (db: ClientBase) => Promise<T>) => Promise<T>
const maxCount = 1_000_000
const cooldownSeconds = 600
const job = 'cleanup_discord_alert'
function boundedCounts(input: AlertCounts): AlertCounts {
  return Object.fromEntries(Object.keys(ALERT_REASONS).map(reason => [reason, Math.min(maxCount, Math.max(0, Math.floor(Number(input[reason as AlertReason]) || 0)))]))
}
export function cleanupAlertContent(counts: AlertCounts): string {
  const safe = boundedCounts(counts)
  return `R2 cleanup encountered a problem: ${Object.entries(ALERT_REASONS)
    .filter(([key]) => safe[key as AlertReason])
    .map(([key, label]) => `${label} (${safe[key as AlertReason]})`)
    .join(', ')}`.slice(0, 1800)
}

// One checkpoint PK serializes all isolates/deployments. Claim is committed
// before HTTP and never released after an ambiguous send. Counts stay bounded.
export async function claimCleanupAlert(db: ClientBase, bucket: string, counts: AlertCounts): Promise<{ counts: AlertCounts, token: string } | null> {
  return inventoryTransaction(db, async () => {
    await db.query(`SET LOCAL statement_timeout='2s'`)
    await db.query(`SET LOCAL lock_timeout='500ms'`)
    await db.query(`SET LOCAL idle_in_transaction_session_timeout='5s'`)
    await db.query(`INSERT INTO public.r2_inventory_checkpoints(bucket_name,job_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [bucket, job])
    const result = await db.query<{ checkpoint: { counts?: AlertCounts }, allowed: boolean }>(`SELECT checkpoint,
      coalesce((checkpoint->>'nextAllowedAt')::timestamptz <= clock_timestamp(),true) AS allowed
      FROM public.r2_inventory_checkpoints WHERE bucket_name=$1 AND job_name=$2 AND partition_key='' FOR UPDATE`, [bucket, job])
    const row = result.rows[0]
    if (!row)
      throw new Error('Alert checkpoint missing')
    const previous = boundedCounts(row.checkpoint.counts ?? {})
    const current = boundedCounts(counts)
    const combined = boundedCounts(Object.fromEntries(Object.keys(ALERT_REASONS).map(reason => [reason, (previous[reason as AlertReason] ?? 0) + (current[reason as AlertReason] ?? 0)])))
    const token = crypto.randomUUID()
    if (row.allowed) {
      await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=jsonb_build_object(
        'schemaVersion',1,'token',$3::text,'counts','{}'::jsonb,
        'nextAllowedAt',clock_timestamp()+$4::int*interval '1 second')
        WHERE bucket_name=$1 AND job_name=$2 AND partition_key=''`, [bucket, job, token, cooldownSeconds])
      return { counts: combined, token }
    }
    await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object('counts',$3::jsonb)
      WHERE bucket_name=$1 AND job_name=$2 AND partition_key=''`, [bucket, job, JSON.stringify(combined)])
    return null
  })
}

export async function sendCleanupAlert(database: CleanupDatabase, bucket: string, secret: string | undefined, counts: AlertCounts) {
  if (!Object.values(counts).some(count => count && count > 0))
    return
  console.warn(JSON.stringify({ event: 'r2_cleanup_problems', counts: boundedCounts(counts) }))
  if (!secret)
    return
  try {
    const url = new URL(secret)
    if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password
      || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('Invalid dedicated webhook configuration')
    }
    const claim = await database(db => claimCleanupAlert(db, bucket, counts))
    if (!claim)
      return
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: cleanupAlertContent(claim.counts), allowed_mentions: { parse: [] } }),
    })
    // Never log the URL/body/provider error. Do not retry ambiguous sends.
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'))
      await response.body?.cancel()
      if (Number.isFinite(retryAfter) && retryAfter > cooldownSeconds) {
        await database(db => db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint=checkpoint||jsonb_build_object(
          'nextAllowedAt',greatest((checkpoint->>'nextAllowedAt')::timestamptz,clock_timestamp()+$4::int*interval '1 second'))
          WHERE bucket_name=$1 AND job_name=$2 AND partition_key='' AND checkpoint->>'token'=$3`, [bucket, job, claim.token, Math.min(86400, Math.ceil(retryAfter))]))
      }
    }
    else {
      await response.body?.cancel()
    }
    if (!response.ok)
      console.warn(JSON.stringify({ event: 'r2_cleanup_alert_transport_failed', status: response.status }))
  }
  catch {
    // No durable claim => no send. Missing/broken alerting never retries objects.
    console.warn(JSON.stringify({ event: 'r2_cleanup_alert_skipped_or_failed' }))
  }
}
