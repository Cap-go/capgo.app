import type { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  fameTierFromScore,
  parseFameDecisions,
  scoreAppsWithAi,
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
    expect(run.mock.calls[0]?.[0]).toBe('@cf/meta/llama-3.1-8b-instruct-fast')
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
})
