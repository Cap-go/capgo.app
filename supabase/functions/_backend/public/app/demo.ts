import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { lockOnboardingApp, unlockOnboardingApp } from '../../utils/demo.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'

/** Request body for creating a demo app */
export interface CreateDemoApp {
  owner_org: string
  app_id?: string
}

/** Demo version configuration */
interface DemoVersion {
  name: string
  daysAgo: number
  comment?: string
  link?: string
}

/** Native package structure for demo apps */
interface DemoNativePackage {
  name: string
  version: string
}

/** Manifest entry for demo apps */
interface DemoManifestEntry {
  file_name: string
  s3_path: string
  file_hash: string
  file_size: number
}

const DEMO_CAPGO_UPDATER_VERSION = '8.47.3'

/**
 * Generate demo native packages (Capacitor plugins)
 * @param versionName - Version name to base the package versions on
 * @returns Array of native packages
 */
function getDemoNativePackages(versionName: string): DemoNativePackage[] {
  // Base packages that evolve with app versions
  const basePackages: DemoNativePackage[] = [
    { name: '@capacitor/core', version: '8.3.4' },
    { name: '@capacitor/app', version: '8.1.0' },
    { name: '@capacitor/haptics', version: '8.0.2' },
    { name: '@capacitor/keyboard', version: '8.0.3' },
    { name: '@capacitor/status-bar', version: '8.0.2' },
    { name: '@capgo/capacitor-updater', version: DEMO_CAPGO_UPDATER_VERSION },
  ]

  // Add more plugins in later versions
  if (versionName >= '1.1.0') {
    basePackages.push({ name: '@capacitor/push-notifications', version: '8.1.1' })
    basePackages.push({ name: '@capacitor/local-notifications', version: '8.2.0' })
  }

  if (versionName >= '1.2.0') {
    basePackages.push({ name: '@capacitor/camera', version: '8.2.0' })
    basePackages.push({ name: '@capacitor/filesystem', version: '8.1.2' })
  }

  return basePackages
}

/**
 * SHA256 hashes and sizes for demo files.
 * These demonstrate the differential update feature:
 * - STABLE files: Same hash across all versions (vendor.js, polyfills.js, static assets)
 *   These don't need to be re-downloaded when updating
 * - CHANGING files: Different hash per version (main.js, index.html, styles.css)
 *   These are the files that get downloaded during an update
 *
 * Format: Real SHA256 hashes (64 hex characters)
 */
