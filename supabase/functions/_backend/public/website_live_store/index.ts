import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Permission } from '../../utils/rbac.ts'
import type { StorePlatform } from '../../utils/website_live_store.ts'
import { z } from 'zod'
import { createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'
import { checkWebsiteLive } from '../../utils/website_live_check.ts'
import {
  androidBuilderCredentials,
  assertStoreBundleId,
  base64ToBytes,
  deleteStoreCredential,
  exportAndroidKeystore,
  fetchTemplateZip,
  fetchWebsiteIcon,
  getIconPreviewUrl,
  getNextWebsiteLiveVersionCode,
  getPublishSecrets,
  getStoreConfig,
  getWebsiteLiveApp,
  iosBuilderCredentials,
  listStoreCredentialSummaries,
  loadIconSet,
  normalizeWebsiteLiveUrl,
  saveAndroidCredentials,
  saveIosCredentials,
  setWebsiteLiveUrl,
  storeIconSet,
  uploadToBuilder,
  upsertStoreConfig,
  WEBSITE_LIVE_BUILD_SOURCE,
  WEBSITE_LIVE_TEMPLATE_VERSION,
  websiteLiveBuildOptions,
} from '../../utils/website_live_store.ts'
import { hasControlCharacters, patchWebsiteLiveTemplate } from '../../utils/website_live_template.ts'
import { assertNativeBuildConcurrencyAvailable } from '../build/concurrency.ts'
import { createNativeBuildRequest, ensureBuildTimePlanAllowed } from '../build/request.ts'
import { markBuildAsFailed, startBuildForRequest } from '../build/start.ts'

export const app = createHono('', version)

app.use('*', useCors)

const MAX_ICON_BASE64_LENGTH = 7 * 1024 * 1024
const MAX_FILE_BASE64_LENGTH = 512 * 1024

const appIdSchema = z.string().trim().min(1).max(50)
const platformSchema = z.enum(['ios', 'android'])
const hexColorSchema = z.string().trim().regex(/^#[0-9a-f]{6}$/i).transform(value => value.toUpperCase())

const configBodySchema = z.object({
  app_id: appIdSchema,
  website_url: z.string().trim().min(1).max(2048).optional(),
  app_name: z.string().trim().min(1).max(30).refine(value => !hasControlCharacters(value), 'app_name has control characters').optional(),
  version_name: z.string().trim().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/).optional(),
  icon_background_color: hexColorSchema.optional(),
  submit_for_review: z.boolean().optional(),
  /** Save the website without the compatibility check. */
  force: z.boolean().optional(),
})

const checkBodySchema = z.object({
  app_id: appIdSchema,
  website_url: z.string().trim().min(1).max(2048).optional(),
})

const iconBodySchema = z.object({
  app_id: appIdSchema,
  image_base64: z.string().min(16).max(MAX_ICON_BASE64_LENGTH).optional(),
  from_website: z.boolean().optional(),
  background_color: hexColorSchema.optional(),
}).refine(body => Boolean(body.image_base64) !== Boolean(body.from_website), 'Send image_base64 or from_website: true')

const iosCredentialsSchema = z.object({
  app_id: appIdSchema,
  platform: z.literal('ios'),
  mode: z.enum(['automatic', 'manual']).default('automatic'),
  asc_key_id: z.string().trim().regex(/^[A-Z0-9]{8,12}$/i),
  asc_issuer_id: z.string().trim().uuid(),
  asc_private_key: z.string().trim().min(100).max(8192).refine(value => value.includes('PRIVATE KEY'), 'asc_private_key must be the .p8 file content'),
  certificate_p12_base64: z.string().min(16).max(MAX_FILE_BASE64_LENGTH).optional(),
  certificate_password: z.string().max(256).optional(),
  provisioning_profile_base64: z.string().min(16).max(MAX_FILE_BASE64_LENGTH).optional(),
})

const androidCredentialsSchema = z.object({
  app_id: appIdSchema,
  platform: z.literal('android'),
  generate_keystore: z.boolean().optional(),
  keystore_base64: z.string().min(16).max(MAX_FILE_BASE64_LENGTH).optional(),
  key_alias: z.string().trim().min(1).max(128).optional(),
  key_password: z.string().max(256).optional(),
  store_password: z.string().min(6).max(256).optional(),
  play_service_account_json: z.string().trim().min(2).max(16384).optional(),
})

const credentialsBodySchema = z.discriminatedUnion('platform', [iosCredentialsSchema, androidCredentialsSchema])

const appPlatformSchema = z.object({ app_id: appIdSchema, platform: platformSchema })

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = safeParseSchema(schema, value)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  return parsed.data
}

