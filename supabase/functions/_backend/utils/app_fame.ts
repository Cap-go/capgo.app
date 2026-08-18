import type { Context } from 'hono'
import type { AiBinding } from './workers_ai.ts'
import { getEnv } from './utils.ts'
import { extractAiText, parseJsonObjectFromAiText } from './workers_ai.ts'

export const APP_FAME_BATCH_SIZE = 12
export const APP_FAME_STALE_DAYS = 30
export const DEFAULT_APP_FAME_MODEL = '@cf/moonshotai/kimi-k2.6'

export const APP_FAME_TIERS = ['unknown', 'niche', 'notable', 'famous', 'iconic'] as const
export type AppFameTier = typeof APP_FAME_TIERS[number]

export interface AppFameCandidate {
  app_id: string
  name: string | null
  icon_url: string | null
  ios_store_url: string | null
  android_store_url: string | null
  org_name: string | null
  org_website: string | null
}

export interface AppFameDecision {
  app_id: string
  fame_score: number
  confidence: number
  tier: AppFameTier
  category: string
  known_as: string
  summary: string
}

const TIER_SET = new Set<string>(APP_FAME_TIERS)

export function fameTierFromScore(score: number): AppFameTier {
  if (score >= 90)
    return 'iconic'
  if (score >= 75)
    return 'famous'
  if (score >= 55)
    return 'notable'
  if (score >= 30)
    return 'niche'
  return 'unknown'
}

export function clampScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return null
  const score = Math.round(value)
  if (score < 0 || score > 100)
    return null
  return score
}

function fameResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      apps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            app_id: { type: 'string' },
            fame_score: { type: 'integer' },
            confidence: { type: 'integer' },
            category: { type: 'string' },
            known_as: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['app_id', 'fame_score', 'confidence', 'category', 'known_as', 'summary'],
        },
      },
    },
    required: ['apps'],
  }
}

export function parseFameDecisions(value: unknown, allowedAppIds: Set<string>): AppFameDecision[] {
  const record = parseJsonObjectFromAiText(value) ?? parseJsonObjectFromAiText(extractAiText(value))
  if (!record)
    return []

  const rows = Array.isArray(record.apps) ? record.apps : []
  const decisions: AppFameDecision[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      continue
    const entry = row as Record<string, unknown>
    const appId = typeof entry.app_id === 'string' ? entry.app_id.trim() : ''
    if (!appId || !allowedAppIds.has(appId) || seen.has(appId))
      continue

    const fameScore = clampScore(entry.fame_score)
    const confidence = clampScore(entry.confidence)
    if (fameScore === null || confidence === null)
      continue

    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''
    if (!summary)
      continue

    const category = typeof entry.category === 'string' ? entry.category.trim() : ''
    const knownAs = typeof entry.known_as === 'string' ? entry.known_as.trim() : ''
    const requestedTier = typeof entry.tier === 'string' ? entry.tier.trim().toLowerCase() : ''
    const tier = TIER_SET.has(requestedTier) && requestedTier === fameTierFromScore(fameScore)
      ? requestedTier as AppFameTier
      : fameTierFromScore(fameScore)

    seen.add(appId)
    decisions.push({
      app_id: appId,
      fame_score: fameScore,
      confidence,
      tier,
      category,
      known_as: knownAs,
      summary,
    })
  }

  return decisions
}

export function buildFameSystemPrompt(): string {
  return [
    'You score public reputation of mobile and desktop apps that use Capgo live updates.',
    'Ignore install counts, MAU, and Capgo device counts completely.',
    'A nationally known bank, airline, retailer, or media brand can be famous even with few Capgo devices.',
    'An unknown utility with many devices is not famous.',
    'Score 90-100 iconic global consumer brands.',
    'Score 75-89 well-known national or industry brands.',
    'Score 55-74 recognizable in a niche, city, or industry.',
    'Score 30-54 real products with little public fame.',
    'Score 0-29 unknown, internal, demo, test, or unrecognizable apps.',
    'If you do not recognize the brand, keep the score low. Do not invent fame.',
    'known_as is the public brand name, or empty when unknown.',
    'summary is one short English sentence explaining the reputation, not the device count.',
    'Return JSON only.',
  ].join(' ')
}

export async function scoreAppsWithAi(
  c: Context,
  ai: AiBinding,
  candidates: AppFameCandidate[],
): Promise<{ decisions: AppFameDecision[], model: string }> {
  const model = getEnv(c, 'APP_FAME_MODEL') || DEFAULT_APP_FAME_MODEL
  const allowedAppIds = new Set(candidates.map(candidate => candidate.app_id))
  const result = await ai.run(model, {
    temperature: 0,
    max_tokens: 2048,
    response_format: {
      type: 'json_schema',
      json_schema: fameResponseSchema(),
    },
    messages: [
      {
        role: 'system',
        content: buildFameSystemPrompt(),
      },
      {
        role: 'user',
        content: JSON.stringify({ apps: candidates }),
      },
    ],
  })

  return {
    decisions: parseFameDecisions(result, allowedAppIds),
    model,
  }
}
