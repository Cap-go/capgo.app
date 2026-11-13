// Internal email jobs only: primary-key deployment lookup and an app-indexed
// newer-deployment check. The final write consumes the queue claim atomically.
const platform = (alias: string) => `CASE WHEN ${alias}.ios AND NOT ${alias}.android THEN 'ios' WHEN ${alias}.android AND NOT ${alias}.ios THEN 'android' ELSE 'all' END`

const eligible = `dh.id = $1 AND dh.app_id = $2
  AND dh.install_stats_email_sent_at = $3::timestamptz
  AND dh.deployed_at <= now() - interval '24 hours'
  AND dh.deployed_at > now() - interval '48 hours'
  AND a.app_id = dh.app_id AND a.owner_org = dh.owner_org
  AND c.id = dh.channel_id AND c.app_id = dh.app_id AND c.owner_org = dh.owner_org
  AND c.public AND (c.ios OR c.android) AND c.paused_at IS NULL
  AND c.version = dh.version_id
  AND v.id = dh.version_id AND v.app_id = dh.app_id AND v.owner_org = dh.owner_org
  AND NOT v.deleted AND v.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.deploy_history newer
    JOIN public.channels nc ON nc.id = newer.channel_id
    WHERE newer.app_id = dh.app_id
      AND (newer.deployed_at, newer.id) > (dh.deployed_at, dh.id)
      AND nc.public AND (nc.ios OR nc.android)
      AND ${platform('nc')} = ${platform('c')}
  )`

const fields = `dh.id, dh.app_id, dh.owner_org, dh.version_id, dh.channel_id,
  dh.deployed_at, v.name AS version_name, c.name AS channel_name,
  a.name AS app_name, ${platform('c')} AS platform`

export const DEPLOY_REPORT_SELECT_SQL = `SELECT ${fields}
FROM public.deploy_history dh, public.apps a, public.channels c, public.app_versions v
WHERE ${eligible}`

// A cached preliminary read cannot authorize a send: this conditional write must
// still find the same deployment, ownership, bundle name, and unconsumed claim.
export const DEPLOY_REPORT_CONSUME_SQL = `UPDATE public.deploy_history dh
SET install_stats_email_sent_at = clock_timestamp()
FROM public.apps a, public.channels c, public.app_versions v
WHERE ${eligible}
  AND dh.version_id = $4 AND v.name = $5 AND dh.owner_org = $6::uuid
  AND dh.deployed_at = $7::timestamptz
RETURNING ${fields}`

export const DEPLOY_REPORT_RELEASE_SQL = `UPDATE public.deploy_history
SET install_stats_email_sent_at = NULL
WHERE id = $1 AND app_id = $2 AND install_stats_email_sent_at = $3::timestamptz`

export interface DeployReportState {
  id: number
  app_id: string
  owner_org: string
  version_id: number
  version_name: string
  channel_id: number
  channel_name: string
  app_name: string | null
  platform: string
  deployed_at: string
}
