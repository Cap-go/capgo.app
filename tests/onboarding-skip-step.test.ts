import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, getEndpointUrl, getSupabaseClient, USER_ID } from './test-utils.ts'

const fixture = randomUUID()
const orgId = randomUUID()
const appId = `com.test.onboarding.skip.${fixture}`
const admin = getSupabaseClient()
const keys: Awaited<ReturnType<typeof createDirectApiKeyWithBindings>>[] = []
let writerKey: string
let readerKey: string

async function skip(key: string, step: string, reason: string | null = 'Set up by my AI agent') {
  return fetchTestRequest(getEndpointUrl('/private/onboarding_progress/skip_step'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': key },
    body: JSON.stringify({ appId, step, reason }),
  })
}

async function readSetup() {
  const { data, error } = await admin.from('apps').select('onboarding').eq('app_id', appId).single()
  expect(error).toBeNull()
  return (data!.onboarding as any).setup
}

beforeAll(async () => {
  expect((await admin.from('orgs').insert({ id: orgId, created_by: USER_ID, name: 'Onboarding skip test', management_email: 'onboarding-skip@example.com' })).error).toBeNull()
  expect((await admin.from('apps').insert({ app_id: appId, owner_org: orgId, name: 'Onboarding skip test', icon_url: '' })).error).toBeNull()
  // The updater is installed although `init` never ran and no channel exists yet.
  expect((await admin.from('apps').update({ onboarding: { setup: {
    todo_list_version: 4,
    ota_todo_list_version: '1',
    builder_todo_list_version: '1',
    paths: ['ota', 'builder'],
    source: 'manual',
    outcome: 'in_progress',
    steps: {
      ota: { login_cli_mcp: { status: 'pending' }, add_channel: { status: 'pending' }, add_updater: { status: 'done' } },
      builder: {
        // Sparse: only a later iOS step has a record.
        ios: { prepare_certificate: { status: 'done' } },
        android: { start_setup: { status: 'pending' }, prepare_keystore: { status: 'done' }, connect_google_play: { status: 'pending' }, successful_cloud_build: { status: 'pending' } },
      },
    },
  } } }).eq('app_id', appId)).error).toBeNull()
  const writer = await createDirectApiKeyWithBindings({ key: randomUUID(), name: 'Onboarding skip writer', orgId })
  keys.push(writer)
  writerKey = writer.key!
  const reader = await createDirectApiKeyWithBindings({ key: randomUUID(), name: 'Onboarding skip reader', orgId, appId, appRoleName: 'app_reader' })
  keys.push(reader)
  await executeSQL('DELETE FROM public.role_bindings WHERE principal_type = \'apikey\' AND principal_id = $1::uuid AND scope_type = \'org\'', [reader.rbac_id])
  readerKey = reader.key!
})

afterAll(async () => {
  for (const key of keys)
    await admin.from('apikeys').delete().eq('id', key.id)
  await admin.from('apps').delete().eq('app_id', appId)
  await admin.from('orgs').delete().eq('id', orgId)
})

describe('onboarding skip step', () => {
  it('rejects malformed step ids and missing or blank reasons', async () => {
    expect((await skip(writerKey, 'ota.login_cli_mcp; drop')).status).toBe(400)
    expect((await skip(writerKey, 'ota.login_cli_mcp', null)).status).toBe(400)
    expect((await skip(writerKey, 'ota.login_cli_mcp', '   ')).status).toBe(400)
    expect((await skip(writerKey, 'ota.login_cli_mcp', 'x'.repeat(501))).status).toBe(400)
  })

  it('refuses builder steps with no stored record, and already finished steps', async () => {
    // ios.start_setup has no stored record; add_updater is already done.
    for (const step of ['builder.ios.start_setup', 'ota.add_updater']) {
      const response = await skip(writerKey, step)
      expect(response.status, step).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'step_not_skippable' })
    }
  })

  it('allows skipping any open live-update step, including channel and the final step', async () => {
    const channel = await skip(writerKey, 'ota.add_channel', 'Channel already exists in another env')
    expect(channel.status).toBe(200)
    expect((await channel.json() as any).onboarding.setup.steps.ota.add_channel.status).toBe('skipped')

    const final = await skip(writerKey, 'ota.test_update', 'Verified the update in TestFlight already')
    expect(final.status).toBe(200)
    expect((await final.json() as any).onboarding.setup.steps.ota.test_update.status).toBe('skipped')
  })

  it('does not let an app reader skip steps', async () => {
    const response = await skip(readerKey, 'ota.login_cli_mcp')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'app_access_denied' })
    expect((await readSetup()).steps.ota.login_cli_mcp.status).toBe('pending')
  })

  it('records an explicit skip for passed-over live update and Builder steps', async () => {
    const ota = await skip(writerKey, 'ota.login_cli_mcp')
    expect(ota.status).toBe(200)
    expect((await ota.json() as any).onboarding.setup.steps.ota.login_cli_mcp.status).toBe('skipped')

    const builder = await skip(writerKey, 'builder.android.start_setup')
    expect(builder.status).toBe(200)
    const setup = await readSetup()
    expect(setup.steps.builder.android.start_setup.status).toBe('skipped')
    expect(setup.steps.ota.add_updater.status).toBe('done')
    expect(setup.steps.ota.add_channel.status).toBe('skipped')
    expect(setup.outcome).toBe('in_progress')
  })

  it('completes, rather than dismisses, a v4 checklist finished with skipped tasks in SQL', async () => {
    const rows = await executeSQL(`SELECT public.merge_app_onboarding_setup($1::jsonb, $2::jsonb) -> 'setup' ->> 'outcome' AS outcome`, [
      JSON.stringify({ setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: {} } } }),
      JSON.stringify({ steps: { login_cli_mcp: { status: 'skipped' }, add_channel: { status: 'done' }, add_updater: { status: 'done' }, add_code: { status: 'done' }, run_device: { status: 'done' }, upload_bundle: { status: 'done' }, test_update: { status: 'done' } } }),
    ])
    expect(rows[0].outcome).toBe('completed')
  })

  it('keeps an explicit hide outcome when every v4 task is already present in SQL', async () => {
    const done = Object.fromEntries(
      ['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'run_device', 'upload_bundle', 'test_update']
        .map(id => [id, { status: 'done' }]),
    )
    const rows = await executeSQL(`SELECT public.merge_app_onboarding_setup($1::jsonb, $2::jsonb) -> 'setup' ->> 'outcome' AS outcome`, [
      JSON.stringify({ setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: done } } }),
      JSON.stringify({ outcome: 'skipped' }),
    ])
    expect(rows[0].outcome).toBe('skipped')
  })
})