const DEMO_FILE_HASHES = {
  // Files that NEVER change between versions (third-party libs, static assets)
  // When comparing versions, these show as "unchanged" - no download needed
  stable: {
    'vendor.js': { hash: 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456', size: 847293 }, // ~827KB - large vendor bundle
    'polyfills.js': { hash: 'b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567a', size: 124567 }, // ~122KB
    'assets/logo.png': { hash: 'c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567ab1', size: 45234 }, // ~44KB
    'assets/icon.svg': { hash: 'd4e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12c', size: 2847 }, // ~2.8KB
  },

  // Files that CHANGE with each version (app code, styles)
  // When comparing versions, these show as "modified" - need download
  changing: {
    'index.html': {
      size: 4523, // ~4.4KB
      versions: {
        '1.0.0': 'e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1',
        '1.0.1': 'e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd2',
        '1.1.0': 'e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd3',
        '1.1.1': 'e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd4',
        '1.2.0': 'e5f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd5',
      },
    },
    'main.js': {
      size: 523847, // ~512KB - main application bundle
      versions: {
        '1.0.0': 'f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e1',
        '1.0.1': 'f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2',
        '1.1.0': 'f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e3',
        '1.1.1': 'f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e4',
        '1.2.0': 'f6789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e5',
      },
    },
    'styles.css': {
      size: 87234, // ~85KB
      versions: {
        '1.0.0': '789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f1',
        '1.0.1': '789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f1', // Same as 1.0.0 (hotfix didn't change styles)
        '1.1.0': '789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f2', // Changed in 1.1.0
        '1.1.1': '789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f2', // Same as 1.1.0
        '1.2.0': '789012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f3', // Changed in 1.2.0
      },
    },
  },

  // Files added in specific versions (new features)
  added: {
    'assets/dark-theme.css': {
      minVersion: '1.1.0',
      hash: '89012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f3a',
      size: 23456, // ~23KB
    },
    'assets/dashboard.js': {
      minVersion: '1.2.0',
      hash: '9012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f3ab',
      size: 156234, // ~153KB
    },
    'assets/charts.js': {
      minVersion: '1.2.0',
      hash: '012345678901234567890abcdef1234567890abcdef1234567ab12cd1e2f3abc',
      size: 98765, // ~96KB
    },
  },
} as const

/**
 * Generate demo manifest entries (files in the bundle)
 * Demonstrates differential updates:
 * - Stable files have same hash across versions (no re-download needed)
 * - Changing files have different hashes (will be downloaded on update)
 * - New files are only present in versions >= their minVersion
 *
 * @param versionName - Version name
 * @param appId - App ID for generating s3 paths
 * @returns Array of manifest entries with SHA256 hashes
 */
function getDemoManifest(versionName: string, appId: string): DemoManifestEntry[] {
  const entries: DemoManifestEntry[] = []

  // Add stable files (same hash for all versions - no update needed)
  for (const [fileName, fileInfo] of Object.entries(DEMO_FILE_HASHES.stable)) {
    entries.push({
      file_name: fileName,
      s3_path: `demo/${appId}/${versionName}/${fileName}`,
      file_hash: fileInfo.hash,
      file_size: fileInfo.size,
    })
  }

  // Add changing files (different hash per version - will be updated)
  for (const [fileName, fileConfig] of Object.entries(DEMO_FILE_HASHES.changing)) {
    const hash = fileConfig.versions[versionName as keyof typeof fileConfig.versions]
    if (hash) {
      entries.push({
        file_name: fileName,
        s3_path: `demo/${appId}/${versionName}/${fileName}`,
        file_hash: hash,
        file_size: fileConfig.size,
      })
    }
  }

  // Add files that were introduced in specific versions
  for (const [fileName, config] of Object.entries(DEMO_FILE_HASHES.added)) {
    if (versionName >= config.minVersion) {
      entries.push({
        file_name: fileName,
        s3_path: `demo/${appId}/${versionName}/${fileName}`,
        file_hash: config.hash,
        file_size: config.size,
      })
    }
  }

  return entries
}

/** Demo channel configuration */
interface DemoChannel {
  name: string
  public: boolean
  allowDeviceSelfSet?: boolean
}

/**
 * Generate past dates for demo data
 * @param daysAgo - Number of days in the past
 * @returns ISO date string
 */
function daysAgoDate(daysAgo: number): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString()
}

/**
 * Generate a random device ID
 * @returns UUID-like device ID
 */
function generateDeviceId(): string {
  return crypto.randomUUID()
}

type PgClient = ReturnType<typeof getPgClient>

interface SeedDemoAppDataOptions {
  appUuid: string
  appId: string
  ownerOrg: string
  seedId: string
  userId: string
  appVersions: Array<Record<string, unknown>>
  manifestRows: Array<Record<string, unknown>>
  channelRows: Array<Record<string, unknown>>
  deployRows: Array<Record<string, unknown>>
  deviceRows: Array<Record<string, unknown>>
  dailyMauRows: Array<Record<string, unknown>>
  dailyBandwidthRows: Array<Record<string, unknown>>
  dailyStorageRows: Array<Record<string, unknown>>
  dailyVersionRows: Array<Record<string, unknown>>
  buildRows: Array<Record<string, unknown>>
}

async function trackOnboardingDemoRowsInTransaction(
  pgClient: PgClient,
  appId: string,
  ownerOrg: string,
  relationName: string,
  rowKeys: Array<string | number>,
  seedId: string,
): Promise<void> {
  if (rowKeys.length === 0)
    return

  await pgClient.query(
    'SELECT public.track_onboarding_demo_data($1::text, $2::uuid, $3::text, $4::text[], $5::uuid)',
    [appId, ownerOrg, relationName, rowKeys.map(String), seedId],
  )
}

function assertRecognizedRows(
  relationName: string,
  rows: Array<{ name?: string, id: string | number, is_demo_shape?: boolean }>,
  expectedCount: number,
): void {
  const unrecognizedRows = rows.filter(row => row.is_demo_shape === false)
  if (rows.length !== expectedCount || unrecognizedRows.length > 0) {
    throw new Error(`${relationName} has existing rows that do not match the onboarding demo seed: ${unrecognizedRows.map(row => row.name ?? row.id).join(', ')}`)
  }
}

