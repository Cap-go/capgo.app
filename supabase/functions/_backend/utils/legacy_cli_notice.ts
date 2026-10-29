import type { Context } from 'hono'
import { greaterOrEqual, tryParse } from '@std/semver'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { isBentoConfigured } from './bento.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { sendNotifOrgCached } from './notifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import * as schema from './postgres_schema.ts'
import { checkKey } from './supabase.ts'

/** Bento event: the email asking to upgrade the CLI lives in Bento. */
export const LEGACY_CLI_UPGRADE_EVENT = 'user:cli_upgrade_required'
/** First CLI that calls only the Capgo API. Up to 8.90.0 the CLI ships the Supabase SDK and reads the database directly. */
export const FIRST_API_ONLY_CLI = '8.90.1'
/** Direct database access through the Supabase API (PostgREST) is switched off on this date. */
export const LEGACY_CLI_CUTOFF = '2026-12-01'
const UPGRADE_COMMAND = 'npm i -D @capgo/cli@latest'
const CHANGELOG_URL = 'https://github.com/Cap-go/capgo/blob/main/cli/CHANGELOG.md'
/** At most one reminder per user and per week while they keep running an old CLI. */
const REMINDER_CRON = '0 0 * * 1'

const firstApiOnlyCli = tryParse(FIRST_API_ONLY_CLI)!

/** True for a CLI version that still reads the database through the Supabase SDK. */
export function isLegacySdkCli(version: string | undefined): boolean {
  const parsed = version ? tryParse(version.trim()) : undefined
  return !!parsed && !greaterOrEqual(parsed, firstApiOnlyCli)
}

/**
 * Emails the owner of the API key (Bento event LEGACY_CLI_UPGRADE_EVENT) when a CLI older than
 * FIRST_API_ONLY_CLI fetches its config: those CLIs stop working once PostgREST is off.
 * Best effort: never fails the config request.
 */
export async function notifyLegacyCliUpgrade(c: Context, input: { capgkey: string, cliVersion: string }) {
  if (!isBentoConfigured(c) || !isLegacySdkCli(input.cliVersion))
    return

  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    const apikey = await checkKey(c, input.capgkey)
    if (!apikey)
      return

    pgClient = await getPgClient(c, true)
    const drizzle = getDrizzleClient(pgClient)
    // notifications rows are keyed by org: use the user's oldest org, preferring one they administer.
    const [target] = await drizzle
      .select({ email: schema.users.email, orgId: schema.org_users.org_id })
      .from(schema.users)
      .innerJoin(schema.org_users, eq(schema.org_users.user_id, schema.users.id))
      .where(sql`${schema.users.id} = ${apikey.user_id} AND ${schema.org_users.is_invite} = false`)
      .orderBy(desc(sql`${schema.org_users.rbac_role_name} IN ('org_super_admin', 'org_admin')`), asc(schema.org_users.id))
      .limit(1)
    if (!target)
      return

    const sent = await sendNotifOrgCached(c, LEGACY_CLI_UPGRADE_EVENT, {
      cli_version: input.cliVersion,
      minimum_cli_version: FIRST_API_ONLY_CLI,
      cutoff_date: LEGACY_CLI_CUTOFF,
      upgrade_command: UPGRADE_COMMAND,
      changelog_url: CHANGELOG_URL,
    }, target.orgId, `user:${apikey.user_id}`, REMINDER_CRON, target.email, drizzle)
    if (sent)
      cloudlog({ requestId: c.get('requestId'), message: 'Legacy CLI upgrade email sent', user_id: apikey.user_id, cli_version: input.cliVersion })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Legacy CLI upgrade email failed', cli_version: input.cliVersion, error: serializeError(error) })
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}
