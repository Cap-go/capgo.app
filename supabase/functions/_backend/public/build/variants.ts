import type { Context } from 'hono'
import { z } from 'zod'
import { quickError } from '../../utils/hono.ts'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { getEnv } from '../../utils/utils.ts'

const BUILDER_VARIANTS_TIMEOUT_MS = 10_000

const builderVariantSchema = z.object({
  platform: z.literal('ios'),
  id: z.string().min(1).max(128),
  xcodeVersion: z.string().min(1).max(32),
  macosVersion: z.string().min(1).max(32).nullable(),
  backend: z.enum(['mac', 'linux']),
  runners: z.number().int().min(0),
  online: z.number().int().min(0),
  default: z.boolean(),
})

const builderVariantsSchema = z.object({
  defaultXcodeMajor: z.string().min(1).max(8),
  variants: z.array(builderVariantSchema),
})

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
  default_xcode_major: string
  variants: BuildVariant[]
}

function builderUnavailable(message: string): never {
  throw quickError(503, 'service_unavailable', message, {}, undefined, { alert: false })
}

/** Maps the builder's GET /variants body to the public snake_case shape, keeping only the requested platform. */
export function toBuildVariantsResponse(body: unknown, platform?: string): BuildVariantsResponse {
  const parsed = builderVariantsSchema.parse(body)
  return {
    default_xcode_major: parsed.defaultXcodeMajor,
    variants: parsed.variants
      .filter(variant => !platform || variant.platform === platform)
      .map(variant => ({
        platform: variant.platform,
        id: variant.id,
        xcode_version: variant.xcodeVersion,
        macos_version: variant.macosVersion,
        backend: variant.backend,
        runners: variant.runners,
        online: variant.online,
        default: variant.default,
      })),
  }
}

/**
 * GET /build/variants - The macOS / Xcode variants native builds can be pinned to
 * (CLI `--xcode-version`), read live from the builder's registered machines.
 */
export async function getBuildVariants(c: Context, platform?: string): Promise<Response> {
  if (platform && platform !== 'ios' && platform !== 'android')
    throw quickError(400, 'invalid_platform', 'platform must be ios or android', { platform }, undefined, { alert: false })

  // Android builds have no machine variants to pick from.
  if (platform === 'android')
    return c.json({ default_xcode_major: null, variants: [] })

  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey)
    builderUnavailable('Build service unavailable (builder not configured)')

  let response: Response
  try {
    response = await fetch(`${builderUrl}/variants`, {
      headers: { 'x-api-key': builderApiKey },
      signal: AbortSignal.timeout(BUILDER_VARIANTS_TIMEOUT_MS),
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder variants fetch failed', error: serializeError(error) })
    builderUnavailable('Build service unavailable (builder unreachable)')
  }

  if (!response.ok) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder variants returned error', status: response.status, body: await response.text().catch(() => '') })
    builderUnavailable('Build service unavailable (builder error)')
  }

  try {
    return c.json(toBuildVariantsResponse(await response.json(), platform))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder variants response invalid', error: serializeError(error) })
    builderUnavailable('Build service unavailable (invalid builder response)')
  }
}