async function seedOnboardingDemoDataInTransaction(
  c: Context<MiddlewareKeyVariables>,
  options: SeedDemoAppDataOptions,
): Promise<void> {
  const pgClient = getPgClient(c)
  let shouldRollback = false

  try {
    await pgClient.query('BEGIN')
    shouldRollback = true

    await pgClient.query('SELECT public.reset_onboarding_demo_app_data($1::uuid)', [options.appUuid])

    const versionResult = await pgClient.query<{ id: number, name: string, is_demo_shape: boolean }>(
      `WITH raw_input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS version_data(
          name text,
          created_at timestamptz,
          comment text,
          link text,
          manifest_count int,
          manifest jsonb,
          native_packages jsonb
        )
      ),
      input AS (
        SELECT
          raw_input.name,
          raw_input.created_at,
          raw_input.comment,
          raw_input.link,
          raw_input.manifest_count,
          ARRAY(
            SELECT ROW(manifest_entry.file_name, manifest_entry.s3_path, manifest_entry.file_hash)::public.manifest_entry
            FROM jsonb_to_recordset(raw_input.manifest) AS manifest_entry(
              file_name text,
              s3_path text,
              file_hash text
            )
          ) AS manifest,
          ARRAY(
            SELECT native_package.value::jsonb
            FROM jsonb_array_elements(raw_input.native_packages) AS native_package(value)
          ) AS native_packages
        FROM raw_input
      ),
      inserted AS (
        INSERT INTO public.app_versions (
          owner_org,
          deleted,
          name,
          app_id,
          created_at,
          comment,
          link,
          user_id,
          manifest,
          manifest_count,
          native_packages
        )
        SELECT
          $2::uuid,
          false,
          input.name,
          $3::text,
          input.created_at,
          input.comment,
          input.link,
          $4::uuid,
          input.manifest,
          input.manifest_count,
          input.native_packages
        FROM input
        ON CONFLICT (name, app_id) DO NOTHING
        RETURNING id, name
      )
      SELECT
        app_versions.id,
        app_versions.name,
        (
          app_versions.owner_org = $2::uuid
          AND app_versions.user_id = $4::uuid
          AND app_versions.deleted IS FALSE
          AND app_versions.storage_provider = 'r2'
          AND app_versions.r2_path IS NULL
          AND app_versions.checksum IS NULL
          AND app_versions.session_key IS NULL
          AND app_versions.external_url IS NULL
          AND app_versions.comment IS NOT DISTINCT FROM input.comment
          AND app_versions.link IS NOT DISTINCT FROM input.link
          AND app_versions.manifest_count = input.manifest_count
        ) AS is_demo_shape
      FROM input
      INNER JOIN public.app_versions
        ON app_versions.app_id = $3::text
        AND app_versions.name = input.name
      ORDER BY input.name`,
      [JSON.stringify(options.appVersions), options.ownerOrg, options.appId, options.userId],
    )

    assertRecognizedRows('app_versions', versionResult.rows, options.appVersions.length)
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'app_versions',
      versionResult.rows.map(row => row.id),
      options.seedId,
    )

    const manifestResult = await pgClient.query<{ id: number }>(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS manifest_data(
          version_name text,
          file_name text,
          s3_path text,
          file_hash text,
          file_size bigint
        )
      )
      INSERT INTO public.manifest (
        app_version_id,
        file_name,
        s3_path,
        file_hash,
        file_size
      )
      SELECT
        app_versions.id,
        input.file_name,
        input.s3_path,
        input.file_hash,
        input.file_size
      FROM input
      INNER JOIN public.app_versions
        ON app_versions.app_id = $2::text
        AND app_versions.name = input.version_name
      RETURNING id`,
      [JSON.stringify(options.manifestRows), options.appId],
    )
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'manifest',
      manifestResult.rows.map(row => row.id),
      options.seedId,
    )

    const channelResult = await pgClient.query<{ id: number, name: string, is_demo_shape: boolean }>(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS channel_data(
          name text,
          public boolean,
          allow_device_self_set boolean,
          version_name text
        )
      ),
      inserted AS (
        INSERT INTO public.channels (
          created_by,
          app_id,
          name,
          public,
          disable_auto_update_under_native,
          disable_auto_update,
          ios,
          android,
          electron,
          allow_device_self_set,
          allow_emulator,
          allow_device,
          allow_dev,
          allow_prod,
          version,
          owner_org
        )
        SELECT
          $2::uuid,
          $3::text,
          input.name,
          input.public,
          true,
          'major'::public.disable_update,
          true,
          true,
          true,
          input.allow_device_self_set,
          true,
          true,
          input.name <> 'production',
          true,
          app_versions.id,
          $4::uuid
        FROM input
        INNER JOIN public.app_versions
          ON app_versions.app_id = $3::text
          AND app_versions.name = input.version_name
        ON CONFLICT DO NOTHING
        RETURNING id, name
      )
      SELECT
        channels.id,
        channels.name,
        (
          channels.created_by = $2::uuid
          AND channels.owner_org = $4::uuid
          AND channels.public = input.public
          AND channels.disable_auto_update_under_native IS TRUE
          AND channels.disable_auto_update = 'major'::public.disable_update
          AND channels.ios IS TRUE
          AND channels.android IS TRUE
          AND channels.electron IS TRUE
          AND channels.allow_device_self_set = input.allow_device_self_set
          AND channels.allow_emulator IS TRUE
          AND channels.allow_device IS TRUE
          AND channels.allow_dev = (input.name <> 'production')
          AND channels.allow_prod IS TRUE
          AND app_versions.name = input.version_name
        ) AS is_demo_shape
      FROM input
      INNER JOIN public.channels
        ON channels.app_id = $3::text
        AND channels.name = input.name
      INNER JOIN public.app_versions
        ON app_versions.id = channels.version
      ORDER BY input.name`,
      [JSON.stringify(options.channelRows), options.userId, options.appId, options.ownerOrg],
    )

    assertRecognizedRows('channels', channelResult.rows, options.channelRows.length)
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'channels',
      channelResult.rows.map(row => row.id),
      options.seedId,
    )

    const deployResult = await pgClient.query<{ id: number }>(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS deploy_data(
          channel_name text,
          version_name text,
          created_at timestamptz,
          deployed_at timestamptz
        )
      )
      INSERT INTO public.deploy_history (
        app_id,
        channel_id,
        version_id,
        created_by,
        owner_org,
        created_at,
        deployed_at
      )
      SELECT
        $2::text,
        channels.id,
        app_versions.id,
        $3::uuid,
        $4::uuid,
        input.created_at,
        input.deployed_at
      FROM input
      INNER JOIN public.channels
        ON channels.app_id = $2::text
        AND channels.name = input.channel_name
      INNER JOIN public.app_versions
        ON app_versions.app_id = $2::text
        AND app_versions.name = input.version_name
      RETURNING id`,
      [JSON.stringify(options.deployRows), options.appId, options.userId, options.ownerOrg],
    )
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'deploy_history',
      deployResult.rows.map(row => row.id),
      options.seedId,
    )

    const deviceResult = await pgClient.query<{ id: number }>(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS device_data(
          device_id text,
          platform text,
          plugin_version text,
          version_name text,
          version_build text,
          os_version text,
          is_emulator boolean,
          is_prod boolean,
          updated_at timestamptz
        )
      )
      INSERT INTO public.devices (
        app_id,
        device_id,
        platform,
        plugin_version,
        version,
        version_name,
        version_build,
        os_version,
        is_emulator,
        is_prod,
        updated_at
      )
      SELECT
        $2::text,
        input.device_id,
        input.platform::public.platform_os,
        input.plugin_version,
        app_versions.id,
        input.version_name,
        input.version_build,
        input.os_version,
        input.is_emulator,
        input.is_prod,
        input.updated_at
      FROM input
      INNER JOIN public.app_versions
        ON app_versions.app_id = $2::text
        AND app_versions.name = input.version_name
      RETURNING id`,
      [JSON.stringify(options.deviceRows), options.appId],
    )
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'devices',
      deviceResult.rows.map(row => row.id),
      options.seedId,
    )

    await pgClient.query(
      `INSERT INTO public.daily_mau (app_id, date, mau)
      SELECT $2::text, date, mau
      FROM jsonb_to_recordset($1::jsonb) AS daily_data(date date, mau bigint)
      ON CONFLICT (app_id, date) DO NOTHING`,
      [JSON.stringify(options.dailyMauRows), options.appId],
    )

    await pgClient.query(
      `INSERT INTO public.daily_bandwidth (app_id, date, bandwidth)
      SELECT $2::text, date, bandwidth
      FROM jsonb_to_recordset($1::jsonb) AS daily_data(date date, bandwidth bigint)
      ON CONFLICT (app_id, date) DO NOTHING`,
      [JSON.stringify(options.dailyBandwidthRows), options.appId],
    )

    await pgClient.query(
      `INSERT INTO public.daily_storage (app_id, date, storage)
      SELECT $2::text, date, storage
      FROM jsonb_to_recordset($1::jsonb) AS daily_data(date date, storage bigint)
      ON CONFLICT (app_id, date) DO NOTHING`,
      [JSON.stringify(options.dailyStorageRows), options.appId],
    )

    await pgClient.query(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS daily_data(
          date date,
          version_name text,
          get bigint,
          install bigint,
          fail bigint,
          uninstall bigint
        )
      )
      INSERT INTO public.daily_version (
        app_id,
        date,
        version_id,
        version_name,
        get,
        install,
        fail,
        uninstall
      )
      SELECT
        $2::text,
        input.date,
        app_versions.id,
        input.version_name,
        input.get,
        input.install,
        input.fail,
        input.uninstall
      FROM input
      INNER JOIN public.app_versions
        ON app_versions.app_id = $2::text
        AND app_versions.name = input.version_name
      ON CONFLICT (app_id, date, version_name) DO NOTHING`,
      [JSON.stringify(options.dailyVersionRows), options.appId],
    )

    const buildResult = await pgClient.query<{ id: string }>(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS build_data(
          id uuid,
          platform text,
          requested_by uuid,
          status text,
          build_mode text,
          build_config jsonb,
          builder_job_id text,
          runner_wait_seconds bigint,
          created_at timestamptz,
          upload_expires_at timestamptz,
          upload_path text,
          upload_session_key text,
          upload_url text
        )
      )
      INSERT INTO public.build_requests (
        id,
        app_id,
        owner_org,
        platform,
        requested_by,
        status,
        build_mode,
        build_config,
        builder_job_id,
        runner_wait_seconds,
        created_at,
        upload_expires_at,
        upload_path,
        upload_session_key,
        upload_url
      )
      SELECT
        input.id,
        $2::text,
        $3::uuid,
        input.platform,
        input.requested_by,
        input.status,
        input.build_mode,
        input.build_config,
        input.builder_job_id,
        input.runner_wait_seconds,
        input.created_at,
        input.upload_expires_at,
        input.upload_path,
        input.upload_session_key,
        input.upload_url
      FROM input
      RETURNING id`,
      [JSON.stringify(options.buildRows), options.appId, options.ownerOrg],
    )
    await trackOnboardingDemoRowsInTransaction(
      pgClient,
      options.appId,
      options.ownerOrg,
      'build_requests',
      buildResult.rows.map(row => row.id),
      options.seedId,
    )

    await pgClient.query('DELETE FROM public.app_metrics_cache WHERE org_id = $1::uuid', [options.ownerOrg])
    await pgClient.query('COMMIT')
  }
  catch (error) {
    if (shouldRollback)
      await pgClient.query('ROLLBACK')

    logPgError(c, 'seedOnboardingDemoDataInTransaction', error)
    throw simpleError('cannot_create_demo_data', 'Cannot create demo data', { error: (error as Error)?.message })
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function getExistingPendingApp(
  c: Context<MiddlewareKeyVariables>,
  supabase: ReturnType<typeof supabaseAdmin>,
  ownerOrg: string,
  appId: string,
) {
  const { data, error } = await supabase
    .from('apps')
    .select('*')
    .eq('owner_org', ownerOrg)
    .eq('app_id', appId)
    .eq('need_onboarding', true)
    .single()

  if (!error && data) {
    return data
  }

  const { data: existingApp, error: existingAppError } = await supabase
    .from('apps')
    .select('id, need_onboarding')
    .eq('owner_org', ownerOrg)
    .eq('app_id', appId)
    .maybeSingle()

  if (!existingAppError && existingApp && existingApp.need_onboarding !== true) {
    cloudlog({ requestId: c.get('requestId'), message: 'Attempted demo seeding on completed app', app_id: appId })
    throw simpleError('app_not_pending_onboarding', 'Cannot seed demo data on an app that already completed onboarding', { app_id: appId })
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Error loading onboarding app', error: error ?? existingAppError, owner_org: ownerOrg, app_id: appId })
  throw simpleError('cannot_find_app', 'Cannot find app for demo onboarding', { owner_org: ownerOrg, app_id: appId })
}

async function getLatestPendingAppForOrg(
  c: Context<MiddlewareKeyVariables>,
  supabase: ReturnType<typeof supabaseAdmin>,
  ownerOrg: string,
) {
  const { data, error } = await supabase
    .from('apps')
    .select('*')
    .eq('owner_org', ownerOrg)
    .eq('need_onboarding', true)
    .order('created_at', { ascending: false })
    .limit(2)

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Error loading pending onboarding app for org', error, owner_org: ownerOrg })
    throw simpleError('cannot_find_app', 'Cannot find app for demo onboarding', { owner_org: ownerOrg })
  }

  const appData = data?.[0]
  if (!appData) {
    throw simpleError('cannot_find_app', 'Cannot find app for demo onboarding', { owner_org: ownerOrg })
  }

  if ((data?.length ?? 0) > 1) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Multiple pending onboarding apps found, using most recent for legacy demo request',
      owner_org: ownerOrg,
      app_id: appData.app_id,
      count: data?.length ?? 0,
    })
  }

  return appData
}

