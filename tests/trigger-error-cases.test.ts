import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, ORG_ID, resetAndSeedAppData, resetAppData, USER_EMAIL } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.trigger.test.${id}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

function postTrigger(trigger: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/triggers/${trigger}`, {
    method: 'POST',
    headers: triggerHeaders,
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

// [case, trigger, body, expected status (null = not asserted), expected error]
const errorCases: Array<[string, string, Record<string, unknown>, number | null, string]> = [
  ['appId is missing', 'cron_stat_app', {}, 400, 'no_appId'],
  ['org is missing', 'cron_stat_app', { appId: 'nonexistent-app-id' }, 400, 'no_orgId'],
  ['appId is not provided with an orgId', 'cron_stat_app', { orgId: ORG_ID }, 400, 'no_appId'],
  ['orgId is missing', 'cron_stat_org', {}, 400, 'no_orgId'],
  ['required fields are missing', 'cron_email', {}, 400, 'missing_email_type'],
  ['email is missing', 'cron_email', { appId: APPNAME, type: 'stats' }, 400, 'missing_email_type'],
  ['appId is missing for a non-billing_period_stats type', 'cron_email', { email: 'test@example.com', type: 'stats' }, 400, 'missing_appId'],
  ['type is missing', 'cron_email', { email: 'test@example.com', appId: APPNAME }, 400, 'missing_email_type'],
  ['orgId is missing for billing_period_stats type', 'cron_email', { email: 'test@example.com', type: 'billing_period_stats' }, 400, 'missing_orgId'],
  ['email type is invalid', 'cron_email', { email: USER_EMAIL, appId: APPNAME, type: 'invalid_type' }, 400, 'invalid_stats_type'],
  ['deploy stats are missing versionId', 'cron_email', { email: 'test@example.com', appId: 'nonexistent-app', type: 'deploy_install_stats' }, 400, 'missing_version_id'],
  ['no version is given to cleanup', 'cron_clear_versions', {}, null, 'no_version'],
  ['channel update has no app id', 'on_channel_update', { table: 'channels', type: 'UPDATE', record: { id: 'nonexistent-channel' }, old_record: {} }, null, 'no_app_id'],
  ['channel update targets another table', 'on_channel_update', { table: 'not_channels', type: 'UPDATE', record: {}, old_record: {} }, 400, 'table_not_match'],
  ['channel update is not an UPDATE', 'on_channel_update', { table: 'channels', type: 'INSERT', record: {}, old_record: {} }, 400, 'type_not_match'],
  ['app create cannot fetch its organization', 'on_app_create', { table: 'apps', type: 'INSERT', record: { id: randomUUID(), app_id: 'test.app', owner_org: randomUUID() } }, 400, 'error_fetching_organization'],
  ['app create record has no id', 'on_app_create', { table: 'apps', type: 'INSERT', record: { id: null, app_id: null } }, 400, 'no_id'],
  ['version create record has no id', 'on_version_create', { table: 'app_versions', type: 'INSERT', record: { id: null, app_id: null } }, 400, 'no_id'],
  ['deploy history create targets another table', 'on_deploy_history_create', { table: 'app_versions_meta', type: 'INSERT', record: { id: null, app_id: null } }, 400, 'table_not_match'],
  ['manifest create data is incomplete', 'on_manifest_create', { table: 'manifest', type: 'INSERT', record: { id: randomUUID(), app_id: 'invalid.app', size: 'invalid-size' } }, 400, 'no_app_version_id_or_s3_path'],
  ['version update targets another table', 'on_version_update', { table: 'not_app_versions', type: 'UPDATE', record: {}, old_record: {} }, 400, 'table_not_match'],
  ['version update is not an UPDATE', 'on_version_update', { table: 'app_versions', type: 'INSERT', record: {}, old_record: {} }, 400, 'type_not_match'],
  ['stripe event has no signature', 'stripe_event', { type: 'invalid.event.type', data: {} }, null, 'webhook_error_no_signature'],
]

describe('[POST] /triggers/* - Error Cases', () => {
  it.each(errorCases)('rejects when %s (/triggers/%s)', async (_case, trigger, body, status, error) => {
    const response = await postTrigger(trigger, body)
    if (status !== null)
      expect(response.status).toBe(status)
    const data = await response.json() as { error: string }
    expect(data.error).toBe(error)
  })

  it.concurrent('cron_stat_app skips stale jobs when the app no longer exists', async () => {
    const response = await postTrigger('cron_stat_app', { appId: 'nonexistent-app-id', orgId: ORG_ID })
    expect(response.status).toBe(200)
    const data = await response.json() as { status: string, reason: string }
    expect(data.status).toBe('skipped')
    expect(data.reason).toBe('app_not_found')
  })

  it('on_version_create returns 200 for a nonexistent app (trigger logs error but does not fail)', async () => {
    const response = await postTrigger('on_version_create', {
      table: 'app_versions',
      type: 'INSERT',
      record: { id: Number.MAX_SAFE_INTEGER, app_id: 'nonexistent.app', name: '1.0.0', owner_org: randomUUID() },
    })
    expect(response.status).toBe(200)
  })
})
