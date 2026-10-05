import type { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  buildFameSystemPrompt,
  buildFameUserPrompt,
  collapseCopiedFameScores,
  DEFAULT_APP_FAME_MODEL,
  fameTierFromScore,
  isIgnoredFameAppId,
  looksLikeUnreliableFameDecision,
  parseFameAppsPayload,
  parseFameDecisions,
  scoreAppsWithAi,
  unreliableFameDecision,
} from '../supabase/functions/_backend/utils/app_fame.ts'

describe('app fame scoring', () => {
  it.concurrent('maps scores onto reputation tiers', () => {
    expect(fameTierFromScore(0)).toBe('unknown')
    expect(fameTierFromScore(29)).toBe('unknown')
    expect(fameTierFromScore(30)).toBe('niche')
    expect(fameTierFromScore(54)).toBe('niche')
    expect(fameTierFromScore(55)).toBe('notable')
    expect(fameTierFromScore(74)).toBe('notable')
    expect(fameTierFromScore(75)).toBe('famous')
    expect(fameTierFromScore(89)).toBe('famous')
    expect(fameTierFromScore(90)).toBe('iconic')
    expect(fameTierFromScore(100)).toBe('iconic')
  })

  it.concurrent('keeps recognized brands and drops unknown or invalid AI rows', () => {
    const allowed = new Set(['com.bank.app', 'com.utility.app'])
    const { decisions, missingAppIds } = parseFameDecisions({
      apps: [
        {
          app_id: 'com.bank.app',
          fame_score: 88,
          confidence: 70,
          category: 'finance',
          known_as: 'National Bank',
          summary: 'Major national consumer bank.',
        },
        {
          app_id: 'com.unknown.other',
          fame_score: 95,
          confidence: 90,
          category: 'social',
          known_as: 'Invented',
          summary: 'Hallucinated famous app.',
        },
        {
          app_id: 'com.utility.app',
          fame_score: 101,
          confidence: 40,
          category: 'tools',
          known_as: '',
          summary: 'Out of range score.',
        },
        {
          app_id: 'com.bank.app',
          fame_score: 10,
          confidence: 10,
          category: 'finance',
          known_as: 'Duplicate',
          summary: 'Should be ignored after the first row.',
        },
      ],
    }, allowed)

    expect(decisions).toEqual([{
      app_id: 'com.bank.app',
      fame_score: 88,
      confidence: 70,
      tier: 'famous',
      category: 'finance',
      known_as: 'National Bank',
      summary: 'Major national consumer bank.',
    }])
    expect(missingAppIds).toEqual(['com.utility.app'])
  })

  it.concurrent('unwraps Workers AI response envelopes before parsing', () => {
    const { decisions, missingAppIds } = parseFameDecisions({
      response: JSON.stringify({
        apps: [{
          app_id: 'com.bank.app',
          fame_score: 80,
          confidence: 70,
          category: 'finance',
          known_as: 'National Bank',
          summary: 'Major national consumer bank.',
        }],
      }),
    }, new Set(['com.bank.app']))

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.tier).toBe('famous')
    expect(missingAppIds).toEqual([])
  })

  it.concurrent('parses nested object Workers AI envelopes', () => {
    const { decisions, missingAppIds } = parseFameDecisions({
      response: {
        apps: [{
          app_id: 'com.bank.app',
          fame_score: '80',
          confidence: '70',
          category: 'finance',
          known_as: 'National Bank',
          summary: 'Major national consumer bank.',
        }],
      },
    }, new Set(['com.bank.app']))

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.fame_score).toBe(80)
    expect(missingAppIds).toEqual([])
  })

  it.concurrent('extracts apps arrays from nested response objects', () => {
    expect(parseFameAppsPayload({
      response: {
        apps: [{
          app_id: 'com.bank.app',
        }],
      },
    })).toEqual([{
      app_id: 'com.bank.app',
    }])
  })

  it.concurrent('extracts apps arrays from deeply nested response envelopes', () => {
    expect(parseFameAppsPayload({
      response: {
        result: {
          apps: [{
            app_id: 'com.bank.app',
          }],
        },
      },
    })).toEqual([{
      app_id: 'com.bank.app',
    }])
  })

  it.concurrent('parses JSON text wrapped in markdown fences', () => {
    const { decisions, missingAppIds } = parseFameDecisions(`
      \`\`\`json
      {"apps":[{"app_id":"com.airline.app","fame_score":92,"confidence":80,"category":"travel","known_as":"Air Brand","summary":"National flag carrier."}]}
      \`\`\`
    `, new Set(['com.airline.app']))

    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.tier).toBe('iconic')
    expect(decisions[0]?.known_as).toBe('Air Brand')
    expect(missingAppIds).toEqual([])
  })

  it.concurrent('returns all allowed app ids when AI response is unusable', () => {
    const allowed = new Set(['com.one.app', 'com.two.app'])
    const { decisions, missingAppIds } = parseFameDecisions('not json', allowed)

    expect(decisions).toEqual([])
    expect(missingAppIds.sort()).toEqual(['com.one.app', 'com.two.app'])
  })

  it('calls Workers AI and returns parsed decisions', async () => {
    const run = vi.fn().mockResolvedValue({
      apps: [{
        app_id: 'com.media.app',
        fame_score: 61,
        confidence: 55,
        category: 'media',
        known_as: 'City Paper',
        summary: 'Well-known regional newspaper.',
      }],
    })
    const c = {
      env: {},
      get: () => 'req-1',
    } as unknown as Context

    const result = await scoreAppsWithAi(c, { run }, [{
      app_id: 'com.media.app',
      name: 'City Paper',
      icon_url: null,
      ios_store_url: 'https://apps.apple.com/app/id1',
      android_store_url: null,
      org_name: 'Press Org',
      org_website: 'https://citypaper.example',
    }])

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe(DEFAULT_APP_FAME_MODEL)
    expect(result.decisions).toEqual([{
      app_id: 'com.media.app',
      fame_score: 61,
      confidence: 55,
      tier: 'notable',
      category: 'media',
      known_as: 'City Paper',
      summary: 'Well-known regional newspaper.',
    }])
    expect(result.missingAppIds).toEqual([])
  })

  it.concurrent('falls back to json_object when json_schema returns no parseable apps', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ response: 'not parseable' })
      .mockResolvedValueOnce({
        apps: [{
          app_id: 'com.media.app',
          fame_score: 42,
          confidence: 50,
          category: 'media',
          known_as: 'City Paper',
          summary: 'Regional publication.',
        }],
      })
    const c = {
      env: {},
      get: () => 'req-2',
    } as unknown as Context

    const result = await scoreAppsWithAi(c, { run }, [{
      app_id: 'com.media.app',
      name: 'City Paper',
      icon_url: null,
      ios_store_url: null,
      android_store_url: null,
      org_name: 'Press Org',
      org_website: null,
    }])

    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[1]?.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }))
    expect(run.mock.calls[1]?.[1]?.response_format).toEqual({ type: 'json_object' })
    expect(result.decisions[0]?.fame_score).toBe(42)
  })

  it.concurrent('ignores Capgo plugin demos and example bundle IDs', () => {
    expect(isIgnoredFameAppId('app.capgo.brightness')).toBe(true)
    expect(isIgnoredFameAppId('app.capgo.auto.example')).toBe(true)
    expect(isIgnoredFameAppId('ee.forgr.capacitor_go')).toBe(true)
    expect(isIgnoredFameAppId('com.demo.app')).toBe(true)
    expect(isIgnoredFameAppId('ai.athro.app')).toBe(false)
    expect(isIgnoredFameAppId('com.pizzahut.app')).toBe(false)
  })

  it.concurrent('discards rubric leaks and high scores with no public brand name', () => {
    expect(looksLikeUnreliableFameDecision({
      fame_score: 100,
      category: '90-100',
      known_as: 'Athro',
      summary: 'Unknown startup.',
    })).toBe(true)
    expect(looksLikeUnreliableFameDecision({
      fame_score: 100,
      category: 'Iconic Global Consumer',
      known_as: 'Capgo',
      summary: 'Plugin demo.',
    })).toBe(true)
    expect(looksLikeUnreliableFameDecision({
      fame_score: 92,
      category: 'software',
      known_as: '',
      summary: 'Guessed famous without a brand.',
    })).toBe(true)
    expect(looksLikeUnreliableFameDecision({
      fame_score: 96,
      category: 'food',
      known_as: 'Pizza Hut',
      summary: 'Global fast-food brand.',
    })).toBe(false)
  })

  it.concurrent('collapses identical copied high scores in a batch', () => {
    const copied = ['one', 'two', 'three', 'four'].map(appId => ({
      app_id: `com.${appId}.app`,
      fame_score: 100,
      confidence: 90,
      tier: 'iconic' as const,
      category: 'software',
      known_as: 'Copied Brand',
      summary: 'Model scored every app as iconic.',
    }))
    expect(collapseCopiedFameScores(copied)).toEqual(copied.map(decision => unreliableFameDecision(decision.app_id)))
    expect(collapseCopiedFameScores([
      { ...copied[0]!, fame_score: 96, app_id: 'com.food.app', known_as: 'Pizza Hut', category: 'food' },
      { ...copied[1]!, fame_score: 82, app_id: 'com.sports.app', known_as: 'Scott', category: 'sports' },
      { ...copied[2]!, fame_score: 61, app_id: 'com.city.app', known_as: 'City Paper', category: 'media' },
      { ...copied[3]!, fame_score: 12, app_id: 'com.unknown.app', known_as: '', category: 'software' },
    ]).map(decision => decision.fame_score)).toEqual([96, 82, 61, 12])
  })

  it.concurrent('rewrites leaked AI rows instead of storing iconic scores', () => {
    const { decisions } = parseFameDecisions({
      apps: [{
        app_id: 'ai.athro.app',
        fame_score: 100,
        confidence: 90,
        category: '90-100',
        known_as: 'Athro',
        summary: 'Iconic global consumer brand.',
      }],
    }, new Set(['ai.athro.app']))

    expect(decisions).toEqual([unreliableFameDecision('ai.athro.app')])
  })

  it.concurrent('asks the model to default unknown brands low and not copy score bands', () => {
    const prompt = buildFameSystemPrompt()
    expect(prompt).toContain('score 0-20')
    expect(prompt).toContain('Never invent fame')
    expect(prompt).toContain('Never put a number, score range')
    expect(DEFAULT_APP_FAME_MODEL).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')

    const userPrompt = buildFameUserPrompt([])
    expect(userPrompt).toContain('Pizza Hut')
    expect(userPrompt).toContain('app.capgo.brightness')
  })
})
