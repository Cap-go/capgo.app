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
import { createSupabaseClient, findSavedKey, formatError, getAppId, getConfig } from '../utils'

type AppRow = Pick<Database['public']['Tables']['apps']['Row'], 'allow_preview' | 'app_id'>
type BundleRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name'>
type ChannelRow = Pick<Database['public']['Tables']['channels']['Row'], 'id' | 'name'>

type CapgoSupabaseClient = SupabaseClient<Database>

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

async function getAppPreviewState(supabase: CapgoSupabaseClient, appId: string): Promise<AppRow> {
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, allow_preview')
    .eq('app_id', appId)
    .single()

  if (error || !data)
    throw new Error(`Cannot load app ${appId}: ${formatError(error)}`)

  return data
}

export async function assertAppAllowsPreview(supabase: CapgoSupabaseClient, appId: string) {
  const app = await getAppPreviewState(supabase, appId)
  if (!app.allow_preview)
    throw new Error(`Preview is disabled for app ${appId}. Enable it with: npx @capgo/cli@latest app set ${appId} --preview`)
}

async function getBundleById(supabase: CapgoSupabaseClient, appId: string, id: number): Promise<BundleRow | null> {
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, name')
    .eq('app_id', appId)
    .eq('id', id)
    .eq('deleted', false)
    .maybeSingle()

  if (error)
    throw new Error(`Cannot load bundle ${id}: ${formatError(error)}`)

  return data
}

async function getBundleByName(supabase: CapgoSupabaseClient, appId: string, name: string): Promise<BundleRow | null> {
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, name')
    .eq('app_id', appId)
    .eq('name', name)
    .eq('deleted', false)
    .maybeSingle()

  if (error)
    throw new Error(`Cannot load bundle ${name}: ${formatError(error)}`)

  return data
}

async function getChannelById(supabase: CapgoSupabaseClient, appId: string, id: number): Promise<ChannelRow | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name')
    .eq('app_id', appId)
    .eq('id', id)
    .maybeSingle()

  if (error)
    throw new Error(`Cannot load channel ${id}: ${formatError(error)}`)

  return data
}

async function getChannelByName(supabase: CapgoSupabaseClient, appId: string, name: string): Promise<ChannelRow | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name')
    .eq('app_id', appId)
    .eq('name', name)
    .maybeSingle()

  if (error)
    throw new Error(`Cannot load channel ${name}: ${formatError(error)}`)

  return data
}

export async function resolveBundlePreviewTarget(
  supabase: CapgoSupabaseClient,
  appId: string,
  bundleRef: string,
): Promise<PreviewQrTarget | null> {
  const numericId = parseSafeIntegerRef(bundleRef, 0)
  const bundle = numericId === undefined
    ? await getBundleByName(supabase, appId, bundleRef)
    : (await getBundleById(supabase, appId, numericId) ?? await getBundleByName(supabase, appId, bundleRef))

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
  supabase: CapgoSupabaseClient,
  appId: string,
  channelRef: string,
): Promise<PreviewQrTarget | null> {
  const numericId = parseSafeIntegerRef(channelRef, 1)
  const channel = numericId === undefined
    ? await getChannelByName(supabase, appId, channelRef)
    : (await getChannelById(supabase, appId, numericId) ?? await getChannelByName(supabase, appId, channelRef))

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
  supabase: CapgoSupabaseClient,
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
    const bundle = await resolveBundlePreviewTarget(supabase, appId, options.bundle)
    if (!bundle)
      throw new Error(`Bundle ${options.bundle} not found for app ${appId}`)
    return bundle
  }

  if (options.channel) {
    const channel = await resolveChannelPreviewTarget(supabase, appId, options.channel)
    if (!channel)
      throw new Error(`Channel ${options.channel} not found for app ${appId}`)
    return channel
  }

  if (!options.target)
    throw new Error('Missing target. Provide a bundle or channel with --bundle, --channel, or a positional target')

  if (options.type === 'bundle') {
    const bundle = await resolveBundlePreviewTarget(supabase, appId, options.target)
    if (!bundle)
      throw new Error(`Bundle ${options.target} not found for app ${appId}`)
    return bundle
  }

  if (options.type === 'channel') {
    const channel = await resolveChannelPreviewTarget(supabase, appId, options.target)
    if (!channel)
      throw new Error(`Channel ${options.target} not found for app ${appId}`)
    return channel
  }

  const [bundle, channel] = await Promise.all([
    resolveBundlePreviewTarget(supabase, appId, options.target),
    resolveChannelPreviewTarget(supabase, appId, options.target),
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
  supabase: CapgoSupabaseClient,
  appId: string,
  target: PreviewQrTarget,
  options: PreviewQrOutputOptions = {},
) {
  await assertAppAllowsPreview(supabase, appId)
  await printPreviewQrCode(target, options)
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
  await check2FAComplianceForApp(supabase, appId)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read', false, true)

  const resolvedTarget = await resolvePreviewQrTarget(supabase, appId, { ...options, target })
  await printPreviewQrForResolvedTarget(supabase, appId, resolvedTarget, {
    png: options.png,
    url: options.url,
    webUrl: options.webUrl,
    previewEnv: options.previewEnv,
  })

  outro('Done ✅')
}
