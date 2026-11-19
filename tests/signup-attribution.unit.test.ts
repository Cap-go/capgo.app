import { describe, expect, it } from 'vitest'
import {
  buildFirstTouchAttributionFromLocation,
  classifyFirstTouchType,
  deriveSignupSourceFromRecord,
  mergeSignupAttribution,
  mergeUrlPrecedenceSignupAttribution,
  parseCapgoAttributionCookieValue,
  parseFirstTouchFromPathname,
  parseSignupAttributionRecord,
  resolveConsoleSignupAttribution,
  serializeCapgoAttributionCookie,
  signupAttributionEventTags,
  signupAttributionToPostHogSetOnce,
  signupPluginFromRef,
} from '../supabase/functions/shared/signup-attribution.ts'

describe('signup attribution parsing', () => {
  it('derives signup_plugin from plugin ref', () => {
    expect(signupPluginFromRef('plugin_capacitor-updater')).toBe('capacitor-updater')
    expect(signupPluginFromRef('plugin_')).toBeUndefined()
    expect(signupPluginFromRef('other_ref')).toBeUndefined()
  })

  it('maps metadata and utm aliases to first_utm properties', () => {
    const parsed = parseSignupAttributionRecord({
      ref: 'plugin_capacitor-updater',
      utm_source: 'docs',
      first_utm_medium: 'email',
    })

    expect(parsed).toEqual({
      signup_ref: 'plugin_capacitor-updater',
      signup_plugin: 'capacitor-updater',
      signup_source: 'plugin_capacitor-updater',
      first_utm_source: 'docs',
      first_utm_medium: 'email',
    })
  })

  it('reads first touch and signup_source fields from website payloads', () => {
    const parsed = parseSignupAttributionRecord({
      signup_source: 'docs:getting-started',
      first_touch_type: 'docs',
      first_touch_path: '/docs/getting-started/',
      ref: 'plugin_updater',
    })

    expect(parsed.signup_source).toBe('docs:getting-started')
    expect(parsed.first_touch_type).toBe('docs')
    expect(parsed.first_touch_path).toBe('/docs/getting-started/')
    expect(parsed.signup_plugin).toBe('updater')
  })

  it('drops sensitive first_touch_path values', () => {
    expect(parseSignupAttributionRecord({
      first_touch_path: '/reset?token=secret',
    }).first_touch_path).toBeUndefined()
    expect(parseSignupAttributionRecord({
      first_touch_path: '/docs/getting-started/',
    }).first_touch_path).toBe('/docs/getting-started/')
    expect(parseSignupAttributionRecord({
      first_touch_path: '/docs/intro?utm_source=docs',
    }).first_touch_path).toBe('/docs/intro')
  })

  it('rejects unsafe signup_plugin values on org rows', () => {
    expect(parseSignupAttributionRecord({
      signup_plugin: 'user@example.com',
    }).signup_plugin).toBeUndefined()
  })

  it('truncates oversized attribution strings', () => {
    const longRef = `plugin_${'a'.repeat(300)}`
    const parsed = parseSignupAttributionRecord({
      ref: longRef,
      first_touch_path: `/${'b'.repeat(600)}`,
    })

    expect(parsed.signup_ref?.length).toBe(256)
    expect(parsed.first_touch_path?.length).toBe(512)
  })

  it('ignores invalid first_touch_type values', () => {
    const parsed = parseSignupAttributionRecord({
      first_touch_type: 'newsletter',
      signup_source: 'blog:hello',
    })

    expect(parsed.first_touch_type).toBeUndefined()
    expect(parsed.signup_source).toBe('blog:hello')
  })

  it('merges sources with earlier precedence winning', () => {
    const merged = mergeSignupAttribution(
      { signup_ref: 'plugin_from_metadata', signup_plugin: 'from_metadata', signup_source: 'plugin_from_metadata' },
      { signup_ref: 'plugin_from_cookie', first_utm_source: 'cookie', first_touch_type: 'plugin' },
      { signup_ref: 'plugin_from_url', first_utm_campaign: 'url' },
    )

    expect(merged.signup_ref).toBe('plugin_from_metadata')
    expect(merged.signup_plugin).toBe('from_metadata')
    expect(merged.signup_source).toBe('plugin_from_metadata')
    expect(merged.first_utm_source).toBe('cookie')
    expect(merged.first_utm_campaign).toBe('url')
    expect(merged.first_touch_type).toBe('plugin')
  })

  it('parses JSON capgo_attribution cookies', () => {
    const raw = encodeURIComponent(JSON.stringify({
      ref: 'plugin_updater',
      utm_source: 'website',
      signup_source: 'plugin_updater',
      first_touch_type: 'plugin',
      first_touch_path: '/plugins/capacitor-updater/',
    }))
    expect(parseCapgoAttributionCookieValue(raw)).toEqual({
      signup_ref: 'plugin_updater',
      signup_plugin: 'updater',
      signup_source: 'plugin_updater',
      first_touch_type: 'plugin',
      first_touch_path: '/plugins/capacitor-updater/',
      first_utm_source: 'website',
    })
  })

  it('ignores cookie attribution for established users without metadata', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    const createdAt = '2024-01-01T00:00:00.000Z'
    const cookie = parseSignupAttributionRecord({ ref: 'plugin_updater' })

    expect(resolveConsoleSignupAttribution({}, cookie, createdAt, now)).toEqual({})
  })

  it('merges cookie attribution only during the signup window when metadata is empty', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    const createdAt = '2026-10-12T11:00:00.000Z'
    const cookie = parseSignupAttributionRecord({ ref: 'plugin_updater' })

    expect(resolveConsoleSignupAttribution({}, cookie, createdAt, now)).toEqual({
      signup_ref: 'plugin_updater',
      signup_plugin: 'updater',
      signup_source: 'plugin_updater',
    })
  })

  it('keeps stored metadata over a newer cookie', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    const createdAt = '2026-10-12T11:00:00.000Z'
    const metadata = parseSignupAttributionRecord({ signup_plugin: 'from_metadata' })
    const cookie = parseSignupAttributionRecord({ ref: 'plugin_other' })

    expect(resolveConsoleSignupAttribution(metadata, cookie, createdAt, now).signup_plugin).toBe('from_metadata')
  })

  it('merges cookie first touch when metadata only has signup ref during the signup window', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    const createdAt = '2026-10-12T11:00:00.000Z'
    const metadata = parseSignupAttributionRecord({ ref: 'plugin_updater' })
    const cookie = parseSignupAttributionRecord({
      first_touch_type: 'docs',
      first_touch_path: '/docs/intro/',
      utm_source: 'newsletter',
    })

    expect(resolveConsoleSignupAttribution(metadata, cookie, createdAt, now)).toEqual({
      signup_ref: 'plugin_updater',
      signup_plugin: 'updater',
      signup_source: 'plugin_updater',
      first_touch_type: 'docs',
      first_touch_path: '/docs/intro/',
      first_utm_source: 'newsletter',
    })
  })

  it('classifies console and cli login paths', () => {
    expect(classifyFirstTouchType('/login')).toBe('console')
    expect(classifyFirstTouchType('/login/')).toBe('console')
    expect(classifyFirstTouchType('/login-cli')).toBe('cli')
    expect(buildFirstTouchAttributionFromLocation('', '/login-cli')).toMatchObject({
      first_touch_type: 'cli',
      first_touch_path: '/login-cli',
    })
  })

  it('derives signup_source from utm and landing labels', () => {
    expect(deriveSignupSourceFromRecord(parseSignupAttributionRecord({ ref: 'plugin_x' }))).toBe('plugin_x')
    expect(deriveSignupSourceFromRecord(parseSignupAttributionRecord({ utm_source: 'linkedin' }))).toBe('linkedin')
    expect(deriveSignupSourceFromRecord(parseSignupAttributionRecord({
      first_touch_type: 'console',
      first_touch_path: '/login',
    }))).toBe('console')
    expect(deriveSignupSourceFromRecord(parseSignupAttributionRecord({
      first_touch_type: 'docs',
      first_touch_path: '/docs/getting-started/',
    }))).toBe('docs:getting-started')
  })

  it('serializes cookies with website-compatible ref keys', () => {
    const serialized = serializeCapgoAttributionCookie(parseSignupAttributionRecord({
      ref: 'plugin_updater',
      utm_source: 'docs',
      first_touch_type: 'plugin',
      first_touch_path: '/plugins/capacitor-updater/',
    }))
    expect(JSON.parse(serialized)).toEqual({
      ref: 'plugin_updater',
      utm_source: 'docs',
      first_touch_type: 'plugin',
      first_touch_path: '/plugins/capacitor-updater/',
      signup_source: 'plugin_updater',
    })
  })

  it('serializes utm_content and utm_term in capgo attribution cookies', () => {
    const serialized = serializeCapgoAttributionCookie(parseSignupAttributionRecord({
      ref: 'plugin_updater',
      utm_content: 'hero-cta',
      utm_term: 'capacitor',
    }))
    expect(JSON.parse(serialized)).toEqual({
      ref: 'plugin_updater',
      utm_content: 'hero-cta',
      utm_term: 'capacitor',
      signup_source: 'plugin_updater',
    })
  })

  it('does not treat pathname first touch as URL referral over cookie ref', () => {
    const merged = mergeUrlPrecedenceSignupAttribution(
      {},
      mergeSignupAttribution(
        parseFirstTouchFromPathname('/login'),
        parseSignupAttributionRecord({ ref: 'plugin_old', signup_source: 'plugin_old' }),
      ),
    )

    expect(merged.signup_ref).toBe('plugin_old')
    expect(merged.signup_source).toBe('plugin_old')
    expect(merged.first_touch_type).toBe('console')
    expect(merged.first_touch_path).toBe('/login')
  })

  it('keeps ref and signup_source on the same source when URL precedes cookie', () => {
    const merged = mergeUrlPrecedenceSignupAttribution(
      parseSignupAttributionRecord({ utm_source: 'newsletter' }),
      parseSignupAttributionRecord({
        ref: 'plugin_stale',
        signup_source: 'plugin_stale',
      }),
    )

    expect(merged.signup_ref).toBeUndefined()
    expect(merged.signup_source).toBe('newsletter')
    expect(merged.first_utm_source).toBe('newsletter')
  })

  it('builds PostHog set_once and event tag payloads without PII fields', () => {
    const attribution = parseSignupAttributionRecord({
      ref: 'plugin_updater',
      utm_source: 'docs',
      utm_content: 'security-a',
      utm_campaign: 'direct-sales',
      oppref: 'opaque-click-reference',
      signup_source: 'docs:intro',
      first_touch_type: 'docs',
      first_touch_path: '/docs/intro/',
      email: 'must-not-leak@example.com',
    })

    expect(signupAttributionToPostHogSetOnce(attribution)).toEqual({
      signup_ref: 'plugin_updater',
      signup_plugin: 'updater',
      signup_source: 'docs:intro',
      first_touch_type: 'docs',
      first_touch_path: '/docs/intro/',
      first_utm_source: 'docs',
      first_utm_content: 'security-a',
      first_utm_campaign: 'direct-sales',
    })
    expect(signupAttributionEventTags(attribution)).toEqual({
      signup_plugin: 'updater',
      signup_source: 'docs:intro',
      first_touch_type: 'docs',
      first_utm_source: 'docs',
      first_utm_content: 'security-a',
      first_utm_campaign: 'direct-sales',
    })
  })
})