async function assertAppPermission(c: Context<MiddlewareKeyVariables>, permission: Permission, appId: string) {
  if (!(await checkPermission(c, permission, { appId })))
    throw quickError(403, 'app_access_denied', 'You can\'t access this app', { app_id: appId, permission })
}

function currentUserId(c: Context<MiddlewareKeyVariables>): string {
  const userId = c.get('auth')?.userId
  if (!userId)
    throw quickError(401, 'not_authenticated', 'Not authenticated')
  return userId
}

function readiness(input: {
  app: Awaited<ReturnType<typeof getWebsiteLiveApp>>
  config: Awaited<ReturnType<typeof getStoreConfig>>
  credentials: Awaited<ReturnType<typeof listStoreCredentialSummaries>>
}) {
  const shared: string[] = []
  if (input.app.update_mode !== 'website' || !input.app.website_url)
    shared.push('website_live')
  if (!input.config.app_name)
    shared.push('app_name')
  if (!input.config.icon_storage_prefix)
    shared.push('icon')
  const missing = (platform: StorePlatform) => {
    const list = [...shared]
    if (!input.credentials.some(row => row.platform === platform))
      list.push(`${platform}_credentials`)
    return list
  }
  const ios = missing('ios')
  const android = missing('android')
  return {
    ios: { ready: ios.length === 0, missing: ios },
    android: { ready: android.length === 0, missing: android },
  }
}

async function loadStoreState(c: Context<MiddlewareKeyVariables>, appId: string) {
  const [app, config, credentials] = await Promise.all([
    getWebsiteLiveApp(c, appId),
    getStoreConfig(c, appId),
    listStoreCredentialSummaries(c, appId),
  ])
  const { data: builds, error: buildsError } = await supabaseAdmin(c)
    .from('build_requests')
    .select('id, builder_job_id, platform, status, last_error, created_at, updated_at')
    .eq('app_id', appId)
    .eq('build_config->>source', WEBSITE_LIVE_BUILD_SOURCE)
    .order('created_at', { ascending: false })
    .limit(10)
  if (buildsError)
    return quickError(500, 'build_history_unavailable', 'Could not load Web2App build history')
  return {
    app_id: appId,
    template_version: WEBSITE_LIVE_TEMPLATE_VERSION,
    bundle_id: appId,
    update_mode: app.update_mode,
    website_url: app.website_url,
    config: {
      app_name: config.app_name ?? app.name,
      version_name: config.version_name,
      icon_background_color: config.icon_background_color,
      submit_for_review: config.submit_for_review,
      updated_at: config.updated_at,
    },
    icon_preview_url: await getIconPreviewUrl(c, config.icon_storage_prefix),
    credentials: {
      ios: credentials.find(row => row.platform === 'ios') ?? null,
      android: credentials.find(row => row.platform === 'android') ?? null,
    },
    readiness: readiness({ app, config: { ...config, app_name: config.app_name ?? app.name }, credentials }),
    builds: builds ?? [],
  }
}

// GET /website_live_store?app_id= — store publishing state (never returns secrets)
app.get('/', middlewareAuth(), async (c) => {
  const appId = parseWith(appIdSchema, c.req.query('app_id'))
  await assertAppPermission(c, 'app.read', appId)
  return c.json(await loadStoreState(c, appId))
})

function websiteUrlOrThrow(input: string): string {
  const websiteUrl = normalizeWebsiteLiveUrl(input)
  if (!websiteUrl)
    throw simpleError('invalid_website_url', 'Use the HTTPS address of the website root, such as https://app.example.com')
  return websiteUrl
}

// POST /website_live_store/check — check that a website can run as a Web2App app
app.post('/check', middlewareAuth(), async (c) => {
  const body = parseWith(checkBodySchema, await parseBody(c))
  await assertAppPermission(c, 'app.read', body.app_id)
  const websiteApp = await getWebsiteLiveApp(c, body.app_id)
  const input = body.website_url ?? websiteApp.website_url
  if (!input)
    throw simpleError('website_url_missing', 'Add the website address first')
  return c.json(await checkWebsiteLive(websiteUrlOrThrow(input)))
})

