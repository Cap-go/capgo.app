import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  checkWranglerCompatibilityDates,
  compatibilityDatesFromToml,
  compatibilityDatesFromWranglerFile,
  isCompatibilityDateAfter,
  todayUtcIsoDate,
} from '../scripts/check-wrangler-compat-date.ts'

describe('check-wrangler-compat-date', () => {
  it('treats dates after max as future', () => {
    expect(isCompatibilityDateAfter('2026-11-17', '2026-11-10')).toBe(true)
    expect(isCompatibilityDateAfter('2026-11-10', '2026-11-10')).toBe(false)
    expect(isCompatibilityDateAfter('2026-04-21', '2026-11-10')).toBe(false)
  })

  it('parses wrangler.json', () => {
    const dates = compatibilityDatesFromWranglerFile('wrangler.json', '{"compatibility_date":"2026-11-10"}')
    expect(dates).toEqual(['2026-11-10'])
  })

  it('parses wrangler.jsonc with line and block comments', () => {
    const text = readFileSync(new URL('../cloudflare_workers/plugin/wrangler.jsonc', import.meta.url), 'utf8')
    const dates = compatibilityDatesFromWranglerFile('wrangler.jsonc', text)
    expect(dates.length).toBeGreaterThan(0)
    expect(dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true)

    const fixture = `{
  // future deploy window
  "compatibility_date": "2026-12-01",
  "name": "probe"
}`
    expect(compatibilityDatesFromWranglerFile('wrangler.jsonc', fixture)).toEqual(['2026-12-01'])
  })

  it('parses wrangler.toml compatibility_date', () => {
    const text = `
name = "example"
compatibility_date = "2026-11-09"
`
    expect(compatibilityDatesFromToml(text)).toEqual(['2026-11-09'])
    expect(compatibilityDatesFromWranglerFile('wrangler.toml', text)).toEqual(['2026-11-09'])
  })

  it('flags future dates and allows today and past in a temp tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrangler-compat-check-'))
    try {
      mkdirSync(join(root, 'nested'), { recursive: true })
      writeFileSync(join(root, 'wrangler.json'), '{"compatibility_date":"2020-01-01"}')
      writeFileSync(join(root, 'nested', 'wrangler.jsonc'), '{ "compatibility_date": "2026-11-10" }')
      writeFileSync(join(root, 'nested', 'wrangler.toml'), 'compatibility_date = "2099-01-01"\n')
      const max = '2026-11-10'
      const violations = checkWranglerCompatibilityDates(root, max)
      expect(violations).toEqual([{
        file: join(root, 'nested', 'wrangler.toml'),
        date: '2099-01-01',
      }])
      expect(checkWranglerCompatibilityDates(root, '2099-12-31')).toEqual([])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses UTC calendar day for today', () => {
    const noonUtc = new Date('2026-11-10T12:00:00.000Z')
    expect(todayUtcIsoDate(noonUtc)).toBe('2026-11-10')
  })
})
