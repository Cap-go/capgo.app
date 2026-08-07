import type { SupabaseClient } from '@supabase/supabase-js'
import type { OptionsBase } from '../schemas/base'
import type { Database } from '../types/supabase.types'
import { stdout } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import QRCode from 'qrcode'
import { buildPreviewWebUrl, type PreviewWebEnv } from './web-url'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { createSupabaseClient, findSavedKey, formatError, getAppId, getCapgoCliHttpStatus, getConfig, invokeCapgoCliApi, readCapgoCliApiErrorPayload } from '../utils'

type AppRow = Pick<Database['public']['Tables']['apps']['Row'], 'allow_preview' | 'app_id'>
type BundleRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name'>
type ChannelRow = Pick<Database['public']['Tables']['channels']['Row'], 'id' | 'name'>

export interface CapgoPreviewHttpOptions {
  apikey: string
  supaHost?: string
  supaAnon?: string
  /** Injectable for unit tests; defaults to invokeCapgoCliApi. */
  invoke?: typeof invokeCapgoCliApi
}

function previewInvoke<T>(options: CapgoPreviewHttpOptions, path: string, method: string = 'GET', body?: unknown) {
  const invoke = options.invoke ?? invokeCapgoCliApi
  return invoke<T>(path, {
    apikey: options.apikey,
    method,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
}

export interface PreviewQrCommandOptions extends OptionsBase {
  bundle?: string
  channel?: string
  target?: string
  type?: 'bundle' | 'channel'
  png?: string
  url?: boolean
  webUrl?: boolean
  previewEnv?: PreviewWebEnv
}

export type PreviewQrTarget =
  | {
    appId: string
    bundleName: string
    kind: 'bundle'
    versionId: number
  }
  | {
    appId: string
    channelId: number
    channelName: string
    kind: 'channel'
  }

function parseSafeIntegerRef(value: string, min: number) {
  if (!/^\d+$/.test(value))
    return undefined

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : undefined
}

export function buildPreviewQrUrl(target: PreviewQrTarget) {
  if (target.kind === 'channel') {
    const url = new URL('capgo://preview/channel')
    url.searchParams.set('appId', target.appId)
    url.searchParams.set('channel', target.channelName)
    url.searchParams.set('channelId', String(target.channelId))
    return url.toString()
  }

  const url = new URL('capgo://preview/bundle')
  url.searchParams.set('appId', target.appId)
  url.searchParams.set('versionId', String(target.versionId))
  return url.toString()
}

export async function renderTerminalQrCode(value: string) {
  return QRCode.toString(value, { type: 'utf8', errorCorrectionLevel: 'L' })
}

export async function renderQrCodePng(value: string, outputPath: string) {
  const absolutePath = resolve(outputPath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await QRCode.toFile(absolutePath, value, { errorCorrectionLevel: 'L', width: 512 })
  await chmod(absolutePath, 0o600)
  return absolutePath
}

async function getAppPreviewState(options: CapgoPreviewHttpOptions, appId: string): Promise<AppRow> {
  const { data, error } = await previewInvoke<AppRow>(options, `app/${encodeURIComponent(appId)}`)

  if (error || !data)
    throw new Error(`Cannot load app ${appId}: ${formatError(error)}`)

  return data
}

export async function assertAppAllowsPreview(options: CapgoPreviewHttpOptions, appId: string) {
  const app = await getAppPreviewState(options, appId)
  if (!app.allow_preview)
    throw new Error(`Preview is disabled for app ${appId}. Enable it with: npx @capgo/cli@latest app set ${appId} --preview`)
}

async function listBundles(options: CapgoPreviewHttpOptions, appId: string): Promise<BundleRow[]> {
  const all: BundleRow[] = []
  let page = 0
  while (true) {
    const { data, error } = await previewInvoke<BundleRow[]>(options, `bundle?app_id=${encodeURIComponent(appId)}&page=${page}`)
    if (error) {
      const payload = await readCapgoCliApiErrorPayload(error)
      if (payload?.error === 'cannot_get_bundle' && payload?.message === 'Cannot get bundle')
        return all
      throw new Error(`Cannot load bundles for ${appId}: ${formatError(error)}`)
    }
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch.map(row => ({ id: row.id, name: row.name })))
    if (batch.length < 50)
      break
    page += 1
  }
  return all
}

async function getBundleById(options: CapgoPreviewHttpOptions, appId: string, id: number): Promise<BundleRow | null> {
  const bundles = await listBundles(options, appId)
  return bundles.find(bundle => bundle.id === id) ?? null
}

async function getBundleByName(options: CapgoPreviewHttpOptions, appId: string, name: string): Promise<BundleRow | null> {
  const bundles = await listBundles(options, appId)
  return bundles.find(bundle => bundle.name === name) ?? null
}

async function listChannels(options: CapgoPreviewHttpOptions, appId: string): Promise<ChannelRow[]> {
  const all: ChannelRow[] = []
  let page = 0
  while (true) {
    const { data, error } = await previewInvoke<ChannelRow[]>(options, `channel?app_id=${encodeURIComponent(appId)}&page=${page}`)
    if (error)
      throw new Error(`Cannot load channels for ${appId}: ${formatError(error)}`)
    const batch = Array.isArray(data) ? data : []
    if (!batch.length)
      break
    all.push(...batch.map(row => ({ id: row.id, name: row.name })))
    if (batch.length < 50)
      break
    page += 1
  }
  return all
}

async function getChannelById(options: CapgoPreviewHttpOptions, appId: string, id: number): Promise<ChannelRow | null> {
  const channels = await listChannels(options, appId)
  return channels.find(channel => channel.id === id) ?? null
}

async function getChannelByName(options: CapgoPreviewHttpOptions, appId: string, name: string): Promise<ChannelRow | null> {
  const { data, error } = await previewInvoke<ChannelRow>(
    options,
    `channel?app_id=${encodeURIComponent(appId)}&channel=${encodeURIComponent(name)}`,
  )
  if (error) {
    if (getCapgoCliHttpStatus(error) === 400)
      return null
    throw new Error(`Cannot load channel ${name}: ${formatError(error)}`)
  }
  return data ? { id: data.id, name: data.name } : null
}

export async function resolveBundlePreviewTarget(
  options: CapgoPreviewHttpOptions,
  appId: string,
  bundleRef: string,
): Promise<PreviewQrTarget | null> {
  const numericId = parseSafeIntegerRef(bundleRef, 0)
  const bundle = numericId === undefined
    ? await getBundleByName(options, appId, bundleRef)
    : (await getBundleById(options, appId, numericId) ?? await getBundleByName(options, appId, bundleRef))

  if (!bundle)
    return null

  return {
    appId,
    bundleName: bundle.name,
    kind: 'bundle',
    versionId: bundle.id,
  }
}

export async function resolveChannelPreviewTarget(
  options: CapgoPreviewHttpOptions,
  appId: string,
  channelRef: string,
): Promise<PreviewQrTarget | null> {
  const numericId = parseSafeIntegerRef(channelRef, 1)
  const channel = numericId === undefined
    ? await getChannelByName(options, appId, channelRef)
    : (await getChannelById(options, appId, numericId) ?? await getChannelByName(options, appId, channelRef))

  if (!channel)
    return null

  return {
    appId,
    channelId: channel.id,
    channelName: channel.name,
    kind: 'channel',
  }
}

export async function resolvePreviewQrTarget(
  http: CapgoPreviewHttpOptions,
  appId: string,
  options: Pick<PreviewQrCommandOptions, 'bundle' | 'channel' | 'target' | 'type'>,
): Promise<PreviewQrTarget> {
  if (options.bundle && options.channel)
    throw new Error('Use either --bundle or --channel, not both')
  if ((options.bundle || options.channel) && options.target)
    throw new Error('Use a positional target or --bundle/--channel, not both')
  if ((options.bundle || options.channel) && options.type)
    throw new Error('Use --type only with a positional target')

  if (options.bundle) {
    const bundle = await resolveBundlePreviewTarget(http, appId, options.bundle)
    if (!bundle)
      throw new Error(`Bundle ${options.bundle} not found for app ${appId}`)
    return bundle
  }

  if (options.channel) {
    const channel = await resolveChannelPreviewTarget(http, appId, options.channel)
    if (!channel)
      throw new Error(`Channel ${options.channel} not found for app ${appId}`)
    return channel
  }

  if (!options.target)
    throw new Error('Missing target. Provide a bundle or channel with --bundle, --channel, or a positional target')

  if (options.type === 'bundle') {
    const bundle = await resolveBundlePreviewTarget(http, appId, options.target)
    if (!bundle)
      throw new Error(`Bundle ${options.target} not found for app ${appId}`)
    return bundle
  }

  if (options.type === 'channel') {
    const channel = await resolveChannelPreviewTarget(http, appId, options.target)
    if (!channel)
      throw new Error(`Channel ${options.target} not found for app ${appId}`)
    return channel
  }

  const [bundle, channel] = await Promise.all([
    resolveBundlePreviewTarget(http, appId, options.target),
    resolveChannelPreviewTarget(http, appId, options.target),
  ])

  if (bundle && channel)
    throw new Error(`Target ${options.target} matches both a bundle and a channel. Use --type bundle or --type channel`)
  if (bundle)
    return bundle
  if (channel)
    return channel

  throw new Error(`No bundle or channel named/id ${options.target} found for app ${appId}`)
}

export interface PreviewQrOutputOptions {
  png?: string
  url?: boolean
  webUrl?: boolean
  previewEnv?: PreviewWebEnv
}

export function resolvePreviewQrOutputValue(target: PreviewQrTarget, options: PreviewQrOutputOptions = {}) {
  if (options.webUrl)
    return buildPreviewWebUrl(target, options.previewEnv ?? 'prod')
  return buildPreviewQrUrl(target)
}

export async function printPreviewQrCode(target: PreviewQrTarget, options: PreviewQrOutputOptions = {}) {
  const deepLink = buildPreviewQrUrl(target)
  const webUrl = buildPreviewWebUrl(target, options.previewEnv ?? 'prod')
  const qrValue = resolvePreviewQrOutputValue(target, options)
  const label = target.kind === 'bundle'
    ? `Bundle ${target.bundleName} (${target.versionId})`
    : `Channel ${target.channelName} (${target.channelId})`

  if (options.url) {
    log.success(`Preview URLs for ${label}`)
    stdout.write(`\n${webUrl}\n${deepLink}\n\n`)
    return
  }

  const qrText = await renderTerminalQrCode(qrValue)
  log.success(`Preview QR for ${label}`)
  stdout.write(`\n${qrText}\n${webUrl}\n${deepLink}\n`)

  if (options.png) {
    const pngPath = await renderQrCodePng(qrValue, options.png)
    log.info(`QR code PNG written to ${pngPath}`)
  }

  stdout.write('\n')
}

export async function printPreviewQrForResolvedTarget(
  http: CapgoPreviewHttpOptions,
  appId: string,
  target: PreviewQrTarget,
  output: PreviewQrOutputOptions = {},
) {
  await assertAppAllowsPreview(http, appId)
  await printPreviewQrCode(target, output)
}

export async function getPreviewQr(appId: string, target: string | undefined, options: PreviewQrCommandOptions) {
  intro('Get preview QR')

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    log.error('Missing API key, you need to provide an API key')
    throw new Error('Missing API key')
  }

  if (!appId) {
    log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  // TODO(cli-http): 2FA + permission checks still use supabase RPCs
  await check2FAComplianceForApp(supabase, appId)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read', false, true)

  const http = { apikey: options.apikey!, supaHost: options.supaHost, supaAnon: options.supaAnon }
  const resolvedTarget = await resolvePreviewQrTarget(http, appId, { ...options, target })
  await printPreviewQrForResolvedTarget(http, appId, resolvedTarget, {
    png: options.png,
    url: options.url,
    webUrl: options.webUrl,
    previewEnv: options.previewEnv,
  })

  outro('Done ✅')
}
