import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupPostgresClient, executeSQL, ORG_ID, USER_ID } from './test-utils.ts'

const RELATIONS = {
  appVersions: 'app_versions',
  appVersionsMeta: 'app_versions_meta',
  manifest: 'manifest',
  channels: 'channels',
  channelDevices: 'channel_devices',
  deployHistory: 'deploy_history',
  devices: 'devices',
  buildRequests: 'build_requests',
} as const

function testAppId(prefix: string) {
  return `com.onboarding.demo.${prefix}.${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function createPendingApp(appId: string) {
  const [app] = await executeSQL(
    `INSERT INTO public.apps (
      app_id,
      icon_url,
      name,
      last_version,
      updated_at,
      owner_org,
      user_id,
      need_onboarding,
      channel_device_count,
      manifest_bundle_count
    ) VALUES (
      $1,
      '',
      $1,
      '2.0.0',
      NOW(),
      $2,
      $3,
      true,
      2,
      2
    )
    RETURNING id`,
    [appId, ORG_ID, USER_ID],
  )

  return app.id as string
}

async function track(appId: string, relationName: string, rowKeys: Array<string | number>, seedId: string) {
  await executeSQL(
    `SELECT public.track_onboarding_demo_data($1::text, $2::uuid, $3::text, $4::text[], $5::uuid)`,
    [appId, ORG_ID, relationName, rowKeys.map(String), seedId],
  )
}

afterAll(async () => {
  await cleanupPostgresClient()
})

describe('onboarding demo reset', () => {
  it.concurrent('deletes tracked demo rows while preserving real app data', async () => {
    const appId = testAppId('mixed')
    const appUuid = await createPendingApp(appId)
    const seedId = randomUUID()
    const realDate = '2099-04-01'
    const demoDate = '2099-04-02'

    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        r2_path,
        storage_provider,
        deleted,
        manifest_count,
        created_at
      ) VALUES
        ($1, '2.0.0', $2, $3, 'orgs/' || $2::text || '/apps/' || $1 || '/2.0.0.zip', 'r2', false, 1, NOW() - interval '1 day'),
        ($1, '1.0.0', $2, $3, NULL, 'r2', false, 1, NOW())
      RETURNING id, name`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number, name: string }>
    const realVersionId = versionRows.find(row => row.name === '2.0.0')!.id
    const demoVersionId = versionRows.find(row => row.name === '1.0.0')!.id
    await track(appId, RELATIONS.appVersions, [demoVersionId], seedId)

    const manifestRows = await executeSQL(
      `INSERT INTO public.manifest (
        app_version_id,
        file_name,
        s3_path,
        file_hash,
        file_size
      ) VALUES
        ($1, 'index.html', 'orgs/real/index.html', 'real-hash', 100),
        ($2, 'index.html', $3, 'demo-hash', 100)
      RETURNING id, s3_path`,
      [realVersionId, demoVersionId, `demo/${appId}/1.0.0/index.html`],
    ) as Array<{ id: number, s3_path: string }>
    await track(appId, RELATIONS.manifest, [manifestRows.find(row => row.s3_path.startsWith('demo/'))!.id], seedId)

    const channelRows = await executeSQL(
      `INSERT INTO public.channels (
        name,
        app_id,
        version,
        public,
        ios,
        android,
        electron,
        allow_device_self_set,
        allow_emulator,
        allow_device,
        allow_dev,
        allow_prod,
        created_by,
        owner_org
      ) VALUES
        ('real-channel', $1, $2, false, true, true, true, false, true, true, true, true, $3, $4),
        ('demo-channel', $1, $5, false, true, true, true, false, true, true, true, true, $3, $4)
      RETURNING id, name`,
      [appId, realVersionId, USER_ID, ORG_ID, demoVersionId],
    ) as Array<{ id: number, name: string }>
    const realChannelId = channelRows.find(row => row.name === 'real-channel')!.id
    const demoChannelId = channelRows.find(row => row.name === 'demo-channel')!.id
    await track(appId, RELATIONS.channels, [demoChannelId], seedId)

    const channelDeviceRows = await executeSQL(
      `INSERT INTO public.channel_devices (
        channel_id,
        app_id,
        device_id,
        owner_org
      ) VALUES
        ($1, $2, $3, $5),
        ($4, $2, $6, $5)
      RETURNING id, device_id`,
      [realChannelId, appId, `real-${randomUUID()}`, demoChannelId, ORG_ID, `demo-${randomUUID()}`],
    ) as Array<{ id: number, device_id: string }>
    await track(appId, RELATIONS.channelDevices, [channelDeviceRows.find(row => row.device_id.startsWith('demo-'))!.id], seedId)

    const deployRows = await executeSQL(
      `INSERT INTO public.deploy_history (
        channel_id,
        app_id,
        version_id,
        created_by,
        owner_org
      ) VALUES
        ($1, $2, $3, $5, $6),
        ($4, $2, $7, $5, $6)
      RETURNING id, version_id`,
      [realChannelId, appId, realVersionId, demoChannelId, USER_ID, ORG_ID, demoVersionId],
    ) as Array<{ id: number, version_id: number }>
    await track(appId, RELATIONS.deployHistory, [deployRows.find(row => row.version_id === demoVersionId)!.id], seedId)

    const deviceRows = await executeSQL(
      `INSERT INTO public.devices (
        updated_at,
        device_id,
        version,
        app_id,
        platform,
        plugin_version,
        os_version,
        version_build,
        is_prod,
        is_emulator,
        version_name
      ) VALUES
        (NOW(), $1, $2, $3, 'ios', '6.0.0', '17.0', '2', true, false, '2.0.0'),
        (NOW(), $4, $5, $3, 'android', '6.0.0', '14', '1', true, false, '1.0.0'),
        (NOW(), $6, $5, $3, 'ios', '6.0.0', '17.0', '1', true, false, '1.0.0')
      RETURNING id, device_id, version_name`,
      [`real-${randomUUID()}`, realVersionId, appId, `demo-${randomUUID()}`, demoVersionId, `real-on-demo-version-${randomUUID()}`],
    ) as Array<{ id: number, device_id: string, version_name: string }>
    await track(appId, RELATIONS.devices, [deviceRows.find(row => row.device_id.startsWith('demo-'))!.id], seedId)

    await executeSQL(
      `INSERT INTO public.daily_mau (app_id, date, mau) VALUES
        ($1, $2, 10),
        ($1, $3, 3)`,
      [appId, realDate, demoDate],
    )

    await executeSQL(
      `INSERT INTO public.daily_bandwidth (app_id, date, bandwidth) VALUES
        ($1, $2, 1000),
        ($1, $3, 200)`,
      [appId, realDate, demoDate],
    )

    await executeSQL(
      `INSERT INTO public.daily_storage (app_id, date, storage) VALUES
        ($1, $2, 1000),
        ($1, $3, 200)`,
      [appId, realDate, demoDate],
    )

    await executeSQL(
      `INSERT INTO public.daily_version (
        app_id,
        date,
        version_id,
        version_name,
        get,
        fail,
        install,
        uninstall
      ) VALUES
        ($1, $2, $3, '2.0.0', 10, 0, 9, 0),
        ($1, $4, $5, '1.0.0', 4, 0, 3, 0)`,
      [appId, realDate, realVersionId, demoDate, demoVersionId],
    )

    await executeSQL(
      `INSERT INTO public.version_usage (
        app_id,
        version_id,
        action,
        version_name
      ) VALUES (
        $1,
        $2,
        'get',
        '1.0.0'
      )`,
      [appId, demoVersionId],
    )

    const buildRows = await executeSQL(
      `INSERT INTO public.build_requests (
        app_id,
        owner_org,
        requested_by,
        platform,
        status,
        upload_session_key,
        upload_path,
        upload_url,
        upload_expires_at
      ) VALUES
        ($1, $2, $3, 'ios', 'succeeded', $4, 'builds/real', 'https://example.com/real', NOW() + interval '1 day'),
        ($1, $2, $3, 'android', 'succeeded', $5, 'builds/demo', 'https://example.com/demo', NOW() + interval '1 day')
      RETURNING id, upload_path`,
      [appId, ORG_ID, USER_ID, `real-${randomUUID()}`, `demo-${randomUUID()}`],
    ) as Array<{ id: string, upload_path: string }>
    await track(appId, RELATIONS.buildRequests, [buildRows.find(row => row.upload_path === 'builds/demo')!.id], seedId)

    await executeSQL('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [appUuid])

    const [state] = await executeSQL(
      `SELECT
        EXISTS (SELECT 1 FROM public.app_versions WHERE app_id = $1 AND name = '2.0.0') AS real_version_exists,
        EXISTS (SELECT 1 FROM public.app_versions WHERE app_id = $1 AND name = '1.0.0') AS demo_version_exists,
        EXISTS (SELECT 1 FROM public.channels WHERE app_id = $1 AND name = 'real-channel') AS real_channel_exists,
        EXISTS (SELECT 1 FROM public.channels WHERE app_id = $1 AND name = 'demo-channel') AS demo_channel_exists,
        EXISTS (SELECT 1 FROM public.devices WHERE app_id = $1 AND version_name = '2.0.0') AS real_device_exists,
        EXISTS (SELECT 1 FROM public.devices WHERE app_id = $1 AND device_id LIKE 'demo-%') AS demo_device_exists,
        EXISTS (SELECT 1 FROM public.devices WHERE app_id = $1 AND device_id LIKE 'real-on-demo-version-%') AS real_device_on_demo_version_exists,
        EXISTS (SELECT 1 FROM public.devices WHERE app_id = $1 AND device_id LIKE 'real-on-demo-version-%' AND version IS NULL) AS real_device_version_was_nulled,
        EXISTS (SELECT 1 FROM public.daily_mau WHERE app_id = $1 AND date = $2::date) AS real_mau_exists,
        EXISTS (SELECT 1 FROM public.daily_mau WHERE app_id = $1 AND date = $3::date) AS demo_mau_exists,
        EXISTS (SELECT 1 FROM public.daily_version WHERE app_id = $1 AND date = $3::date AND version_name = '1.0.0') AS demo_daily_version_exists,
        EXISTS (SELECT 1 FROM public.daily_version WHERE app_id = $1 AND date = $3::date AND version_name = '1.0.0' AND version_id IS NULL) AS demo_daily_version_id_was_nulled,
        EXISTS (SELECT 1 FROM public.version_usage WHERE app_id = $1 AND version_name = '1.0.0') AS demo_version_usage_exists,
        EXISTS (SELECT 1 FROM public.version_usage WHERE app_id = $1 AND version_name = '1.0.0' AND version_id IS NULL) AS demo_version_usage_id_was_nulled,
        EXISTS (SELECT 1 FROM public.build_requests WHERE app_id = $1 AND upload_path = 'builds/real') AS real_build_exists,
        EXISTS (SELECT 1 FROM public.build_requests WHERE app_id = $1 AND upload_path = 'builds/demo') AS demo_build_exists,
        (SELECT COUNT(*)::int FROM public.onboarding_demo_data WHERE app_id = $1) AS tracked_rows,
        (SELECT last_version FROM public.apps WHERE app_id = $1) AS last_version,
        (SELECT manifest_bundle_count FROM public.apps WHERE app_id = $1) AS manifest_bundle_count,
        (SELECT channel_device_count FROM public.apps WHERE app_id = $1) AS channel_device_count`,
      [appId, realDate, demoDate],
    ) as Array<{
      real_version_exists: boolean
      demo_version_exists: boolean
      real_channel_exists: boolean
      demo_channel_exists: boolean
      real_device_exists: boolean
      demo_device_exists: boolean
      real_device_on_demo_version_exists: boolean
      real_device_version_was_nulled: boolean
      real_mau_exists: boolean
      demo_mau_exists: boolean
      demo_daily_version_exists: boolean
      demo_daily_version_id_was_nulled: boolean
      demo_version_usage_exists: boolean
      demo_version_usage_id_was_nulled: boolean
      real_build_exists: boolean
      demo_build_exists: boolean
      tracked_rows: number
      last_version: string | null
      manifest_bundle_count: string
      channel_device_count: string
    }>

    expect(state.real_version_exists).toBe(true)
    expect(state.demo_version_exists).toBe(false)
    expect(state.real_channel_exists).toBe(true)
    expect(state.demo_channel_exists).toBe(false)
    expect(state.real_device_exists).toBe(true)
    expect(state.demo_device_exists).toBe(false)
    expect(state.real_device_on_demo_version_exists).toBe(true)
    expect(state.real_device_version_was_nulled).toBe(true)
    expect(state.real_mau_exists).toBe(true)
    expect(state.demo_mau_exists).toBe(true)
    expect(state.demo_daily_version_exists).toBe(true)
    expect(state.demo_daily_version_id_was_nulled).toBe(true)
    expect(state.demo_version_usage_exists).toBe(true)
    expect(state.demo_version_usage_id_was_nulled).toBe(true)
    expect(state.real_build_exists).toBe(true)
    expect(state.demo_build_exists).toBe(false)
    expect(state.tracked_rows).toBe(0)
    expect(state.last_version).toBe('2.0.0')
    expect(Number(state.manifest_bundle_count)).toBe(1)
    expect(Number(state.channel_device_count)).toBe(1)
  })

  it.concurrent('refuses to delete tracked demo versions with non-nullable version metrics', async () => {
    const appId = testAppId('version-meta')
    const appUuid = await createPendingApp(appId)
    const seedId = randomUUID()

    const [version] = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        storage_provider,
        deleted
      ) VALUES (
        $1,
        '1.0.0',
        $2,
        $3,
        'r2',
        false
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number }>
    await track(appId, RELATIONS.appVersions, [version.id], seedId)

    await executeSQL(
      `INSERT INTO public.version_meta (
        app_id,
        version_id,
        size
      ) VALUES (
        $1,
        $2,
        123
      )`,
      [appId, version.id],
    )

    await expect(
      executeSQL('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [appUuid]),
    ).rejects.toThrow(/non-nullable version metrics/)

    const [state] = await executeSQL(
      `SELECT
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $1) AS version_exists,
        EXISTS (SELECT 1 FROM public.version_meta WHERE app_id = $2 AND version_id = $1) AS version_meta_exists,
        (SELECT COUNT(*)::int FROM public.onboarding_demo_data WHERE app_id = $2) AS tracked_rows`,
      [version.id, appId],
    ) as Array<{
      version_exists: boolean
      version_meta_exists: boolean
      tracked_rows: number
    }>

    expect(state.version_exists).toBe(true)
    expect(state.version_meta_exists).toBe(true)
    expect(state.tracked_rows).toBe(1)
  })

  it.concurrent('refuses to cascade from tracked demo versions into untracked channels', async () => {
    const appId = testAppId('guard')
    const appUuid = await createPendingApp(appId)
    const seedId = randomUUID()

    const [demoVersion] = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        storage_provider,
        deleted,
        manifest_count
      ) VALUES (
        $1,
        '1.0.0',
        $2,
        $3,
        'r2',
        false,
        0
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number }>
    await track(appId, RELATIONS.appVersions, [demoVersion.id], seedId)

    await executeSQL(
      `INSERT INTO public.channels (
        name,
        app_id,
        version,
        public,
        ios,
        android,
        electron,
        allow_device_self_set,
        allow_emulator,
        allow_device,
        allow_dev,
        allow_prod,
        created_by,
        owner_org
      ) VALUES (
        'user-channel',
        $1,
        $2,
        false,
        true,
        true,
        true,
        false,
        true,
        true,
        true,
        true,
        $3,
        $4
      )`,
      [appId, demoVersion.id, USER_ID, ORG_ID],
    )

    await expect(executeSQL('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [appUuid]))
      .rejects
      .toThrow(/untracked channels/)

    const [state] = await executeSQL(
      `SELECT
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $1) AS version_exists,
        EXISTS (SELECT 1 FROM public.channels WHERE app_id = $2 AND name = 'user-channel') AS channel_exists,
        (SELECT COUNT(*)::int FROM public.onboarding_demo_data WHERE app_id = $2) AS tracked_rows`,
      [demoVersion.id, appId],
    ) as Array<{ version_exists: boolean, channel_exists: boolean, tracked_rows: number }>

    expect(state.version_exists).toBe(true)
    expect(state.channel_exists).toBe(true)
    expect(state.tracked_rows).toBe(1)
  })

  it.concurrent('claims and resets clean legacy demo rows from hard demo markers', async () => {
    const appId = testAppId('legacy-clean')
    const appUuid = await createPendingApp(appId)

    const [legacyVersion] = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        storage_provider,
        deleted,
        manifest_count
      ) VALUES (
        $1,
        '1.0.0',
        $2,
        $3,
        'r2',
        false,
        1
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number }>

    const [manifest] = await executeSQL(
      `INSERT INTO public.manifest (
        app_version_id,
        file_name,
        s3_path,
        file_hash,
        file_size
      ) VALUES (
        $1,
        'index.html',
        $2,
        'demo-hash',
        100
      )
      RETURNING id`,
      [legacyVersion.id, `demo/${appId}/1.0.0/index.html`],
    ) as Array<{ id: number }>

    const buildJobId = `demo-job-${appId}`
    const buildSessionKey = `demo-session-${appId}`

    const [build] = await executeSQL(
      `INSERT INTO public.build_requests (
        app_id,
        owner_org,
        requested_by,
        platform,
        status,
        build_config,
        builder_job_id,
        upload_session_key,
        upload_path,
        upload_url,
        upload_expires_at
      ) VALUES (
        $1,
        $2,
        $3,
        'ios',
        'succeeded',
        jsonb_build_object('version', '1.0.0', 'bundleId', $6::text),
        $7,
        $8,
        $4,
        $5,
        NOW() + interval '1 day'
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID, `builds/${appId}/ios/1.0.0`, `https://demo-builds.example.com/${appId}/ios/1.0.0`, appId, buildJobId, buildSessionKey],
    ) as Array<{ id: string }>

    await executeSQL('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [appUuid])

    const [state] = await executeSQL(
      `SELECT
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $1) AS legacy_version_exists,
        EXISTS (SELECT 1 FROM public.manifest WHERE id = $2) AS legacy_manifest_exists,
        EXISTS (SELECT 1 FROM public.build_requests WHERE id = $3::uuid) AS legacy_build_exists,
        (SELECT COUNT(*)::int FROM public.onboarding_demo_data WHERE app_id = $4) AS tracked_rows`,
      [legacyVersion.id, manifest.id, build.id, appId],
    ) as Array<{
      legacy_version_exists: boolean
      legacy_manifest_exists: boolean
      legacy_build_exists: boolean
      tracked_rows: number
    }>

    expect(state.legacy_version_exists).toBe(false)
    expect(state.legacy_manifest_exists).toBe(false)
    expect(state.legacy_build_exists).toBe(false)
    expect(state.tracked_rows).toBe(0)
  })

  it.concurrent('does not claim legacy demo versions by name when real rows are present', async () => {
    const appId = testAppId('legacy-mixed')
    const appUuid = await createPendingApp(appId)

    const versions = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        storage_provider,
        deleted,
        manifest_count
      ) VALUES
        ($1, '1.0.0', $2, $3, 'r2', false, 1),
        ($1, '2.0.0', $2, $3, 'r2', false, 1)
      RETURNING id, name`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number, name: string }>
    const legacyNamedVersionId = versions.find(row => row.name === '1.0.0')!.id
    const realVersionId = versions.find(row => row.name === '2.0.0')!.id

    const [manifest] = await executeSQL(
      `INSERT INTO public.manifest (
        app_version_id,
        file_name,
        s3_path,
        file_hash,
        file_size
      ) VALUES (
        $1,
        'index.html',
        $2,
        'demo-hash',
        100
      )
      RETURNING id`,
      [legacyNamedVersionId, `demo/${appId}/1.0.0/index.html`],
    ) as Array<{ id: number }>

    const buildJobId = `demo-job-${appId}`
    const buildSessionKey = `demo-session-${appId}`

    const [build] = await executeSQL(
      `INSERT INTO public.build_requests (
        app_id,
        owner_org,
        requested_by,
        platform,
        status,
        build_config,
        builder_job_id,
        upload_session_key,
        upload_path,
        upload_url,
        upload_expires_at
      ) VALUES (
        $1,
        $2,
        $3,
        'ios',
        'succeeded',
        jsonb_build_object('version', '1.0.0', 'bundleId', $6::text),
        $7,
        $8,
        $4,
        $5,
        NOW() + interval '1 day'
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID, `builds/${appId}/ios/1.0.0`, `https://demo-builds.example.com/${appId}/ios/1.0.0`, appId, buildJobId, buildSessionKey],
    ) as Array<{ id: string }>

    await executeSQL('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [appUuid])

    const [state] = await executeSQL(
      `SELECT
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $1) AS legacy_named_version_exists,
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $2) AS real_version_exists,
        EXISTS (SELECT 1 FROM public.manifest WHERE id = $3) AS legacy_manifest_exists,
        EXISTS (SELECT 1 FROM public.build_requests WHERE id = $4::uuid) AS legacy_build_exists`,
      [legacyNamedVersionId, realVersionId, manifest.id, build.id],
    ) as Array<{
      legacy_named_version_exists: boolean
      real_version_exists: boolean
      legacy_manifest_exists: boolean
      legacy_build_exists: boolean
    }>

    expect(state.legacy_named_version_exists).toBe(true)
    expect(state.real_version_exists).toBe(true)
    expect(state.legacy_manifest_exists).toBe(false)
    expect(state.legacy_build_exists).toBe(false)
  })

  it.concurrent('lets onboarding completion clear only tracked demo rows', async () => {
    const appId = testAppId('complete')
    const appUuid = await createPendingApp(appId)
    const seedId = randomUUID()

    const [demoVersion] = await executeSQL(
      `INSERT INTO public.app_versions (
        app_id,
        name,
        owner_org,
        user_id,
        storage_provider,
        deleted,
        manifest_count
      ) VALUES (
        $1,
        '1.0.0',
        $2,
        $3,
        'r2',
        false,
        0
      )
      RETURNING id`,
      [appId, ORG_ID, USER_ID],
    ) as Array<{ id: number }>
    await track(appId, RELATIONS.appVersions, [demoVersion.id], seedId)

    await executeSQL(
      `UPDATE public.apps
       SET need_onboarding = false
       WHERE id = $1::uuid`,
      [appUuid],
    )

    const [state] = await executeSQL(
      `SELECT
        (SELECT need_onboarding FROM public.apps WHERE id = $1::uuid) AS need_onboarding,
        EXISTS (SELECT 1 FROM public.app_versions WHERE id = $2) AS demo_version_exists,
        (SELECT COUNT(*)::int FROM public.onboarding_demo_data WHERE app_id = $3) AS tracked_rows`,
      [appUuid, demoVersion.id, appId],
    ) as Array<{ need_onboarding: boolean, demo_version_exists: boolean, tracked_rows: number }>

    expect(state.need_onboarding).toBe(false)
    expect(state.demo_version_exists).toBe(false)
    expect(state.tracked_rows).toBe(0)
  })

  it.concurrent('keeps demo reset RPCs service-role only', async () => {
    const [row] = await executeSQL(
      `SELECT
        has_function_privilege('service_role', 'public.reset_onboarding_demo_app_data(uuid)', 'EXECUTE') AS reset_service_role,
        has_function_privilege('anon', 'public.reset_onboarding_demo_app_data(uuid)', 'EXECUTE') AS reset_anon,
        has_function_privilege('authenticated', 'public.reset_onboarding_demo_app_data(uuid)', 'EXECUTE') AS reset_authenticated,
        has_function_privilege('service_role', 'public.track_onboarding_demo_data(text, uuid, text, text[], uuid)', 'EXECUTE') AS track_service_role,
        has_function_privilege('anon', 'public.track_onboarding_demo_data(text, uuid, text, text[], uuid)', 'EXECUTE') AS track_anon,
        has_function_privilege('authenticated', 'public.track_onboarding_demo_data(text, uuid, text, text[], uuid)', 'EXECUTE') AS track_authenticated,
        has_function_privilege('service_role', 'public.claim_legacy_onboarding_demo_data(uuid)', 'EXECUTE') AS claim_service_role,
        has_function_privilege('anon', 'public.claim_legacy_onboarding_demo_data(uuid)', 'EXECUTE') AS claim_anon,
        has_function_privilege('authenticated', 'public.claim_legacy_onboarding_demo_data(uuid)', 'EXECUTE') AS claim_authenticated`,
    ) as Array<{
      reset_service_role: boolean
      reset_anon: boolean
      reset_authenticated: boolean
      track_service_role: boolean
      track_anon: boolean
      track_authenticated: boolean
      claim_service_role: boolean
      claim_anon: boolean
      claim_authenticated: boolean
    }>

    expect(row.reset_service_role).toBe(true)
    expect(row.reset_anon).toBe(false)
    expect(row.reset_authenticated).toBe(false)
    expect(row.track_service_role).toBe(true)
    expect(row.track_anon).toBe(false)
    expect(row.track_authenticated).toBe(false)
    expect(row.claim_service_role).toBe(true)
    expect(row.claim_anon).toBe(false)
    expect(row.claim_authenticated).toBe(false)
  })
})
