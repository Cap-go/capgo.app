/**
 * Build variants: the macOS / Xcode combinations iOS cloud builds can be pinned to with
 * `--xcode-version`. The list comes live from the Capgo builder (GET /build/variants), so it
 * always matches the machines that are registered right now.
 */
import process from 'node:process'
import { isCancel, log, select } from '@clack/prompts'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { CliUserError } from '../shared/cli-user-error'
import { createCapgoClient, findSavedKey } from '../utils'

export interface BuildVariant {
  platform: 'ios'
  id: string
  xcode_version: string
  macos_version: string | null
  backend: 'mac' | 'linux'
  runners: number
  online: number
  default: boolean
}

export interface BuildVariantsResponse {
  default_xcode_major: string | null
  variants: BuildVariant[]
}

export interface BuildVariantsOptions {
  apikey?: string
  apiHost?: string
  platform?: string
  json?: boolean
}

// Same version shape `build request --xcode-version` accepts (normalizeMachineVersion).
const MACHINE_VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){0,2}$/

/** Sentinel for "no pin": the build runs on any machine. */
export const ANY_XCODE_VERSION = ''

export async function fetchBuildVariants(apiHost: string, apikey: string, platform = 'ios'): Promise<BuildVariantsResponse> {
  const response = await fetch(`${apiHost}/build/variants?platform=${encodeURIComponent(platform)}`, {
    headers: buildCliRequestHeaders({ capgkey: apikey }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  }
  catch {
    parsed = { message: text.slice(0, 500) }
  }
  if (!response.ok) {
    const error = parsed as { error?: string, message?: string }
    throw new CliUserError(`Capgo API ${response.status}${error.error ? ` ${error.error}` : ''}: ${error.message ?? 'request failed'}`)
  }
  const body = parsed as Partial<BuildVariantsResponse>
  // The version ends up in `--xcode-version <version>`: keep only dotted numeric versions.
  const variants = Array.isArray(body.variants)
    ? body.variants.filter(variant => typeof variant?.xcode_version === 'string' && MACHINE_VERSION_RE.test(variant.xcode_version))
    : []
  return { default_xcode_major: body.default_xcode_major ?? null, variants }
}

export function formatBuildVariant(variant: BuildVariant): string {
  const machine = variant.backend === 'linux'
    ? 'Linux builder'
    : variant.macos_version ? `macOS ${variant.macos_version}` : 'macOS'
  const availability = variant.online > 0 ? `${variant.online}/${variant.runners} online` : 'offline'
  return `Xcode ${variant.xcode_version} · ${machine} · ${availability}${variant.default ? ' · default' : ''}`
}

/** Distinct Xcode versions, newest first, keeping the builder's order. */
export function selectableXcodeVersions(variants: BuildVariant[]): Array<{ xcodeVersion: string, variants: BuildVariant[] }> {
  const byXcode = new Map<string, BuildVariant[]>()
  for (const variant of variants)
    byXcode.set(variant.xcode_version, [...(byXcode.get(variant.xcode_version) ?? []), variant])
  return [...byXcode.entries()].map(([xcodeVersion, list]) => ({ xcodeVersion, variants: list }))
}

/**
 * Asks which Xcode to build with. Returns the chosen version, ANY_XCODE_VERSION for no pin,
 * or undefined when there is nothing to choose from (or the list can't be read): the build
 * then keeps its default behaviour.
 */
export async function promptXcodeVersion(apiHost: string, apikey: string): Promise<string | undefined> {
  let variants: BuildVariant[]
  try {
    variants = (await fetchBuildVariants(apiHost, apikey, 'ios')).variants
  }
  catch {
    return undefined
  }
  const choices = selectableXcodeVersions(variants)
  if (choices.length < 2)
    return undefined
  const picked = await select({
    message: 'Which Xcode should this iOS build use?',
    options: [
      { value: ANY_XCODE_VERSION, label: 'Any available machine (recommended)', hint: 'fastest start' },
      ...choices.map(choice => ({
        value: choice.xcodeVersion,
        label: `Xcode ${choice.xcodeVersion}`,
        hint: choice.variants.map(v => formatBuildVariant(v).replace(/^Xcode [^·]+· /, '')).join(' | '),
      })),
    ],
  })
  if (isCancel(picked))
    throw new CliUserError('Build cancelled')
  return picked as string
}

/** `capgo build variants`: print the variants builds can be pinned to. */
export async function listBuildVariantsCommand(options: BuildVariantsOptions): Promise<void> {
  const platform = (options.platform ?? 'ios').trim().toLowerCase()
  if (platform !== 'ios' && platform !== 'android')
    throw new CliUserError('--platform must be ios or android')
  const apikey = options.apikey || findSavedKey(true)
  const client = await createCapgoClient(apikey, options.apiHost, true)
  const result = await fetchBuildVariants(client.apiHost, client.apikey, platform)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (platform === 'android') {
    log.info('Android builds have no machine variants: every build runs on the same Android image.')
    return
  }
  if (result.variants.length === 0) {
    log.warn('No build machine reports its Xcode version right now. Builds still run on any available machine.')
    return
  }
  log.info('Available iOS build variants (pin one with --xcode-version <version>):')
  for (const variant of result.variants)
    log.message(`  ${formatBuildVariant(variant)}`)
  if (result.default_xcode_major)
    log.info(`Without --xcode-version, builds prefer Xcode ${result.default_xcode_major} and run on any available machine.`)
}