/**
 * Seeds demo data into an already-created onboarding app.
 * The app stays marked by public.apps.need_onboarding = true until the
 * onboarding flow is completed, and is automatically deleted after 14 days if
 * onboarding never completes.
 *
 * This creates a fully populated demo app with:
 * - Multiple versions (1.0.0, 1.0.1, 1.1.0, 1.1.1, 1.2.0)
 * - Multiple channels (production, development, pr-123)
 * - Deploy history showing version deployments
 * - Fake devices across iOS and Android
 * - Chart data (MAU, bandwidth, storage) for the past 14 days
 *
 * @param c - Hono context with middleware key variables
 * @param body - Request body containing owner_org
 * @returns Response with app_id and success message
 */
export async function createDemoApp(c: Context<MiddlewareKeyVariables>, body: CreateDemoApp): Promise<Response> {
  const requestId = c.get('requestId')
  const auth = c.get('auth') as AuthInfo | undefined

  if (!auth?.userId) {
    throw simpleError('not_authenticated', 'Not authenticated')
  }

  if (!body.owner_org) {
    throw simpleError('missing_owner_org', 'Missing owner_org', { body })
  }

  // Check if the user is allowed to create an app in this organization.
  if (!(await checkPermission(c, 'org.create_app', { orgId: body.owner_org }))) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { org_id: body.owner_org })
  }

  const supabase = supabaseAdmin(c)
  const requestedAppId = body.app_id?.trim()
  const resolvedApp = requestedAppId
    ? { app_id: requestedAppId }
    : await getLatestPendingAppForOrg(c, supabase, body.owner_org)
  const lockedAppId = resolvedApp.app_id
  const onboardingLock = await lockOnboardingApp(c, lockedAppId)

  try {
    const appData = await getExistingPendingApp(c, supabase, body.owner_org, lockedAppId)
    if (!appData.id) {
      throw simpleError('cannot_find_app', 'Cannot find app for demo onboarding', { owner_org: body.owner_org, app_id: lockedAppId })
    }
    const appId = appData.app_id
    const demoSeedId = crypto.randomUUID()

    cloudlog({ requestId, message: 'Creating demo app with demo data', appId, owner_org: body.owner_org })

    // RLS bypass needed: Demo app creation inserts into multiple tables (apps, app_versions,
    // channels, devices, daily_mau, daily_bandwidth, daily_storage, daily_version, build_requests,
    // manifest, deploy_history) where RLS policies may not grant direct user insert access.
    // Authorization is enforced at endpoint level via checkPermission above.

    // Create the demo app
    cloudlog({ requestId, message: 'Demo app created', appData })

    // Demo versions to create - simulates app development lifecycle
    const demoVersions: DemoVersion[] = [
      { name: '1.0.0', daysAgo: 13, comment: 'Initial release' },
      { name: '1.0.1', daysAgo: 10, comment: 'Bug fixes for login screen' },
      { name: '1.1.0', daysAgo: 7, comment: 'Added dark mode support' },
      { name: '1.1.1', daysAgo: 4, comment: 'Performance improvements' },
      { name: '1.2.0', daysAgo: 1, comment: 'New dashboard features', link: 'https://github.com/example/demo-app/pull/123' },
    ]

    const appVersionRows = demoVersions.map((v): Record<string, unknown> => {
      const manifest = getDemoManifest(v.name, appId)
      const nativePackages = getDemoNativePackages(v.name)

      return {
        deleted: false,
        name: v.name,
        created_at: daysAgoDate(v.daysAgo),
        comment: v.comment ?? null,
        link: v.link ?? null,
        manifest: manifest?.map(entry => ({
          file_name: entry.file_name,
          s3_path: entry.s3_path,
          file_hash: entry.file_hash,
        })) ?? null,
        manifest_count: manifest?.length ?? 0,
        native_packages: nativePackages ?? null,
      }
    })

    // Insert manifest entries into the manifest table for each version
    // This is required for the bundle file list to show in the UI
    const manifestRows: Array<Record<string, unknown>> = []

    for (const version of demoVersions) {
      const manifestEntries = getDemoManifest(version.name, appId)
      for (const entry of manifestEntries) {
        manifestRows.push({
          version_name: version.name,
          file_name: entry.file_name,
          file_hash: entry.file_hash,
          s3_path: entry.s3_path,
          file_size: entry.file_size,
        })
      }
    }

    // Demo channels configuration
    const demoChannels: DemoChannel[] = [
      { name: 'production', public: true },
      { name: 'development', public: false },
      { name: 'pr-123', public: false, allowDeviceSelfSet: true },
    ]

    // Channel to version mapping
    const channelVersions: Record<string, string> = {
      'production': '1.1.1',
      'development': '1.2.0',
      'pr-123': '1.2.0',
    }

    const channelRows = demoChannels.map(channel => ({
      name: channel.name,
      public: channel.public,
      allow_device_self_set: channel.allowDeviceSelfSet ?? false,
      version_name: channelVersions[channel.name],
    }))

    // Create deploy history to show progression
    const deployHistory: Array<{ channel: string, version: string, daysAgo: number }> = [
      { channel: 'production', version: '1.0.0', daysAgo: 13 },
      { channel: 'development', version: '1.0.1', daysAgo: 10 },
      { channel: 'production', version: '1.0.1', daysAgo: 9 },
      { channel: 'development', version: '1.1.0', daysAgo: 7 },
      { channel: 'production', version: '1.1.0', daysAgo: 6 },
      { channel: 'development', version: '1.1.1', daysAgo: 4 },
      { channel: 'production', version: '1.1.1', daysAgo: 3 },
      { channel: 'pr-123', version: '1.2.0', daysAgo: 1 },
      { channel: 'development', version: '1.2.0', daysAgo: 1 },
    ]

    const deployRows = deployHistory
      .map(d => ({
        channel_name: d.channel,
        version_name: d.version,
        created_at: daysAgoDate(d.daysAgo),
        deployed_at: daysAgoDate(d.daysAgo),
      }))

    // Create fake devices - mix of iOS and Android
    // Note: In production Cloudflare Workers, devices are read from Analytics Engine (DEVICE_INFO)
    // This Supabase data serves as fallback for non-workerd environments (dev, staging, Deno)
    const platforms: Array<Database['public']['Enums']['platform_os']> = ['ios', 'android']
    const deviceRows: Array<Record<string, unknown>> = []
    const generatedDeviceIds: string[] = []

    // Create 8 devices (4 iOS, 4 Android)
    for (let i = 0; i < 8; i++) {
      const platform = platforms[i % 2]
      const deviceId = generateDeviceId()
      generatedDeviceIds.push(deviceId)
      deviceRows.push({
        device_id: deviceId,
        platform,
        plugin_version: DEMO_CAPGO_UPDATER_VERSION,
        version_name: '1.1.1',
        version_build: '1',
        os_version: platform === 'ios' ? '17.0' : '14',
        is_emulator: false,
        is_prod: true,
        updated_at: daysAgoDate(Math.floor(Math.random() * 3)),
      })
    }

    // Create chart data for the past 14 days
    // Insert directly into daily_* tables (which the frontend queries via get_app_metrics RPC)
    // instead of raw *_usage tables (which require cron job aggregation)
    const dailyMauRows: Array<Record<string, unknown>> = []
    const dailyBandwidthRows: Array<Record<string, unknown>> = []
    const dailyStorageRows: Array<Record<string, unknown>> = []
    const dailyVersionRows: Array<Record<string, unknown>> = []

    // Version sizes for storage calculation
    const versionSizes: Record<string, number> = {
      '1.0.0': 4500000,
      '1.0.1': 4600000,
      '1.1.0': 5200000,
      '1.1.1': 5300000,
      '1.2.0': 5800000,
    }

    // Track cumulative storage (versions accumulate over time)
    let cumulativeStorage = 0

    // Version active periods (when each version was in production)
    const versionActivePeriods: Record<string, { startDaysAgo: number, endDaysAgo: number }> = {
      '1.0.0': { startDaysAgo: 13, endDaysAgo: 9 },
      '1.0.1': { startDaysAgo: 9, endDaysAgo: 6 },
      '1.1.0': { startDaysAgo: 6, endDaysAgo: 3 },
      '1.1.1': { startDaysAgo: 3, endDaysAgo: 0 },
      '1.2.0': { startDaysAgo: 1, endDaysAgo: 0 }, // Only in dev/pr channel
    }

    for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
      const date = daysAgoDate(daysAgo).split('T')[0] // Get just the date part (YYYY-MM-DD)

      // MAU: Number of active devices increases over time (simulating user growth)
      const mau = Math.min(generatedDeviceIds.length, 3 + Math.floor((13 - daysAgo) * 0.5))
      dailyMauRows.push({
        date,
        mau,
      })

      // Bandwidth: Downloads per day (varies based on active users)
      const bundleSize = 5500000 // ~5.5MB average bundle
      const downloadsToday = Math.max(1, mau - 1)
      const bandwidth = bundleSize * downloadsToday
      dailyBandwidthRows.push({
        date,
        bandwidth,
      })

      // Storage: Add new version sizes when they're released
      for (const [versionName, size] of Object.entries(versionSizes)) {
        const versionConfig = demoVersions.find(v => v.name === versionName)
        if (versionConfig && versionConfig.daysAgo === daysAgo) {
          cumulativeStorage += size
        }
      }
      // Only add storage entry if we have some storage
      if (cumulativeStorage > 0) {
        dailyStorageRows.push({
          date,
          storage: cumulativeStorage,
        })
      }

      // Version usage: Create aggregated stats for each active version on this day
      for (const [versionName, period] of Object.entries(versionActivePeriods)) {
        if (daysAgo <= period.startDaysAgo && daysAgo >= period.endDaysAgo) {
          // Activity increases as version gets more exposure
          const daysSinceRelease = period.startDaysAgo - daysAgo
          const baseActivity = Math.min(3 + daysSinceRelease, 8)

          const getCount = baseActivity * 2
          const installCount = Math.floor(getCount * 0.8)
          const failCount = Math.max(0, Math.floor(getCount * 0.05))
          const uninstallCount = daysAgo < period.startDaysAgo - 1 ? Math.max(0, Math.floor(installCount * 0.1)) : 0

          dailyVersionRows.push({
            date,
            version_name: versionName,
            get: getCount,
            install: installCount,
            fail: failCount,
            uninstall: uninstallCount,
          })
        }
      }
    }

    // Create fake native builds to showcase the build feature
    // Shows a mix of successful builds and one pending build
    const buildRows: Array<Record<string, unknown>> = []

    // Build configurations for different versions
    const nativeBuilds = [
      { version: '1.0.0', platform: 'ios', daysAgo: 13, status: 'succeeded' },
      { version: '1.0.0', platform: 'android', daysAgo: 13, status: 'succeeded' },
      { version: '1.1.0', platform: 'ios', daysAgo: 7, status: 'succeeded' },
      { version: '1.1.0', platform: 'android', daysAgo: 7, status: 'succeeded' },
      { version: '1.1.1', platform: 'ios', daysAgo: 4, status: 'succeeded' },
      { version: '1.1.1', platform: 'android', daysAgo: 4, status: 'succeeded' },
      { version: '1.2.0', platform: 'ios', daysAgo: 1, status: 'succeeded' },
      { version: '1.2.0', platform: 'android', daysAgo: 0, status: 'pending' }, // One pending build to show UI state
    ]

    for (const build of nativeBuilds) {
      const buildId = crypto.randomUUID()
      const createdAt = daysAgoDate(build.daysAgo)
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // Expires in 24 hours

      buildRows.push({
        id: buildId,
        platform: build.platform,
        requested_by: auth.userId,
        status: build.status,
        build_mode: 'release',
        build_config: {
          version: build.version,
          bundleId: appId,
          buildNumber: build.version.replace(/\./g, ''),
        },
        builder_job_id: build.status === 'succeeded' ? `demo-job-${buildId.slice(0, 8)}` : null,
        runner_wait_seconds: build.status === 'succeeded' ? 20 + build.daysAgo * 3 : 0,
        created_at: createdAt,
        upload_expires_at: expiresAt,
        upload_path: `builds/${appId}/${build.platform}/${build.version}`,
        upload_session_key: `demo-session-${buildId.slice(0, 8)}`,
        upload_url: `https://demo-builds.example.com/${appId}/${build.platform}/${build.version}`,
      })
    }

    await seedOnboardingDemoDataInTransaction(c, {
      appUuid: appData.id,
      appId,
      ownerOrg: body.owner_org,
      seedId: demoSeedId,
      userId: auth.userId,
      appVersions: appVersionRows,
      manifestRows,
      channelRows,
      deployRows,
      deviceRows,
      dailyMauRows,
      dailyBandwidthRows,
      dailyStorageRows,
      dailyVersionRows,
      buildRows,
    })

    cloudlog({
      requestId,
      message: 'Demo seed transaction committed',
      appId,
      versions: appVersionRows.length,
      manifests: manifestRows.length,
      channels: channelRows.length,
      deploys: deployRows.length,
      devices: deviceRows.length,
      builds: buildRows.length,
    })

    cloudlog({ requestId, message: 'Demo app with all demo data created successfully', appId })

    return c.json({
      status: 'ok',
      app_id: appId,
      name: appData.name ?? 'Demo App',
      message: 'Demo app created successfully with sample data. Explore channels, versions, and analytics!',
    })
  }
  finally {
    await unlockOnboardingApp(c, onboardingLock, lockedAppId)
  }
}
