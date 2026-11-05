import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { isActionableStripeCustomerId } from '../scripts/admin_stripe_backfill_utils.ts'
import {
  buildAppleLookupUrl,
  buildGooglePlayStoreUrl,
  getMissingStoreUrlPlatforms,
  isMissingStoreUrl,
  normalizeAppleStoreUrl,
  parseAppleCountries,
  parsePlatformFilter,
  pickAppleLookupStoreUrl,
} from '../scripts/backfill_missing_store_urls.ts'
import { getCustomerProfileCountry, normalizeStripeCountryCode, shouldUpdateCustomerCountry } from '../scripts/backfill_stripe_customer_countries.ts'

describe('admin store URL backfill script helpers', () => {
  it.concurrent('builds canonical Google Play and Apple lookup URLs', () => {
    expect(buildGooglePlayStoreUrl('com.example.app')).toBe('https://play.google.com/store/apps/details?id=com.example.app')
    expect(buildAppleLookupUrl('com.example.app', null)).toBe('https://itunes.apple.com/lookup?bundleId=com.example.app')
    expect(buildAppleLookupUrl('com.example.app', 'fr')).toBe('https://itunes.apple.com/lookup?bundleId=com.example.app&country=fr')
  })

  it.concurrent('detects missing store URLs', () => {
    expect(isMissingStoreUrl(null)).toBe(true)
    expect(isMissingStoreUrl('')).toBe(true)
    expect(isMissingStoreUrl('   ')).toBe(true)
    expect(isMissingStoreUrl('https://apps.apple.com/us/app/example/id123')).toBe(false)
  })

  it.concurrent('filters missing platforms by selected store', () => {
    const app = {
      android_store_url: null,
      ios_store_url: '',
    }

    expect(getMissingStoreUrlPlatforms(app, 'both')).toEqual(['android', 'ios'])
    expect(getMissingStoreUrlPlatforms(app, 'android')).toEqual(['android'])
    expect(getMissingStoreUrlPlatforms(app, 'ios')).toEqual(['ios'])
  })

  it.concurrent('parses platform and Apple storefront options', () => {
    expect(parsePlatformFilter(null)).toBe('both')
    expect(parsePlatformFilter('IOS')).toBe('ios')
    expect(parseAppleCountries(null)).toEqual([null])
    expect(parseAppleCountries('us, fr,US')).toEqual(['us', 'fr'])
    expect(parseAppleCountries('all')[0]).toBeNull()
    expect(() => parsePlatformFilter('windows')).toThrow('--platform')
    expect(() => parseAppleCountries('usa')).toThrow('--apple-countries')
  })

  it.concurrent('normalizes and selects Apple lookup App Store URLs by bundle id', () => {
    expect(normalizeAppleStoreUrl('https://apps.apple.com/us/app/example/id123?mt=8')).toBe('https://apps.apple.com/us/app/example/id123?mt=8')
    expect(normalizeAppleStoreUrl('https://itunes.apple.com/us/app/example/id123')).toBeNull()

    expect(pickAppleLookupStoreUrl([
      { bundleId: 'com.other.app', trackViewUrl: 'https://apps.apple.com/us/app/other/id111' },
      { bundleId: 'com.example.app', trackViewUrl: 'https://apps.apple.com/us/app/example/id123?mt=8' },
    ], 'com.example.app')).toBe('https://apps.apple.com/us/app/example/id123?mt=8')
  })
})

describe('stripe backfill scripts', () => {
  it.concurrent('normalizes Stripe country codes', () => {
    expect(normalizeStripeCountryCode(' us ')).toBe('US')
    expect(normalizeStripeCountryCode('USA')).toBeNull()
    expect(normalizeStripeCountryCode('')).toBeNull()
  })

  it.concurrent('reads customer profile country from Stripe customers', () => {
    expect(getCustomerProfileCountry({
      deleted: false,
      address: { country: 'fr' },
    } as unknown as Stripe.Customer)).toBe('FR')

    expect(getCustomerProfileCountry({
      deleted: true,
      id: 'cus_deleted',
      object: 'customer',
    } as Stripe.DeletedCustomer)).toBeNull()
  })

  it.concurrent('decides when customer country rows need updates', () => {
    expect(shouldUpdateCustomerCountry(null, 'US', false)).toBe(true)
    expect(shouldUpdateCustomerCountry('US', 'FR', false)).toBe(false)
    expect(shouldUpdateCustomerCountry('US', 'FR', true)).toBe(true)
    expect(shouldUpdateCustomerCountry(' us ', 'US', true)).toBe(false)
  })

  it.concurrent('skips pending Stripe customer placeholders', () => {
    expect(isActionableStripeCustomerId('cus_123')).toBe(true)
    expect(isActionableStripeCustomerId('pending_org_id')).toBe(false)
    expect(isActionableStripeCustomerId('')).toBe(false)
  })
})
