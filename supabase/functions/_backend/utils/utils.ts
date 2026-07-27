import type {
  SemVer,
} from '@std/semver'
import type { Context } from 'hono'
import {
  lessThan,
  parse,
} from '@std/semver'
import { env, getRuntimeKey } from 'hono/adapter'

declare const EdgeRuntime: { waitUntil?: (promise: Promise<any>) => void } | undefined

export const fetchLimit = 50
export const WAIT_FOR_COMPLETION_HEADER = 'x-capgo-wait-for-completion'

// Regex for Zod validation of an app id
export const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i

// Regex for Zod validation of a device id. Examples:
//    44f128a5-ac7a-4c9a-be4c-224b6bf81b20 (android)
//    0F673663-459A-44C0-A7F5-613F2A4AF3AB (ios)
export const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Regex for Semantic Versioning validation (strict semver, no leading 'v')
// Based on https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
export const regexSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*))?(?:\+([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i

// Zod validation messages
export const MISSING_STRING_APP_ID = 'App ID is required'
export const NON_STRING_APP_ID = 'App ID must be a string'
export const INVALID_STRING_APP_ID = 'App ID must be a reverse domain string'

export const MISSING_STRING_DEVICE_ID = 'Device ID is required'
export const NON_STRING_DEVICE_ID = 'Device ID must be a string'
export const INVALID_STRING_DEVICE_ID = 'Device ID must be a valid UUID string'

export const MISSING_STRING_VERSION_NAME = 'Version name is required'
export const NON_STRING_VERSION_NAME = 'Version name must be a string'

export const MISSING_STRING_VERSION_BUILD = 'Version build is required'
export const NON_STRING_VERSION_BUILD = 'Version build must be a string'

export const MISSING_STRING_VERSION_OS = 'Version OS is required'
export const NON_STRING_VERSION_OS = 'Version OS must be a string'

export const MISSING_STRING_PLATFORM = 'Platform is required'
export const NON_STRING_PLATFORM = 'Platform must be a string'

export const INVALID_STRING_PLUGIN_VERSION = 'Plugin version is invalid'
export const MISSING_STRING_PLUGIN_VERSION = 'plugin_version is required'

// Constants for validation messages
export const INVALID_STRING_PLATFORM = 'Platform is not supported or invalid'

// function to fix semver 1.0 to 1.0.0 any verssion missing . should add .0 also should work for 1
export function fixSemver(version: string) {
  if (version === 'builtin')
    return '0.0.0'
  if (version === 'unknown')
    return '0.0.0'
  const nbPoint = (version?.match(/\./g) ?? []).length
  if (nbPoint === 0)
    return `${version}.0.0`
  if (nbPoint === 1)
    return `${version}.0`
  return version
}

// Version required for Brotli support with .br extension
export const BROTLI_MIN_UPDATER_VERSION_V5 = '5.10.0'
export const BROTLI_MIN_UPDATER_VERSION_V6 = '6.25.0'
export const BROTLI_MIN_UPDATER_VERSION_V7 = '7.0.35'

const SEMVER_5_10_0 = parse('5.10.0')
const SEMVER_5_35_0 = parse('5.35.0')
const SEMVER_6_25_0 = parse('6.25.0')
const SEMVER_6_35_0 = parse('6.35.0')
const SEMVER_7_0_35 = parse('7.0.35')
const SEMVER_7_25_0 = parse('7.25.0')
const SEMVER_7_35_0 = parse('7.35.0')
const SEMVER_8_0_0 = parse('8.0.0')
const SEMVER_8_35_0 = parse('8.35.0')

function getParsedVersion(version: string): SemVer {
  switch (version) {
    case '5.10.0':
      return SEMVER_5_10_0
    case '5.35.0':
      return SEMVER_5_35_0
    case '6.25.0':
      return SEMVER_6_25_0
    case '6.35.0':
      return SEMVER_6_35_0
    case '7.0.35':
      return SEMVER_7_0_35
    case '7.25.0':
      return SEMVER_7_25_0
    case '7.35.0':
      return SEMVER_7_35_0
    case '8.0.0':
      return SEMVER_8_0_0
    case '8.35.0':
      return SEMVER_8_35_0
    default:
      return parse(version)
  }
}

export function isDeprecatedPluginVersion(parsedPluginVersion: SemVer, minFive = '5.10.0', minSix = '6.25.0', minSeven = '7.25.0', minEight = '8.0.0'): boolean {
  // v5 is deprecated if < 5.10.0, v6 is deprecated if < 6.25.0, v7 is deprecated if < 7.25.0, v8 is deprecated if < 8.0.0
  if (parsedPluginVersion.major === 5 && lessThan(parsedPluginVersion, getParsedVersion(minFive))) {
    return true
  }
  if (parsedPluginVersion.major === 6 && lessThan(parsedPluginVersion, getParsedVersion(minSix))) {
    return true
  }
  if (parsedPluginVersion.major === 7 && lessThan(parsedPluginVersion, getParsedVersion(minSeven))) {
    return true
  }
  if (parsedPluginVersion.major === 8 && lessThan(parsedPluginVersion, getParsedVersion(minEight))) {
    return true
  }
  return false
}

export function isInternalVersionName(version: string) {
  if (!version)
    return false
  return version === 'builtin' || version === 'unknown'
}

export function isValidSemver(version: string): boolean {
  if (!version)
    return false
  // Reject leading 'v' or 'V'
  if (version.startsWith('v') || version.startsWith('V'))
    return false
  return regexSemver.test(version)
}

export function isValidAppId(appId: string): boolean {
  if (!appId)
    return false
  return reverseDomainRegex.test(appId)
}

interface LimitedApp {
  id: string
  ignore: number
}

export interface Segments {
  capgo: boolean
  onboarded: boolean
  trial: boolean
  trial7: boolean
  trial1: boolean
  trial0: boolean
  paying: boolean
  plan: string
  payingMonthly: boolean
  overuse: boolean
  canceled: boolean
  issueSegment: boolean
}

let limitedAppsCacheKey: string | undefined
let limitedAppsById: Map<string, LimitedApp> | undefined

function getLimitedAppsById(limits: string): Map<string, LimitedApp> {
  if (limits === limitedAppsCacheKey && limitedAppsById)
    return limitedAppsById

  const apps = JSON.parse(limits) as LimitedApp[]
  // Preserve first-match semantics of the previous apps.find(...) lookup.
  const byId = new Map<string, LimitedApp>()
  for (const app of apps) {
    if (!byId.has(app.id))
      byId.set(app.id, app)
  }
  limitedAppsCacheKey = limits
  limitedAppsById = byId
  return limitedAppsById
}

export function isLimited(c: Context, id: string) {
  const limits = getEnv(c, 'LIMITED_APPS')
  if (!limits)
    return false
  const app = getLimitedAppsById(limits).get(id)
  if (!app || app.ignore === 0)
    return false
  if (app.ignore === 1)
    return true
  // check is Math.random() < ignore
  return Math.random() < app.ignore
}

export function backgroundTask(c: Context, p: any) {
  const waitForCompletion = c.req.header(WAIT_FOR_COMPLETION_HEADER) === 'true' && Boolean(c.get('APISecret'))
  if (waitForCompletion || getEnv(c, 'CAPGO_PREVENT_BACKGROUND_FUNCTIONS') === 'true') {
    return p
  }
  if (getRuntimeKey() === 'workerd') {
    c.executionCtx.waitUntil(p)
    return Promise.resolve(null)
  }
  if (EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(p)
    return Promise.resolve(null)
  }
  return p
}

function getContextEnv(c: Context): Record<string, string | undefined> {
  const runtimeEnv = env(c)
  if (runtimeEnv && typeof runtimeEnv === 'object') {
    return runtimeEnv as Record<string, string | undefined>
  }

  const contextEnv = (c as Context & { env?: Record<string, string | undefined> }).env
  if (contextEnv && typeof contextEnv === 'object') {
    return contextEnv
  }

  return {}
}

export function existInEnv(c: Context, key: string): boolean {
  return getContextEnv(c)[key] !== undefined
}

export function getEnv(c: Context, key: string): string {
  const value = getContextEnv(c)[key]
  if (value !== undefined)
    return value
  return ''
}

export function isStripeConfigured(c: Context): boolean {
  const secretKey = (getEnv(c, 'STRIPE_SECRET_KEY') || '').trim()
  if (!secretKey)
    return false

  // Accept Stripe secret keys ("sk_...") and restricted keys ("rk_...").
  // In CI/local development we sometimes set STRIPE_SECRET_KEY to placeholders
  // like "test"; those should be treated as not configured to avoid network calls.
  return secretKey.startsWith('sk_') || secretKey.startsWith('rk_')
}
