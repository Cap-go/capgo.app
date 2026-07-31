import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatCreditPricingPrice, formatCreditPricingTierLabel, formatIncludedThenPrice, getFirstTierCreditUnitPricing } from '../src/services/creditPricing'
import { useMainStore } from '../src/stores/main'

const messages: Record<string, string> = {
  'credits-plan-overage': '{included}, then {price}',
  'minutes-short': '{minutes}m',
  'credits-pricing-price': '{price} {unit}',
  'credits-pricing-tier-first': 'Up to {to}',
  'credits-pricing-tier-range': 'From {from} to {to}',
  'credits-pricing-tier-over': 'Over {from}',
  'credits-pricing-unit-per-gib': 'per GiB',
  'credits-pricing-unit-per-mau': 'per MAU',
  'credits-pricing-unit-per-minute': 'per minute',
  'included-in-plan': 'Included in plan',
}

function t(key: string, values: Record<string, string | number> = {}) {
  const template = messages[key] ?? key
  return template.replaceAll(/\{(\w+)\}/g, (_match, placeholder) => String(values[placeholder] ?? `{${placeholder}}`))
}

function setAccountFormatLocale(formatLocale: string) {
  setActivePinia(createPinia())
  const main = useMainStore()
  main.user = { format_locale: formatLocale } as typeof main.user
}

function formatUsd(locale: string, value: number) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}

describe('credit pricing UI helpers', () => {
  beforeEach(() => {
    setAccountFormatLocale('en-GB')
  })

  it('formats first build_time tiers with generic translated labels', () => {
    expect(formatCreditPricingTierLabel({
      type: 'build_time',
      step_min: 0,
      step_max: 6000,
      unit_factor: 60,
    }, t)).toBe('Up to 100m')

    expect(formatCreditPricingPrice('build_time', 0.08, t)).toBe(`${formatUsd('en-GB', 0.08)} per minute`)
  })

  it('formats prices from the selected account convention', () => {
    setAccountFormatLocale('fr-FR')

    expect(formatCreditPricingPrice('build_time', 0.08, t)).toBe(`${formatUsd('fr-FR', 0.08)} per minute`)
  })

  it('falls back to generic tier copy for custom org-scoped ranges', () => {
    expect(formatCreditPricingTierLabel({
      type: 'build_time',
      step_min: 3000,
      step_max: 9000,
      unit_factor: 60,
    }, t)).toBe('From 50m to 150m')

    expect(formatCreditPricingTierLabel({
      type: 'build_time',
      step_min: 9000,
      step_max: Number.MAX_SAFE_INTEGER,
      unit_factor: 60,
    }, t)).toBe('Over 150m')
  })

  it('formats bounded custom ranges with both dynamic endpoints', () => {
    expect(formatCreditPricingTierLabel({
      type: 'build_time',
      step_min: 5000,
      step_max: 6000,
      unit_factor: 60,
    }, t)).toBe('From 84m to 100m')
  })

  it('derives the visible first-tier pricing from the shared step list', () => {
    expect(getFirstTierCreditUnitPricing([
      {
        type: 'build_time',
        step_min: 6000,
        step_max: 30000,
        price_per_unit: 0.07,
        unit_factor: 60,
      },
      {
        type: 'bandwidth',
        step_min: 0,
        step_max: 1099511627776,
        price_per_unit: 0.06,
        unit_factor: 1073741824,
      },
      {
        type: 'build_time',
        step_min: 0,
        step_max: 6000,
        price_per_unit: 0.08,
        unit_factor: 60,
      },
    ])).toEqual({
      bandwidth: 0.06,
      build_time: 0.08,
    })
  })

  it('formats plan overage copy from the shared price formatter', () => {
    expect(formatIncludedThenPrice('build_time', 0.04, t)).toBe(`Included in plan, then ${formatUsd('en-GB', 0.04)} per minute`)
  })
})