// PUT /website_live_store — store listing settings
app.put('/', middlewareAuth(), async (c) => {
  const body = parseWith(configBodySchema, await parseBody(c))
  await assertAppPermission(c, 'app.update_settings', body.app_id)
  const websiteApp = await getWebsiteLiveApp(c, body.app_id)
  const { website_url: websiteUrlInput, force, ...configPatch } = body
  let websiteCheck: Awaited<ReturnType<typeof checkWebsiteLive>> | null = null
  const websiteUrl = websiteUrlInput ? websiteUrlOrThrow(websiteUrlInput) : null
  if (websiteUrl && !force && (websiteUrl !== websiteApp.website_url || websiteApp.update_mode !== 'website')) {
    websiteCheck = await checkWebsiteLive(websiteUrl)
    if (!websiteCheck.compatible)
      throw simpleError('website_not_compatible', 'This website cannot run as a Web2App app yet', { website_check: websiteCheck })
    if (!configPatch.app_name && websiteCheck.details.app_name && !hasControlCharacters(websiteCheck.details.app_name) && !(await getStoreConfig(c, body.app_id)).app_name)
      configPatch.app_name = websiteCheck.details.app_name
  }
  // Save the listing first: switching the app to website updates is the last write, so a
  // failed config write never leaves Web2App enabled with half of the settings.
  await upsertStoreConfig(c, body.app_id, currentUserId(c), configPatch)
  if (websiteUrl)
    await setWebsiteLiveUrl(c, body.app_id, websiteUrl)
  return c.json({ ...(await loadStoreState(c, body.app_id)), website_check: websiteCheck })
})

// POST /website_live_store/icon — generate every store icon from one PNG
app.post('/icon', middlewareAuth(), async (c) => {
  const body = parseWith(iconBodySchema, await parseBody(c))
  await assertAppPermission(c, 'app.update_settings', body.app_id)
  const websiteApp = await getWebsiteLiveApp(c, body.app_id)
  const config = await getStoreConfig(c, body.app_id)
  const backgroundColor = body.background_color ?? config.icon_background_color
  let source: Uint8Array
  if (body.from_website) {
    if (!websiteApp.website_url)
      throw simpleError('website_url_missing', 'Add the website address first')
    source = await fetchWebsiteIcon(websiteApp.website_url)
  }
  else {
    source = base64ToBytes(body.image_base64!)
  }
  const prefix = await storeIconSet(c, websiteApp, source, backgroundColor)
  await upsertStoreConfig(c, body.app_id, currentUserId(c), { icon_storage_prefix: prefix, icon_background_color: backgroundColor })
  return c.json(await loadStoreState(c, body.app_id))
})

// PUT /website_live_store/credentials — encrypt and store store keys
app.put('/credentials', middlewareAuth(), async (c) => {
  const body = parseWith(credentialsBodySchema, await parseBody(c))
  await assertAppPermission(c, 'app.build_native', body.app_id)
  const websiteApp = await getWebsiteLiveApp(c, body.app_id)
  const userId = currentUserId(c)
  if (body.platform === 'ios') {
    await saveIosCredentials(c, {
      app: websiteApp,
      userId,
      mode: body.mode,
      ascKeyId: body.asc_key_id.toUpperCase(),
      ascIssuerId: body.asc_issuer_id,
      ascPrivateKey: body.asc_private_key,
      certificateP12Base64: body.certificate_p12_base64,
      certificatePassword: body.certificate_password,
      provisioningProfileBase64: body.provisioning_profile_base64,
    })
    return c.json({ state: await loadStoreState(c, body.app_id), generated_keystore: null })
  }
  const saved = await saveAndroidCredentials(c, {
    app: websiteApp,
    userId,
    generateKeystore: body.generate_keystore === true,
    keystoreBase64: body.keystore_base64,
    keyAlias: body.key_alias,
    keyPassword: body.key_password,
    storePassword: body.store_password,
    playServiceAccountJson: body.play_service_account_json,
  })
  return c.json({
    state: await loadStoreState(c, body.app_id),
    generated_keystore: saved.generatedKeystore
      ? { keystore_base64: saved.generatedKeystore.keystoreBase64, key_alias: saved.generatedKeystore.keyAlias, password: saved.generatedKeystore.password }
      : null,
  })
})

