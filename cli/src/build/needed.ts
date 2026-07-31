import type { SupabaseClient } from '@supabase/supabase-js'
import type { BuildNeededOptions } from '../schemas/build'
import type { Compatibility } from '../schemas/common'
import type { Database } from '../types/supabase.types'
import process, { env, stdout } from 'node:process'
import { log } from '@clack/prompts'
import { difference, parse } from '@std/semver'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { formatTable } from '../terminal-table'
import {
  checkCompatibilityCloud,
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getCompatibilityDetails,
  getConfig,
  isCompatible,
} from '../utils'

type VersionChangeType = 'major' | 'minor' | 'patch' | 'prerelease' | 'changed' | 'same' | 'new' | 'removed'

interface PublicChannelRow {
  name: string | null
}

export interface BuildNeededResult {
  required: boolean
  resolvedAppId: string
  channel: string
  finalCompatibility: Compatibility[]
}

export const BUILD_NEEDED_ERROR_EXIT_CODE = 2

interface FormatOptions {
  color?: boolean
}

const colorCodes = {
  reset: '\x1B[0m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  yellow: '\x1B[33m',
  green: '\x1B[32m',
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function shouldUseColor(): boolean {
  if (env.NO_COLOR)
    return false
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0')
    return true
  return !!stdout.isTTY
}

function colorize(value: string, color: keyof typeof colorCodes, enabled: boolean): string {
  if (!enabled)
    return value
  return `${colorCodes[color]}${value}${colorCodes.reset}`
}

function colorForVersionChange(change: VersionChangeType): keyof typeof colorCodes {
  switch (change) {
    case 'major':
    case 'new':
      return 'red'
    case 'minor':
    case 'changed':
    case 'prerelease':
      return 'yellow'
    case 'patch':
      return 'green'
    case 'removed':
    case 'same':
      return 'dim'
  }
}

export function getConfiguredDefaultChannel(config: unknown): string | undefined {
  const configured = (config as { plugins?: { CapacitorUpdater?: { defaultChannel?: unknown } } } | undefined)
    ?.plugins
    ?.CapacitorUpdater
    ?.defaultChannel

  return typeof configured === 'string' ? normalizeString(configured) : undefined
}

export function selectDefaultChannelName(rows: PublicChannelRow[]): string {
  const names = [...new Set(rows
    .map(row => normalizeString(row.name ?? undefined))
    .filter((name): name is string => !!name))]

  if (names.length === 1)
    return names[0]

  if (names.length === 0)
    throw new Error('No default channel found. Pass --channel <channel>.')

  throw new Error(`Multiple default channels found (${names.join(', ')}). Pass --channel <channel>.`)
}

async function getPublicDefaultChannelName(
  supabase: SupabaseClient<Database>,
  appId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('channels')
    .select('name')
    .eq('app_id', appId)
    .eq('public', true)
    .or('ios.eq.true,android.eq.true')

  if (error)
    throw new Error(`Cannot load default channel: ${formatError(error)}`)

  return selectDefaultChannelName((data ?? []) as PublicChannelRow[])
}

async function resolveBuildNeededChannel(
  supabase: SupabaseClient<Database>,
  appId: string,
  options: BuildNeededOptions,
  config: unknown,
): Promise<string> {
  const explicitChannel = normalizeString(options.channel)
  if (explicitChannel)
    return explicitChannel

  const configuredDefaultChannel = getConfiguredDefaultChannel(config)
  if (configuredDefaultChannel)
    return configuredDefaultChannel

  return getPublicDefaultChannelName(supabase, appId)
}

export function getVersionChangeType(entry: Compatibility): VersionChangeType {
  if (!entry.localVersion)
    return 'removed'
  if (!entry.remoteVersion)
    return 'new'
  if (entry.localVersion === entry.remoteVersion)
    return 'same'

  try {
    const change = difference(parse(entry.remoteVersion), parse(entry.localVersion))
    if (change === 'major' || change === 'premajor')
      return 'major'
    if (change === 'minor' || change === 'preminor')
      return 'minor'
    if (change === 'patch' || change === 'prepatch')
      return 'patch'
    if (change === 'pre' || change === 'prerelease')
      return 'prerelease'
  }
  catch {
    return 'changed'
  }

  return 'changed'
}

export function getNativeDiffLabel(entry: Compatibility): string {
  const iosChanged = !!(entry.localIosChecksum || entry.remoteIosChecksum)
    && entry.localIosChecksum !== entry.remoteIosChecksum
  const androidChanged = !!(entry.localAndroidChecksum || entry.remoteAndroidChecksum)
    && entry.localAndroidChecksum !== entry.remoteAndroidChecksum

  if (iosChanged && androidChanged)
    return 'iOS + Android'
  if (iosChanged)
    return 'iOS'
  if (androidChanged)
    return 'Android'
  return '-'
}

export function isBuildNeeded(finalCompatibility: Compatibility[]): boolean {
  return finalCompatibility.some(entry => !isCompatible(entry))
}

export function getBuildNeededExitCode(required: boolean): number {
  return required ? 1 : 0
}

function sortCompatibility(entries: Compatibility[]): Compatibility[] {
  return [...entries].sort((a, b) => {
    const aCompatible = isCompatible(a)
    const bCompatible = isCompatible(b)
    if (aCompatible !== bCompatible)
      return aCompatible ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export function formatShortBuildNeeded(required: boolean): string {
  return required ? 'yes' : 'no'
}

export function formatBuildNeededTable(finalCompatibility: Compatibility[], options: FormatOptions = {}): string {
  const color = options.color ?? shouldUseColor()
  const rows = sortCompatibility(finalCompatibility).map((entry) => {
    const change = getVersionChangeType(entry)
    const details = getCompatibilityDetails(entry)
    const required = !details.compatible
    const nativeDiff = getNativeDiffLabel(entry)
    const changeColor = colorForVersionChange(change)

    return [
      entry.name,
      entry.remoteVersion || '-',
      entry.localVersion || '-',
      colorize(change, changeColor, color),
      nativeDiff === '-' ? nativeDiff : colorize(nativeDiff, 'red', color),
      required ? colorize('yes', 'red', color) : colorize('no', 'green', color),
    ]
  })

  return formatTable({
    headers: ['Package', 'Current app', 'Local', 'Change', 'Native diff', 'Required'],
    rows,
  })
}

export function formatVerboseBuildNeeded(
  result: BuildNeededResult,
  options: FormatOptions = {},
): string {
  return [
    `Build needed: ${formatShortBuildNeeded(result.required)}`,
    `Exit code: ${getBuildNeededExitCode(result.required)}`,
    `App ID: ${result.resolvedAppId}`,
    `Channel: ${result.channel}`,
    '',
    formatBuildNeededTable(result.finalCompatibility, options),
  ].join('\n')
}

export async function getBuildNeeded(
  appId: string | undefined,
  options: BuildNeededOptions,
): Promise<BuildNeededResult> {
  const enrichedOptions: BuildNeededOptions = {
    ...options,
    apikey: options.apikey || findSavedKey(true),
  }

  let extConfig: Awaited<ReturnType<typeof getConfig>> | undefined
  let configError: unknown
  try {
    extConfig = await getConfig(true)
  }
  catch (error) {
    configError = error
  }

  const resolvedAppId = getAppId(appId, extConfig?.config)
  if (!resolvedAppId) {
    if (configError instanceof Error)
      throw configError
    throw new Error('Missing appId')
  }

  if (!enrichedOptions.apikey)
    throw new Error('Missing API key')

  const supabase = await createSupabaseClient(
    enrichedOptions.apikey,
    enrichedOptions.supaHost,
    enrichedOptions.supaAnon,
  )

  await check2FAComplianceForApp(supabase, resolvedAppId, true)
  await checkAppExistsAndHasPermissionOrgErr(
    supabase,
    enrichedOptions.apikey,
    resolvedAppId,
    'app.read_bundles',
    true,
    true,
  )

  const channel = await resolveBuildNeededChannel(supabase, resolvedAppId, enrichedOptions, extConfig?.config)
  const compatibility = await checkCompatibilityCloud(
    supabase,
    resolvedAppId,
    channel,
    enrichedOptions.packageJson,
    enrichedOptions.nodeModules,
  )

  return {
    required: isBuildNeeded(compatibility.finalCompatibility),
    resolvedAppId,
    channel,
    finalCompatibility: compatibility.finalCompatibility,
  }
}

export async function checkBuildNeeded(
  appId: string | undefined,
  options: BuildNeededOptions,
): Promise<void> {
  try {
    const result = await getBuildNeeded(appId, options)
    const output = options.verbose
      ? formatVerboseBuildNeeded(result)
      : formatShortBuildNeeded(result.required)

    stdout.write(`${output}\n`)
    process.exitCode = getBuildNeededExitCode(result.required)
    void trackEvent({ channel: 'cli-usage', event: 'Build Needed Checked', icon: '🧭', tags: { build_needed: result.required } })
  }
  catch (error) {
    log.error(`Error checking build requirement ${formatError(error)}`)
    process.exitCode = BUILD_NEEDED_ERROR_EXIT_CODE
  }
}
