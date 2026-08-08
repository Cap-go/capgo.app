import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { AiBinding } from '../../utils/workers_ai.ts'
import { HTTPException } from 'hono/http-exception'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getEnv, isValidAppId } from '../../utils/utils.ts'
import { extractAiText, parseJsonObjectFromAiText } from '../../utils/workers_ai.ts'

const DEFAULT_BUMP_LEVEL_MODEL = '@cf/moonshotai/kimi-k2.6'
const MAX_PATHS_PER_LIST = 200
const BUMP_LEVELS = new Set<string>(['major', 'minor', 'patch', 'metadata'])

export type AiBumpLevel = 'major' | 'minor' | 'patch' | 'metadata'

export interface ManifestDiffBody {
  added?: string[]
  removed?: string[]
  changed?: string[]
  counts?: {
    added?: number
    removed?: number
    changed?: number
  }
}

export interface AiBumpLevelBody {
  appId?: string
  baseVersion?: string
  manifestDiff?: ManifestDiffBody
  nativeCompatibility?: {
    summary?: string
    breaking?: boolean
  }
}

function capPaths(paths: unknown, max = MAX_PATHS_PER_LIST): string[] {
  if (!Array.isArray(paths))
    return []
  return paths
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, max)
}

function bumpLevelSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      level: {
        type: 'string',
        enum: ['major', 'minor', 'patch', 'metadata'],
      },
      reason: {
        type: 'string',
      },
    },
    required: ['level', 'reason'],
  }
}

function parseBumpDecision(value: unknown): { level: AiBumpLevel, reason: string } | null {
  const record = parseJsonObjectFromAiText(value) ?? parseJsonObjectFromAiText(extractAiText(value))
  if (!record)
    return null

  const level = typeof record.level === 'string' ? record.level.trim().toLowerCase() : ''
  const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
  if (!BUMP_LEVELS.has(level as AiBumpLevel) || !reason)
    return null

  return { level: level as AiBumpLevel, reason }
}

export async function aiBumpLevel(
  c: Context<MiddlewareKeyVariables>,
  body: AiBumpLevelBody,
  _apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  const appId = body.appId
  if (!appId)
    throw simpleError('missing_app_id', 'Missing required fields: appId', { appId })
  if (!isValidAppId(appId))
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { appId })
  if (!body.baseVersion || typeof body.baseVersion !== 'string')
    throw simpleError('missing_base_version', 'Missing required fields: baseVersion', { baseVersion: body.baseVersion })
  if (!body.manifestDiff || typeof body.manifestDiff !== 'object')
    throw simpleError('missing_manifest_diff', 'Missing required fields: manifestDiff', { manifestDiff: body.manifestDiff })

  if (!(await checkPermission(c, 'app.upload_bundle', { appId })))
    throw simpleError('cannot_ai_bump_level', 'You can\'t access this app', { appId })

  const ai = c.env.AI as AiBinding | undefined
  if (!ai)
    throw quickError(503, 'ai_unavailable', 'Workers AI binding is not configured')

  const added = capPaths(body.manifestDiff.added)
  const removed = capPaths(body.manifestDiff.removed)
  const changed = capPaths(body.manifestDiff.changed)
  const counts = {
    added: typeof body.manifestDiff.counts?.added === 'number'
      ? body.manifestDiff.counts.added
      : (Array.isArray(body.manifestDiff.added) ? body.manifestDiff.added.length : added.length),
    removed: typeof body.manifestDiff.counts?.removed === 'number'
      ? body.manifestDiff.counts.removed
      : (Array.isArray(body.manifestDiff.removed) ? body.manifestDiff.removed.length : removed.length),
    changed: typeof body.manifestDiff.counts?.changed === 'number'
      ? body.manifestDiff.counts.changed
      : (Array.isArray(body.manifestDiff.changed) ? body.manifestDiff.changed.length : changed.length),
  }

  const model = getEnv(c, 'BUMP_LEVEL_MODEL') || DEFAULT_BUMP_LEVEL_MODEL
  const userPayload = {
    appId,
    baseVersion: body.baseVersion,
    manifestDiff: {
      added,
      removed,
      changed,
      counts,
    },
    nativeCompatibility: body.nativeCompatibility ?? null,
  }

  try {
    const result = await ai.run(model, {
      temperature: 0,
      max_tokens: 512,
      response_format: {
        type: 'json_schema',
        json_schema: bumpLevelSchema(),
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are Capgo\'s OTA semver classifier.',
            'Choose one bump level for the next Capgo live-update bundle version.',
            'major: breaking change or native incompatibility that requires a store rebuild / native change.',
            'minor: new features or meaningful non-breaking product changes.',
            'patch: bug fixes, small corrections, or low-risk non-feature changes.',
            'metadata: prerelease / non-functional packaging or metadata-only changes.',
            'Return JSON only with level and a short English reason.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify(userPayload),
        },
      ],
    })

    const decision = parseBumpDecision(result)
    if (!decision)
      throw quickError(502, 'ai_invalid_response', 'Workers AI returned an invalid bump level response')

    return c.json({ level: decision.level, reason: decision.reason })
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error

    cloudlog({
      requestId: c.get('requestId'),
      message: 'AI bump level classification failed',
      appId,
      baseVersion: body.baseVersion,
      error,
    })
    throw quickError(502, 'ai_invalid_response', 'Workers AI failed to classify bump level', {
      appId,
      baseVersion: body.baseVersion,
    }, error)
  }
}