// DELETE /website_live_store/credentials?app_id=&platform=
app.delete('/credentials', middlewareAuth(), async (c) => {
  const body = parseWith(appPlatformSchema, { app_id: c.req.query('app_id'), platform: c.req.query('platform') })
  await assertAppPermission(c, 'app.build_native', body.app_id)
  const deleted = await deleteStoreCredential(c, body.app_id, body.platform)
  if (!deleted)
    throw quickError(404, 'store_credentials_not_found', 'No stored keys for this platform')
  return c.json(await loadStoreState(c, body.app_id))
})

// POST /website_live_store/credentials/android/export — download the Android upload key
app.post('/credentials/android/export', middlewareAuth(), async (c) => {
  const body = parseWith(z.object({ app_id: appIdSchema }), await parseBody(c))
  await assertAppPermission(c, 'app.build_native', body.app_id)
  cloudlog({ requestId: c.get('requestId'), message: 'Web2App Android keystore exported', app_id: body.app_id, user_id: currentUserId(c) })
  return c.json(await exportAndroidKeystore(c, body.app_id))
})

// POST /website_live_store/publish — build the app from the template and send it to the store
app.post('/publish', middlewareAuth(), async (c) => {
  const body = parseWith(appPlatformSchema, await parseBody(c))
  await assertAppPermission(c, 'app.build_native', body.app_id)
  const userId = currentUserId(c)
  const auth = c.get('auth')!
  const state = await loadStoreState(c, body.app_id)
  const platformState = state.readiness[body.platform]
  if (!platformState.ready)
    throw simpleError('website_live_store_not_ready', 'Finish the store setup before publishing', { missing: platformState.missing })

  const websiteApp = await getWebsiteLiveApp(c, body.app_id)
  const bundleId = assertStoreBundleId(websiteApp.app_id, body.platform)
  const config = await getStoreConfig(c, body.app_id)
  const secrets = await getPublishSecrets(c, body.app_id, body.platform)
  const buildCredentials = body.platform === 'ios'
    ? iosBuilderCredentials(secrets.ios!, bundleId)
    : androidBuilderCredentials(secrets.android!)

  await ensureBuildTimePlanAllowed(c, supabaseWithAuth(c, auth), websiteApp.owner_org, body.app_id)
  await assertNativeBuildConcurrencyAvailable(c, { orgId: websiteApp.owner_org, appId: body.app_id, userId })

  const [templateZip, icons, versionCode] = await Promise.all([
    fetchTemplateZip(c),
    loadIconSet(c, config.icon_storage_prefix!, config.icon_background_color),
    getNextWebsiteLiveVersionCode(c, body.app_id, body.platform),
  ])
  const projectZip = patchWebsiteLiveTemplate(templateZip, {
    bundleId,
    appName: state.config.app_name!,
    websiteUrl: websiteApp.website_url!,
    capgoAppId: websiteApp.app_id,
    versionName: config.version_name,
    versionCode,
    icons,
  })

  const created = await createNativeBuildRequest(c, {
    app_id: body.app_id,
    org_id: websiteApp.owner_org,
    user_id: userId,
    platform: body.platform,
    build_mode: 'release',
    build_config: { source: WEBSITE_LIVE_BUILD_SOURCE, template_version: WEBSITE_LIVE_TEMPLATE_VERSION, version_name: config.version_name, version_code: versionCode },
    build_options: websiteLiveBuildOptions(body.platform, config.submit_for_review, Boolean(secrets.android?.playServiceAccountJson)),
    build_credentials: buildCredentials,
    ios_dependency_manager: body.platform === 'ios' ? 'spm' : null,
  })
  try {
    await uploadToBuilder(c, { builderUploadUrl: created.builderUploadUrl, uploadPath: created.upload_path, bytes: projectZip })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Project upload to the build service failed'
    await markBuildAsFailed(c, created.builderJob.jobId, body.app_id, message)
    throw error
  }
  const started = await startBuildForRequest(c, {
    jobId: created.builderJob.jobId,
    appId: body.app_id,
    buildRequest: created.buildRequestRow,
    userId,
  })
  cloudlog({ requestId: c.get('requestId'), message: 'Web2App store build started', app_id: body.app_id, platform: body.platform, job_id: created.builderJob.jobId })
  return c.json({
    build_request_id: created.buildRequestRow.id,
    job_id: created.builderJob.jobId,
    platform: body.platform,
    status: started.status,
    submit_for_review: config.submit_for_review,
  })
})
