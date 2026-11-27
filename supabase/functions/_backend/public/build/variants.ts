import type { Context } from 'hono'
import { z } from 'zod'
import { quickError } from '../../utils/hono.ts'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { getEnv } from '../../utils/utils.ts'

const BUILDER_VARIANTS_TIMEOUT_MS = 10_000

// Same shape the builder and the CLI accept ("26", "26.1", "16.4.1"): clients paste it into
// a shell command (`--xcode-version <version>`), so nothing else may pass through.
const MACHINE_VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){0,2}$/

const builderVariantSchema = z.object({
  platform: z.literal('ios'),
  id: z.string().min(1).max(128),
  xcodeVersion: z.string().regex(MACHINE_VERSION_RE),
  macosVersion: z.string().regex(MACHINE_VERSION_RE).nullable(),
  backend: z.string().optional(),
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
  /** "mac": a Mac runner; "fast": the Fast builder. */
  backend: 'mac' | 'fast'
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

/** Maps the builder's GET /variants body (iOS variants only) to the public snake_case shape. */
export function toBuildVariantsResponse(body: unknown): BuildVariantsResponse {
  const parsed = builderVariantsSchema.parse(body)
  return {
    default_xcode_major: parsed.defaultXcodeMajor,
    // Only Mac runners and the Fast builder are customer-facing; any other machine type is dropped.
    variants: parsed.variants.filter(variant => variant.backend === undefined || variant.backend === 'mac' || variant.backend === 'fast').map(variant => ({
      platform: variant.platform,
      id: variant.id,
      xcode_version: variant.xcodeVersion,
      macos_version: variant.macosVersion,
      backend: variant.backend === 'fast' ? 'fast' as const : 'mac' as const,
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
    return c.json(toBuildVariantsResponse(await response.json()))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder variants response invalid', error: serializeError(error) })
    builderUnavailable('Build service unavailable (invalid builder response)')
  }
}
